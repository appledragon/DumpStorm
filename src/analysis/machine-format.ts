/**
 * Parser for `minidump_stackwalk -m <dump> <symbols>` machine-readable output.
 *
 * The `-m` format is pipe-separated and stable across Breakpad releases.
 * Records are line-based, with the first token identifying the record type:
 *
 *   Module|name|version|debug_file|debug_id|base_addr|max_addr|main_module
 *   <thread_idx>|<frame_idx>|module|function|src_file|src_line|module_offset
 *
 * Plus a few standalone records:
 *   Operating system|<name>|<version>
 *   CPU|<arch>|<info>|<count>
 *   Crash|<reason>|<address>|<crashing_thread>
 *   GPU|...
 *
 * Documented in:
 *   https://chromium.googlesource.com/breakpad/breakpad/+/master/src/processor/stackwalk_common.cc
 *
 * Parsing this format gives us:
 *   - exact module base addresses (no need to scrape "Loaded modules:")
 *   - debug_id (build-id) for symbol mismatch detection
 *   - per-frame function/src_file/src_line populated by stackwalk itself when .sym files are available
 *   - the crashing thread index
 */

export interface MachineModule {
    /** Module file name (e.g. "libfoo.so", "kernel32.dll"). */
    name: string;
    /** Module version string, may be empty. */
    version: string;
    /** Debug file (PDB or .so name). */
    debugFile: string;
    /** Breakpad debug_id (UPPERCASE hex, no separators). Empty when not in modules. */
    debugId: string;
    /** Module load base address. */
    baseAddress: number;
    /** Module maximum address (exclusive end). */
    maxAddress: number;
    /** True if this is the main executable. */
    isMain: boolean;
}

export interface MachineFrame {
    /** Thread index (0-based). */
    threadIndex: number;
    /** Frame index within the thread (0 = innermost). */
    frameIndex: number;
    /** Module name, or empty if unknown. */
    module: string;
    /** Demangled function name, or empty if no symbol available. */
    function: string;
    /** Source file path, or empty if no source info. */
    sourceFile: string;
    /** Source line number, or 0 if no source info. */
    sourceLine: number;
    /** Offset within the module (when function is empty) or within the function. */
    moduleOffset: number;
}

export interface MachineDump {
    operatingSystem: string;
    cpu: string;
    crashReason: string;
    crashAddress: string;
    crashingThread: number;
    modules: MachineModule[];
    frames: MachineFrame[];
}

/** Empty dump used when parsing fails. */
function emptyDump(): MachineDump {
    return {
        operatingSystem: '',
        cpu: '',
        crashReason: '',
        crashAddress: '',
        crashingThread: -1,
        modules: [],
        frames: [],
    };
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Parse a decimal index/line field; returns NaN on failure. */
function parseDecimal(value: string): number {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
        return NaN;
    }

    try {
        const parsed = BigInt(trimmed);
        if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > MAX_SAFE_INTEGER_BIGINT) {
            return NaN;
        }
        return Number(parsed);
    } catch {
        return NaN;
    }
}

/**
 * Parse an address/offset as hexadecimal and keep precision during parsing.
 * Breakpad emits bare hexadecimal addresses, including values containing only
 * decimal digits, so these fields must not use decimal inference.
 */
export function parseAddress(value: string): number {
    const trimmed = value.trim();
    if (trimmed === '') {
        return NaN;
    }

    const digits = trimmed.startsWith('0x') || trimmed.startsWith('0X')
        ? trimmed.slice(2)
        : trimmed;
    if (!/^[0-9a-fA-F]+$/.test(digits)) {
        return NaN;
    }

    try {
        const parsed = BigInt(`0x${digits}`);
        if (parsed < 0n || parsed > MAX_SAFE_INTEGER_BIGINT) {
            console.warn(`Skipping unsafe machine-format address: ${value}`);
            return NaN;
        }
        return Number(parsed);
    } catch {
        return NaN;
    }
}

function parseOptionalAddress(value: string): number {
    return value.trim() === '' ? 0 : parseAddress(value);
}

/** Parse the output of `minidump_stackwalk -m`. */
export function parseMachineFormat(output: string): MachineDump {
    if (!output || output.trim() === '') {
        return emptyDump();
    }

    const dump = emptyDump();
    const lines = output.split(/\r?\n/);

    for (const rawLine of lines) {
        // Skip blank lines and unrelated stderr-style noise that may have leaked in.
        if (!rawLine || rawLine.trim() === '') {
            continue;
        }

        const fields = rawLine.split('|');
        if (fields.length < 2) {
            continue;
        }

        const tag = fields[0];

        switch (tag) {
            case 'OS':
            case 'Operating system': {
                // OS|name|version
                const name = fields[1] ?? '';
                const version = fields[2] ?? '';
                dump.operatingSystem = version ? `${name} ${version}`.trim() : name;
                break;
            }
            case 'CPU': {
                // CPU|arch|info|count
                const parts = fields.slice(1).filter(p => p && p !== '');
                dump.cpu = parts.join(' ');
                break;
            }
            case 'Crash': {
                // Crash|reason|address|crashing_thread
                dump.crashReason = fields[1] ?? '';
                dump.crashAddress = fields[2] ?? '';
                const ct = parseDecimal(fields[3] ?? '');
                if (!Number.isNaN(ct)) {
                    dump.crashingThread = ct;
                }
                break;
            }
            case 'Module': {
                // Module|name|version|debug_file|debug_id|base_addr|max_addr|main_module
                if (fields.length < 8) {
                    break;
                }
                const baseAddress = parseAddress(fields[5]);
                const maxAddress = parseOptionalAddress(fields[6]);
                if (Number.isNaN(baseAddress) || Number.isNaN(maxAddress)) {
                    console.warn(`Skipping module with invalid or unsafe address: ${fields[1] ?? ''}`);
                    break;
                }
                dump.modules.push({
                    name: fields[1] ?? '',
                    version: fields[2] ?? '',
                    debugFile: fields[3] ?? '',
                    debugId: (fields[4] ?? '').toUpperCase(),
                    baseAddress,
                    maxAddress,
                    isMain: (fields[7] ?? '').trim() === '1',
                });
                break;
            }
            default: {
                // Frame line: <thread>|<frame>|<module>|<function>|<src_file>|<src_line>|<offset>
                // First two fields must be numeric; otherwise this is not a frame.
                const threadIdx = parseDecimal(fields[0]);
                const frameIdx = parseDecimal(fields[1]);
                if (Number.isNaN(threadIdx) || Number.isNaN(frameIdx) || fields.length < 3) {
                    continue;
                }
                const moduleOffset = fields.length >= 7 && fields[6].trim() !== ''
                    ? parseAddress(fields[6])
                    : 0;
                if (Number.isNaN(moduleOffset)) {
                    console.warn(`Skipping frame with invalid or unsafe offset: ${fields[6] ?? ''}`);
                    continue;
                }
                dump.frames.push({
                    threadIndex: threadIdx,
                    frameIndex: frameIdx,
                    module: fields[2] ?? '',
                    function: fields[3] ?? '',
                    sourceFile: fields[4] ?? '',
                    sourceLine: parseDecimal(fields[5] ?? '') || 0,
                    moduleOffset,
                });
                break;
            }
        }
    }

    return dump;
}

/**
 * Build a name → base address map from the parsed modules. Includes both the
 * full name and a "base name" without extension for fuzzy matching with the
 * shapes the symbol enhancer expects (e.g. "libfoo" vs "libfoo.so.1").
 */
export function buildModuleBaseMap(modules: MachineModule[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const mod of modules) {
        if (!mod.name) {
            continue;
        }
        map.set(mod.name, mod.baseAddress);
        const baseName = stripLibraryExtension(mod.name);
        if (baseName !== mod.name) {
            map.set(baseName, mod.baseAddress);
        }
    }
    return map;
}

/** Strip versioned library suffixes; mirrors enhancer.getLibraryBaseName. */
function stripLibraryExtension(libName: string): string {
    const soMatch = libName.match(/^(.+)\.so(\.\d+)*$/);
    if (soMatch) {
        return soMatch[1];
    }
    if (libName.endsWith('.dylib')) {
        return libName.slice(0, -'.dylib'.length);
    }
    if (libName.endsWith('.dll')) {
        return libName.slice(0, -'.dll'.length);
    }
    if (libName.endsWith('.exe')) {
        return libName.slice(0, -'.exe'.length);
    }
    return libName;
}

/** Group frames by thread for fast lookup. */
export function framesByThread(frames: MachineFrame[]): Map<number, MachineFrame[]> {
    const grouped = new Map<number, MachineFrame[]>();
    for (const frame of frames) {
        const list = grouped.get(frame.threadIndex);
        if (list) {
            list.push(frame);
        } else {
            grouped.set(frame.threadIndex, [frame]);
        }
    }
    for (const list of grouped.values()) {
        list.sort((a, b) => a.frameIndex - b.frameIndex);
    }
    return grouped;
}

/**
 * Return the set of (lowercased) module names that have at least one frame
 * with a non-empty function name. These modules are considered "already
 * symbolicated" by stackwalk and should not be touched by the post-processing
 * nm enhancer.
 */
export function modulesWithResolvedFrames(frames: MachineFrame[]): Set<string> {
    const resolved = new Set<string>();
    for (const frame of frames) {
        if (frame.function && frame.module) {
            resolved.add(frame.module.toLowerCase());
            const stripped = stripLibraryExtension(frame.module).toLowerCase();
            if (stripped !== frame.module.toLowerCase()) {
                resolved.add(stripped);
            }
        }
    }
    return resolved;
}
