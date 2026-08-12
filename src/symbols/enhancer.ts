import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildModuleBaseMap, MachineDump, modulesWithResolvedFrames } from '../analysis/machine-format';
import { demangleMsvcNames, isMsvcMangled } from './msvc-demangle';

// Shared output channel for extension logging
let _outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) {
        _outputChannel = vscode.window.createOutputChannel('DumpStorm');
    }
    return _outputChannel;
}
function log(message: string): void {
    getOutputChannel().appendLine(message);
}

// Sorted symbol entry for efficient binary search
interface SortedSymbolEntry {
    address: number;
    name: string;
    /**
     * Symbol size in bytes when known (extracted via `nm -S` or Breakpad FUNC records).
     * When defined, callers should treat `offset >= size` as "address falls outside
     * this symbol's body" and reject the match instead of returning a wildly off-by-N
     * function name.
     */
    size?: number;
}

/**
 * Symbol type characters that represent executable code (text segment).
 * We deliberately reject data (`D/d/B/b/R/r`), undefined (`U/u`), absolute
 * (`A/a`), and debug (`N`) symbols because mapping a code address to a data
 * symbol is always wrong (the symbol just happens to live at the next lower
 * address). Weak symbols (`W/w`) and weak object code (`V/v`) are accepted
 * since they can legitimately back a function call site.
 */
const CODE_SYMBOL_TYPES = new Set(['T', 't', 'W', 'w', 'V', 'v']);

/**
 * Parse a single nm output line into a symbol entry.
 * Supported shapes (with or without leading `0x`):
 *   <addr> <type> <name>            (nm without -S)
 *   <addr> <size> <type> <name>     (nm -S, when size is known)
 *
 * Returns null when the line is a header, blank, or refers to a non-code symbol.
 */
function parseNmSymbolLine(line: string): SortedSymbolEntry | null {
    if (!line || line.startsWith('===') || line.startsWith('Generated:') ||
        line.startsWith('nm command output:') || line.trim() === '') {
        return null;
    }

    // Try the size-bearing form first (nm -S): addr [size] type name
    let m = line.match(/^(?:0x)?([0-9a-fA-F]+)\s+(?:0x)?([0-9a-fA-F]+)\s+([a-zA-Z?])\s+(.+)$/);
    if (m) {
        const [, addressStr, sizeStr, type, symbolName] = m;
        if (!CODE_SYMBOL_TYPES.has(type)) {
            return null;
        }
        const address = parseInt(addressStr, 16);
        const size = parseInt(sizeStr, 16);
        if (Number.isNaN(address)) {
            return null;
        }
        return {
            address,
            name: symbolName.trim(),
            size: Number.isNaN(size) || size === 0 ? undefined : size,
        };
    }

    // Fall back to the size-less form: addr type name
    m = line.match(/^(?:0x)?([0-9a-fA-F]+)\s+([a-zA-Z?])\s+(.+)$/);
    if (m) {
        const [, addressStr, type, symbolName] = m;
        if (!CODE_SYMBOL_TYPES.has(type)) {
            return null;
        }
        const address = parseInt(addressStr, 16);
        if (Number.isNaN(address)) {
            return null;
        }
        return { address, name: symbolName.trim() };
    }

    return null;
}

// Symbol table cache with LRU eviction and pre-sorted arrays
class SymbolTableCache {
    private cache = new Map<string, { table: Map<number, string>; sorted: SortedSymbolEntry[] }>();
    private accessOrder: string[] = []; // tracks LRU order
    private maxCacheSize = 50;
    
    async get(filePath: string): Promise<Map<number, string> | null> {
        if (this.cache.has(filePath)) {
            // Move to end of access order (most recently used)
            this.accessOrder = this.accessOrder.filter(k => k !== filePath);
            this.accessOrder.push(filePath);
            return this.cache.get(filePath)!.table;
        }

        const loaded = await this.loadSymbolTableWithSize(filePath);
        if (loaded) {
            // Evict LRU entry if at capacity
            if (this.cache.size >= this.maxCacheSize && this.accessOrder.length > 0) {
                const lruKey = this.accessOrder.shift()!;
                this.cache.delete(lruKey);
            }
            this.cache.set(filePath, loaded);
            this.accessOrder.push(filePath);
            return loaded.table;
        }
        return null;
    }

    getSorted(filePath: string): SortedSymbolEntry[] | null {
        const entry = this.cache.get(filePath);
        return entry ? entry.sorted : null;
    }
    
    private async loadSymbolTable(nmFilePath: string): Promise<Map<number, string> | null> {
        try {
            const content = await fs.promises.readFile(nmFilePath, 'utf8');
            return this.parseSymbolTable(content);
        } catch (error) {
            log(`Error loading symbol table from ${nmFilePath}: ${error}`);
            return null;
        }
    }

    /**
     * Read the nm output once and produce both the legacy Map and a sorted
     * array carrying optional size information. Sharing the parse pass keeps
     * the table and sorted view in lock-step.
     */
    private async loadSymbolTableWithSize(nmFilePath: string): Promise<{ table: Map<number, string>; sorted: SortedSymbolEntry[] } | null> {
        try {
            const content = await fs.promises.readFile(nmFilePath, 'utf8');
            const sorted = this.parseSortedSymbols(content);

            // MSVC mangled names ('?...') survive `nm -C` untouched. Run a
            // best-effort batch demangle through llvm-undname so stack frames
            // show readable C++ identifiers instead of opaque mangling.
            const mangled = sorted.filter(e => isMsvcMangled(e.name)).map(e => e.name);
            if (mangled.length > 0) {
                const demangled = await demangleMsvcNames(mangled);
                if (demangled.size > 0) {
                    for (const entry of sorted) {
                        const replacement = demangled.get(entry.name);
                        if (replacement) {
                            entry.name = replacement;
                        }
                    }
                }
            }

            const table = new Map<number, string>();
            for (const entry of sorted) {
                table.set(entry.address, entry.name);
            }
            return { table, sorted };
        } catch (error) {
            log(`Error loading symbol table from ${nmFilePath}: ${error}`);
            return null;
        }
    }
    
    private parseSymbolTable(content: string): Map<number, string> {
        const symbolTable = new Map<number, string>();
        const lines = content.split('\n');

        for (const line of lines) {
            const entry = parseNmSymbolLine(line);
            if (entry) {
                symbolTable.set(entry.address, entry.name);
            }
        }

        return symbolTable;
    }

    /**
     * Like {@link parseSymbolTable} but also retains size information for
     * boundary-aware lookups. Returns a sorted array suitable for binary search.
     */
    private parseSortedSymbols(content: string): SortedSymbolEntry[] {
        const entries: SortedSymbolEntry[] = [];
        const lines = content.split('\n');

        for (const line of lines) {
            const entry = parseNmSymbolLine(line);
            if (entry) {
                entries.push(entry);
            }
        }

        entries.sort((a, b) => a.address - b.address);
        return entries;
    }
    
    clear(): void {
        this.cache.clear();
        this.accessOrder = [];
    }
    
    getSize(): number {
        return this.cache.size;
    }
}

// Global cache instance
const symbolTableCache = new SymbolTableCache();

// Helper function to get library base name without extension
function getLibraryBaseName(libName: string): string {
    // Handle different dynamic library extensions across platforms
    // Also handles versioned .so files like libfoo.so.1.2.3
    let baseName = libName;
    
    const soMatch = libName.match(/^(.+)\.so(\.\d+)*$/);
    if (soMatch) {
        baseName = soMatch[1];
    } else if (libName.endsWith('.dylib')) {
        baseName = libName.slice(0, -'.dylib'.length);
    } else if (libName.endsWith('.dll')) {
        baseName = libName.slice(0, -'.dll'.length);
    }
    
    return path.basename(baseName);
}

function findSymbolTable<T>(tables: Map<string, T>, libName: string): T | undefined {
    const baseName = getLibraryBaseName(libName);
    const direct = tables.get(baseName) || tables.get(libName);
    if (direct) {
        return direct;
    }

    // Batch extraction appends a stable source-path hash to avoid collisions
    // between same-named binaries. Treat that suffix as metadata for lookup.
    const normalizedBase = baseName.toLowerCase();
    for (const [tableName, table] of tables) {
        const withoutCollisionSuffix = tableName.replace(/_[0-9a-f]{12}$/i, '');
        if (getLibraryBaseName(withoutCollisionSuffix).toLowerCase() === normalizedBase) {
            return table;
        }
    }
    return undefined;
}

export function parseModuleBaseAddresses(stackTraceOutput: string): Map<string, number> {
    const moduleBaseAddresses = new Map<string, number>();
    const lines = stackTraceOutput.split('\n');
    let inLoadedModulesSection = false;
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Check if we're entering the "Loaded modules" section
        if (trimmedLine.startsWith('Loaded modules:')) {
            inLoadedModulesSection = true;
            continue;
        }
        
        // Exit if we hit another major section after loaded modules
        if (inLoadedModulesSection && (trimmedLine.startsWith('Thread') || trimmedLine.startsWith('Crash'))) {
            break;
        }
        
        // Skip empty lines within loaded modules section
        if (inLoadedModulesSection && trimmedLine === '') {
            continue;
        }
        
        // Parse module lines in the format: 
        // 0x616c306000 - 0x616c307fff  app_process64  ???  (WARNING: No symbols, app_process64, ...)
        if (inLoadedModulesSection) {
            const moduleMatch = line.match(/^0x([0-9a-fA-F]+)\s+-\s+0x[0-9a-fA-F]+\s+([^\s]+)/);
            if (moduleMatch) {
                const [, baseAddressStr, moduleName] = moduleMatch;
                const baseAddress = parseInt(baseAddressStr, 16);
                
                // Store both the full module name and base name for lookup
                moduleBaseAddresses.set(moduleName, baseAddress);
                const baseName = getLibraryBaseName(moduleName);
                if (baseName !== moduleName) {
                    moduleBaseAddresses.set(baseName, baseAddress);
                }
                
                log(`Parsed module base address: ${moduleName} -> 0x${baseAddress.toString(16)}`);
            }
        }
    }
    
    return moduleBaseAddresses;
}

export async function enhanceStackTraceWithSymbols(
    stackTraceOutput: string,
    symbolPath: string,
    machineDump?: MachineDump,
): Promise<string> {
    if (!fs.existsSync(symbolPath)) {
        return stackTraceOutput; // Return original if no symbol path
    }

    // Look for nm symbol files in the symbol path
    const nmFiles = fs.readdirSync(symbolPath).filter(file => file.endsWith('_nm.txt'));
    if (nmFiles.length === 0) {
        return stackTraceOutput; // No nm files found
    }

    log(`Found ${nmFiles.length} nm symbol files for enhancement`);

    // Prefer the authoritative module base map from the -m machine output;
    // fall back to scraping the human-readable "Loaded modules:" section only
    // when the machine dump is unavailable.
    const moduleBaseAddresses = machineDump
        ? buildModuleBaseMap(machineDump.modules)
        : parseModuleBaseAddresses(stackTraceOutput);
    log(`Module base addresses: ${moduleBaseAddresses.size} (source: ${machineDump ? 'machine -m' : 'text scrape'})`);

    // Modules that already have a function name resolved by stackwalk (i.e.
    // a Breakpad .sym was matched) should not get a second nm-based hint
    // appended; doing so risks contradicting the more accurate result.
    const alreadyResolved = machineDump ? modulesWithResolvedFrames(machineDump.frames) : new Set<string>();
    
    // Load all symbol tables using cache
    const symbolTables = new Map<string, Map<number, string>>();
    const sortedTables = new Map<string, SortedSymbolEntry[]>();
    
    for (const nmFile of nmFiles) {
        const libName = nmFile.replace('_nm.txt', '');
        const nmFilePath = path.join(symbolPath, nmFile);
        const symbolTable = await symbolTableCache.get(nmFilePath);
        if (symbolTable) {
            symbolTables.set(libName, symbolTable);
            const sorted = symbolTableCache.getSorted(nmFilePath);
            if (sorted) {
                sortedTables.set(libName, sorted);
            }
            log(`Loaded ${symbolTable.size} symbols for ${libName}`);
        }
    }
    
    // Process the stack trace line by line
    const lines = stackTraceOutput.split('\n');
    const enhancedLines: string[] = [];
    
    for (const line of lines) {
        let enhancedLine = line;
        
        // Look for offset patterns like "libOpenssl.so + 0x149840" or "dyld + 0x33601" (already relative addresses)
        // Support libraries with or without extensions (.so, .dylib, .dll, or extensionless like dyld, app_process64)
        const offsetMatch = line.match(/([^\s]+(?:\.(?:so(?:\.\d+)*|dylib|dll))?)\s*\+\s*0x([0-9a-fA-F]+)/i);
        if (offsetMatch) {
            const [, libName, offsetStr] = offsetMatch;
            const offset = parseInt(offsetStr, 16);

            // Try to find the library in our symbol tables
            const baseLibName = getLibraryBaseName(libName);

            // Skip nm enhancement when stackwalk has already produced a function
            // name from a matching .sym for this module — adding a (possibly
            // stale) nm hint on top would only confuse the reader.
            if (alreadyResolved.has(libName.toLowerCase()) || alreadyResolved.has(baseLibName.toLowerCase())) {
                enhancedLines.push(enhancedLine);
                continue;
            }

            const symbolTable = findSymbolTable(symbolTables, libName);
            
            if (symbolTable) {
                log(`Looking up ${libName}+0x${offsetStr} (offset=${offset}) in symbol table with ${symbolTable.size} symbols`);
                
                // For offset notation, the address is already relative to the module base
                // So we search directly with the offset value (no base address subtraction needed)
                const sorted = findSymbolTable(sortedTables, libName);
                const symbolName = findNearestSymbolSorted(sorted || null, offset, undefined, true);
                if (symbolName) {
                    enhancedLine += `  <-- ${symbolName}`;
                    log(`Enhanced ${libName}+0x${offsetStr} -> ${symbolName} (offset mode)`);
                } else {
                    log(`No symbol found for ${libName}+0x${offsetStr} (offset=0x${offset.toString(16)})`);
                }
            } else {
                log(`No symbol table found for ${libName} (base name: ${baseLibName})`);
                log(`Available symbol tables: ${Array.from(symbolTables.keys()).join(', ')}`);
            }
        }
        // Look for stack frame patterns with absolute addresses
        else {
            const stackFrameMatch = line.match(/(\d+)\s+([^\s+]+(?:\.(?:so(?:\.\d+)*|dylib|dll))?)\s*\+?\s*0x([0-9a-fA-F]+)/i);
            if (stackFrameMatch) {
                const [, frameNum, libName, addressStr] = stackFrameMatch;
                const address = parseInt(addressStr, 16);
                
                // Try to find the library in our symbol tables
                const baseLibName = getLibraryBaseName(libName);
                const symbolTable = findSymbolTable(symbolTables, libName);
                
                if (symbolTable) {
                    // Get the base address for this module
                    const baseAddress = moduleBaseAddresses.get(baseLibName) || moduleBaseAddresses.get(libName);
                    const sorted = findSymbolTable(sortedTables, libName);
                    const symbolName = findNearestSymbolSorted(sorted || null, address, baseAddress, false);
                    if (symbolName) {
                        enhancedLine += `  <-- ${symbolName}`;
                        log(`Enhanced ${libName}+0x${addressStr} -> ${symbolName} (absolute mode, base: 0x${baseAddress?.toString(16)})`);
                    }
                }
            }
            
            // Also look for direct address patterns (support .so, .dylib, .dll and extensionless libraries like dyld)
            const directAddressMatch = line.match(/([^\s]+(?:\.(?:so(?:\.\d+)*|dylib|dll))?)!0x([0-9a-fA-F]+)/i);
            if (directAddressMatch && !stackFrameMatch) {
                const [, libName, addressStr] = directAddressMatch;
                const address = parseInt(addressStr, 16);
                
                const baseLibName = getLibraryBaseName(libName);
                const symbolTable = findSymbolTable(symbolTables, libName);
                
                if (symbolTable) {
                    const baseAddress = moduleBaseAddresses.get(baseLibName) || moduleBaseAddresses.get(libName);
                    const sorted = findSymbolTable(sortedTables, libName);
                    const symbolName = findNearestSymbolSorted(sorted || null, address, baseAddress, false);
                    if (symbolName) {
                        enhancedLine += `  <-- ${symbolName}`;
                        log(`Enhanced ${libName}!0x${addressStr} -> ${symbolName} (direct mode)`);
                    }
                }
            }
        }
        
        enhancedLines.push(enhancedLine);
    }
    
    // Add enhancement info at the top
    const headerInfo = `=== ENHANCED STACK TRACE ===\n`;
    const symbolInfo = `Symbol enhancement: Used ${symbolTables.size} symbol table(s)\n`;
    const separator = `${'='.repeat(50)}\n\n`;
    
    return headerInfo + symbolInfo + separator + enhancedLines.join('\n');
}

// Clear the symbol table cache (useful for testing or memory management)
export function clearSymbolCache(): void {
    symbolTableCache.clear();
}

// Get cache statistics (useful for debugging)
export function getCacheStats(): { size: number; maxSize: number } {
    return {
        size: symbolTableCache.getSize(),
        maxSize: 50 // Should match the maxCacheSize in SymbolTableCache
    };
}

export function loadSymbolTable(nmFilePath: string): Map<number, string> {
    const symbolTable = new Map<number, string>();

    try {
        const content = fs.readFileSync(nmFilePath, 'utf8');
        const lines = content.split('\n');

        for (const line of lines) {
            const entry = parseNmSymbolLine(line);
            if (entry) {
                symbolTable.set(entry.address, entry.name);
            }
        }
    } catch (error) {
        log(`Error loading symbol table from ${nmFilePath}: ${error}`);
    }

    return symbolTable;
}

// Internal implementation using pre-sorted array (used by enhanceStackTraceWithSymbols)
function findNearestSymbolSorted(sortedAddresses: SortedSymbolEntry[] | null, targetAddress: number, baseAddress?: number, isOffset: boolean = false): string | null {
    if (!sortedAddresses || sortedAddresses.length === 0) {
        return null;
    }
    
    let searchAddress = targetAddress;
    
    if (isOffset) {
        searchAddress = targetAddress;
    } else if (baseAddress !== undefined) {
        searchAddress = targetAddress - baseAddress;
    }
    
    // Binary search for the largest address <= searchAddress
    let left = 0;
    let right = sortedAddresses.length - 1;
    let nearestIndex = -1;
    
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (sortedAddresses[mid].address <= searchAddress) {
            nearestIndex = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    
    if (nearestIndex === -1) {
        return null;
    }
    
    const nearest = sortedAddresses[nearestIndex];
    const offset = searchAddress - nearest.address;

    // Hard boundary when the symbol size is known: an offset beyond the
    // symbol body cannot belong to that symbol. Returning null lets the
    // caller report the raw module+offset rather than a misleading function
    // name from the previous symbol in memory.
    if (nearest.size !== undefined && offset >= nearest.size) {
        return null;
    }

    // Don't show symbols that are too far away (likely wrong match) when we
    // have no size information to make a hard call.
    if (nearest.size === undefined && offset > 0x10000) { // 64KB threshold
        if (offset <= 0x50000) { // 320KB relaxed threshold
            return `${nearest.name}+0x${offset.toString(16)} [far]`;
        }
        return null;
    }

    if (offset === 0) {
        return nearest.name;
    } else {
        return `${nearest.name}+0x${offset.toString(16)}`;
    }
}

export function findNearestSymbol(symbolTable: Map<number, string>, targetAddress: number, baseAddress?: number, isOffset: boolean = false): string | null {
    // Build sorted array on-the-fly for backward compatibility
    const sortedAddresses = Array.from(symbolTable.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([address, name]) => ({ address, name }));
    
    return findNearestSymbolSorted(sortedAddresses, targetAddress, baseAddress, isOffset);
}

// Export test helpers for unit testing
export const testHelpers = {
    getLibraryBaseName,
    parseModuleBaseAddresses,
    findNearestSymbol,
    loadSymbolTable,
    SymbolTableCache // Export the class for testing
};