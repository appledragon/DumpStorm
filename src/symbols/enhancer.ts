import * as fs from 'fs';
import * as path from 'path';

// Symbol table cache for performance optimization
class SymbolTableCache {
    private cache = new Map<string, Map<number, string>>();
    private maxCacheSize = 50;
    
    async get(filePath: string): Promise<Map<number, string> | null> {
        if (this.cache.has(filePath)) {
            return this.cache.get(filePath)!;
        }
        
        const symbolTable = await this.loadSymbolTable(filePath);
        if (symbolTable) {
            // Add to cache with size limit
            if (this.cache.size >= this.maxCacheSize) {
                const firstKey = this.cache.keys().next().value;
                if (firstKey) {
                    this.cache.delete(firstKey);
                }
            }
            this.cache.set(filePath, symbolTable);
        }
        return symbolTable;
    }
    
    private async loadSymbolTable(nmFilePath: string): Promise<Map<number, string> | null> {
        try {
            const content = await fs.promises.readFile(nmFilePath, 'utf8');
            return this.parseSymbolTable(content);
        } catch (error) {
            console.error(`Error loading symbol table from ${nmFilePath}:`, error);
            return null;
        }
    }
    
    private parseSymbolTable(content: string): Map<number, string> {
        const symbolTable = new Map<number, string>();
        const lines = content.split('\n');
        
        for (const line of lines) {
            if (line.startsWith('===') || line.startsWith('Generated:') || 
                line.startsWith('nm command output:') || line.trim() === '') {
                continue;
            }
            
            const match = line.match(/^(0x)?([0-9a-fA-F]+)\s+([a-zA-Z])\s+(.+)$/);
            if (match) {
                const [, , addressStr, , symbolName] = match;
                const address = parseInt(addressStr, 16);
                symbolTable.set(address, symbolName);
            }
        }
        
        return symbolTable;
    }
    
    clear(): void {
        this.cache.clear();
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
    const extensions = ['.so', '.dylib', '.dll'];
    let baseName = libName;
    
    for (const ext of extensions) {
        if (libName.endsWith(ext)) {
            baseName = libName.slice(0, -ext.length);
            break;
        }
    }
    
    return path.basename(baseName);
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
        
        // Exit if we hit another section or empty line after loaded modules
        if (inLoadedModulesSection && (trimmedLine === '' || trimmedLine.startsWith('Thread'))) {
            break;
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
                
                console.log(`Parsed module base address: ${moduleName} -> 0x${baseAddress.toString(16)}`);
            }
        }
    }
    
    return moduleBaseAddresses;
}

export async function enhanceStackTraceWithSymbols(stackTraceOutput: string, symbolPath: string): Promise<string> {
    if (!fs.existsSync(symbolPath)) {
        return stackTraceOutput; // Return original if no symbol path
    }
    
    // Look for nm symbol files in the symbol path
    const nmFiles = fs.readdirSync(symbolPath).filter(file => file.endsWith('_nm.txt'));
    if (nmFiles.length === 0) {
        return stackTraceOutput; // No nm files found
    }
    
    console.log(`Found ${nmFiles.length} nm symbol files for enhancement`);
    
    // Parse module base addresses from the stack trace output
    const moduleBaseAddresses = parseModuleBaseAddresses(stackTraceOutput);
    console.log(`Parsed ${moduleBaseAddresses.size} module base addresses`);
    
    // Load all symbol tables using cache
    const symbolTables = new Map<string, Map<number, string>>();
    
    for (const nmFile of nmFiles) {
        const libName = nmFile.replace('_nm.txt', '');
        const nmFilePath = path.join(symbolPath, nmFile);
        const symbolTable = await symbolTableCache.get(nmFilePath);
        if (symbolTable) {
            symbolTables.set(libName, symbolTable);
            console.log(`Loaded ${symbolTable.size} symbols for ${libName}`);
        }
    }
    
    // Process the stack trace line by line
    const lines = stackTraceOutput.split('\n');
    const enhancedLines: string[] = [];
    
    for (const line of lines) {
        let enhancedLine = line;
        
        // Look for offset patterns like "libOpenssl.so + 0x149840" or "dyld + 0x33601" (already relative addresses)
        const offsetMatch = line.match(/([^\s]+(?:\.(?:so|dylib|dll))?)\s*\+\s*0x([0-9a-fA-F]+)/i);
        if (offsetMatch) {
            const [, libName, offsetStr] = offsetMatch;
            const offset = parseInt(offsetStr, 16);
            
            // Try to find the library in our symbol tables
            const baseLibName = getLibraryBaseName(libName);
            const symbolTable = symbolTables.get(baseLibName) || symbolTables.get(libName);
            
            if (symbolTable) {
                console.log(`Looking up ${libName}+0x${offsetStr} (offset=${offset}) in symbol table with ${symbolTable.size} symbols`);
                
                // For offset notation, the address is already relative to the module base
                // So we search directly with the offset value (no base address subtraction needed)
                const symbolName = findNearestSymbol(symbolTable, offset, undefined, true);
                if (symbolName) {
                    enhancedLine += `  <-- ${symbolName}`;
                    console.log(`Enhanced ${libName}+0x${offsetStr} -> ${symbolName} (offset mode)`);
                } else {
                    console.log(`No symbol found for ${libName}+0x${offsetStr} (offset=0x${offset.toString(16)})`);
                    
                    // Additional debugging: show nearby symbols
                    const sortedAddresses = Array.from(symbolTable.entries())
                        .sort((a, b) => a[0] - b[0]);
                    
                    const nearbySymbols = sortedAddresses.filter(([addr, _]) => 
                        Math.abs(addr - offset) <= 0x1000
                    );
                    
                    if (nearbySymbols.length > 0) {
                        console.log(`Nearby symbols within 0x1000 bytes:`);
                        nearbySymbols.forEach(([addr, sym]) => {
                            const distance = Math.abs(addr - offset);
                            console.log(`  0x${addr.toString(16)} (distance: 0x${distance.toString(16)}): ${sym}`);
                        });
                    } else {
                        console.log(`No symbols found within 0x1000 bytes of 0x${offset.toString(16)}`);
                        // Show the closest symbols on either side
                        let beforeSymbol = null;
                        let afterSymbol = null;
                        
                        for (let i = 0; i < sortedAddresses.length; i++) {
                            const [addr, sym] = sortedAddresses[i];
                            if (addr <= offset) {
                                beforeSymbol = { addr, sym, distance: offset - addr };
                            } else {
                                afterSymbol = { addr, sym, distance: addr - offset };
                                break;
                            }
                        }
                        
                        if (beforeSymbol) {
                            console.log(`  Closest symbol before: 0x${beforeSymbol.addr.toString(16)} (distance: 0x${beforeSymbol.distance.toString(16)}): ${beforeSymbol.sym}`);
                        }
                        if (afterSymbol) {
                            console.log(`  Closest symbol after: 0x${afterSymbol.addr.toString(16)} (distance: 0x${afterSymbol.distance.toString(16)}): ${afterSymbol.sym}`);
                        }
                    }
                }
            } else {
                console.log(`No symbol table found for ${libName} (base name: ${baseLibName})`);
                console.log(`Available symbol tables: ${Array.from(symbolTables.keys()).join(', ')}`);
            }
        }
        // Look for stack frame patterns with absolute addresses
        else {
            const stackFrameMatch = line.match(/(\d+)\s+([^\s]+(?:\.(?:so|dylib|dll))?)\s*\+?\s*0x([0-9a-fA-F]+)/i);
            if (stackFrameMatch) {
                const [, frameNum, libName, addressStr] = stackFrameMatch;
                const address = parseInt(addressStr, 16);
                
                // Try to find the library in our symbol tables
                const baseLibName = getLibraryBaseName(libName);
                const symbolTable = symbolTables.get(baseLibName) || symbolTables.get(libName);
                
                if (symbolTable) {
                    // Get the base address for this module
                    const baseAddress = moduleBaseAddresses.get(baseLibName) || moduleBaseAddresses.get(libName);
                    const symbolName = findNearestSymbol(symbolTable, address, baseAddress, false);
                    if (symbolName) {
                        enhancedLine += `  <-- ${symbolName}`;
                        console.log(`Enhanced ${libName}+0x${addressStr} -> ${symbolName} (absolute mode, base: 0x${baseAddress?.toString(16)})`);
                    }
                }
            }
            
            // Also look for direct address patterns (support .so, .dylib, .dll and extensionless libraries like dyld)
            const directAddressMatch = line.match(/([^\s]+(?:\.(?:so|dylib|dll))?)!0x([0-9a-fA-F]+)/i);
            if (directAddressMatch && !stackFrameMatch) {
                const [, libName, addressStr] = directAddressMatch;
                const address = parseInt(addressStr, 16);
                
                const baseLibName = getLibraryBaseName(libName);
                const symbolTable = symbolTables.get(baseLibName) || symbolTables.get(libName);
                
                if (symbolTable) {
                    const baseAddress = moduleBaseAddresses.get(baseLibName) || moduleBaseAddresses.get(libName);
                    const symbolName = findNearestSymbol(symbolTable, address, baseAddress, false);
                    if (symbolName) {
                        enhancedLine += `  <-- ${symbolName}`;
                        console.log(`Enhanced ${libName}!0x${addressStr} -> ${symbolName} (direct mode)`);
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
            // Skip header lines and empty lines
            if (line.startsWith('===') || line.startsWith('Generated:') || 
                line.startsWith('nm command output:') || line.trim() === '') {
                continue;
            }
            
            // Parse lines in nm format, supporting both with and without 0x prefix:
            // "0000000000001234 T function_name" (nm raw format)
            // "0x0000000000001234 T function_name" (prefixed format)
            const match = line.match(/^(0x)?([0-9a-fA-F]+)\s+([a-zA-Z])\s+(.+)$/);
            if (match) {
                const [, prefix, addressStr, symbolType, symbolName] = match;
                const address = parseInt(addressStr, 16);
                symbolTable.set(address, symbolName);
            }
        }
    } catch (error) {
        console.log(`Error loading symbol table from ${nmFilePath}: ${error}`);
    }
    
    return symbolTable;
}

export function findNearestSymbol(symbolTable: Map<number, string>, targetAddress: number, baseAddress?: number, isOffset: boolean = false): string | null {
    // Smart address resolution:
    // - If isOffset is true, the address is already a relative offset, use it directly
    // - If isOffset is false and we have a base address, subtract it from the target
    // - If no base address is available, try both absolute and relative matching
    
    let searchAddress = targetAddress;
    let debugInfo = '';
    
    if (isOffset) {
        // Address is already an offset, use directly
        searchAddress = targetAddress;
        debugInfo = `offset mode: 0x${targetAddress.toString(16)}`;
    } else if (baseAddress !== undefined) {
        // Calculate relative address within the module
        searchAddress = targetAddress - baseAddress;
        debugInfo = `absolute mode: runtime=0x${targetAddress.toString(16)}, base=0x${baseAddress.toString(16)}, relative=0x${searchAddress.toString(16)}`;
    } else {
        // No base address available, try direct matching first
        searchAddress = targetAddress;
        debugInfo = `direct mode: 0x${targetAddress.toString(16)} (no base address)`;
    }
    
    console.log(`Finding symbol: ${debugInfo}`);
    
    // For efficiency, convert the Map entries to a sorted array once
    const sortedAddresses = Array.from(symbolTable.entries())
        .sort((a, b) => a[0] - b[0]);
    
    if (sortedAddresses.length === 0) {
        return null;
    }
    
    // Binary search for the largest address <= searchAddress
    let left = 0;
    let right = sortedAddresses.length - 1;
    let nearestIndex = -1;
    
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const [address, ] = sortedAddresses[mid];
        
        if (address <= searchAddress) {
            nearestIndex = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    
    if (nearestIndex === -1) {
        // No symbol found at or before the target address
        return null;
    }
    
    const [nearestAddress, nearestSymbol] = sortedAddresses[nearestIndex];
    
    // Calculate offset from the nearest symbol
    const offset = searchAddress - nearestAddress;
    
    // Don't show symbols that are too far away (likely wrong match)
    if (offset > 0x10000) { // 64KB threshold
        console.log(`Symbol too far: offset=0x${offset.toString(16)} > 0x10000, rejecting`);
        
        // Try with a more relaxed threshold for debugging
        if (offset <= 0x50000) { // 320KB relaxed threshold
            console.log(`Using relaxed threshold: ${nearestSymbol}+0x${offset.toString(16)} (distance warning)`);
            return `${nearestSymbol}+0x${offset.toString(16)} [far]`;
        }
        
        return null;
    }
    
    // Enhanced debugging: show symbol lookup details
    console.log(`Symbol found: ${nearestSymbol} at 0x${nearestAddress.toString(16)}, offset=0x${offset.toString(16)}`);
    
    // Check if there are multiple symbols at nearby addresses (common for inlined functions)
    const nearbySymbols = sortedAddresses.filter(([addr, _]) => 
        Math.abs(addr - nearestAddress) <= 0x100
    );
    
    if (nearbySymbols.length > 1) {
        console.log(`Multiple nearby symbols found (within 0x100 bytes):`);
        nearbySymbols.forEach(([addr, sym]) => {
            console.log(`  0x${addr.toString(16)}: ${sym}`);
        });
    }
    
    if (offset === 0) {
        return nearestSymbol;
    } else {
        return `${nearestSymbol}+0x${offset.toString(16)}`;
    }
}

// Export test helpers for unit testing
export const testHelpers = {
    getLibraryBaseName,
    parseModuleBaseAddresses,
    findNearestSymbol,
    loadSymbolTable,
    SymbolTableCache // Export the class for testing
};