import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Result of running `dump_syms` on a single binary.
 */
export interface BreakpadExtractionResult {
    /** The module name as recorded in the .sym file (e.g. `app.pdb`). */
    moduleName: string;
    /** Uppercase Breakpad debug id (matches what minidump_stackwalk -m emits). */
    debugId: string;
    /** Absolute path of the generated .sym file. */
    symPath: string;
}

const DUMP_SYMS_BINARY = process.platform === 'win32' ? 'dump_syms.exe' : 'dump_syms';

/**
 * Locate dump_syms. We deliberately do not auto-install it (yet); in Phase 1
 * we only consume what the user has on their PATH or explicitly configured.
 */
export function getDumpSymsCommand(): string {
    const cfg = vscode.workspace.getConfiguration('minidump-parser');
    const custom = cfg.get<string>('customDumpSymsPath');
    if (custom && fs.existsSync(custom)) {
        return custom;
    }
    return DUMP_SYMS_BINARY;
}

export async function isDumpSymsAvailable(): Promise<boolean> {
    return new Promise(resolve => {
        execFile(getDumpSymsCommand(), ['--help'], { timeout: 5000 }, error => {
            resolve(!error);
        });
    });
}

/**
 * Run `dump_syms` for a binary and write the result into the canonical
 * Breakpad layout: `<symbolPath>/<moduleName>/<debugId>/<baseName>.sym`.
 *
 * The first line of dump_syms output has the form:
 *   `MODULE <os> <arch> <DEBUG_ID> <module_name>`
 * — we trust that header for both the directory layout and the .sym filename
 * so it always matches what minidump_stackwalk will look up at resolve time.
 */
export async function extractBreakpadSymbols(
    binaryPath: string,
    symbolPath: string,
): Promise<BreakpadExtractionResult> {
    if (!fs.existsSync(binaryPath)) {
        throw new Error(`Binary not found: ${binaryPath}`);
    }
    if (!fs.existsSync(symbolPath)) {
        fs.mkdirSync(symbolPath, { recursive: true });
    }

    const cmd = getDumpSymsCommand();
    const stdout = await runDumpSyms(cmd, binaryPath);
    const header = parseModuleHeader(stdout);
    if (!header) {
        throw new Error(
            `dump_syms produced no MODULE header for ${path.basename(binaryPath)}; ` +
            `the binary may be stripped or unsupported.`,
        );
    }

    const moduleDir = path.join(symbolPath, header.moduleName, header.debugId);
    fs.mkdirSync(moduleDir, { recursive: true });
    // Strip pdb/exe/dll only for the .sym file's base; keep the parent dir name
    // exactly as dump_syms reported so .sym lookups succeed.
    const baseName = header.moduleName.replace(/\.(pdb|exe|dll)$/i, '');
    const symPath = path.join(moduleDir, `${baseName}.sym`);
    fs.writeFileSync(symPath, stdout, 'utf8');

    return { moduleName: header.moduleName, debugId: header.debugId, symPath };
}

/**
 * Run dump_syms across every executable/library in a directory.
 * Failures for individual files are collected rather than aborting the batch
 * — partial symbol coverage is still useful.
 */
export async function extractBreakpadSymbolsFromDirectory(
    directoryPath: string,
    symbolPath: string,
): Promise<{ succeeded: BreakpadExtractionResult[]; failed: { file: string; error: string }[] }> {
    const succeeded: BreakpadExtractionResult[] = [];
    const failed: { file: string; error: string }[] = [];

    const candidates = collectBinaries(directoryPath);
    for (const file of candidates) {
        try {
            const result = await extractBreakpadSymbols(file, symbolPath);
            succeeded.push(result);
        } catch (err: any) {
            failed.push({ file, error: err?.message ?? String(err) });
        }
    }
    return { succeeded, failed };
}

function runDumpSyms(cmd: string, binaryPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            cmd,
            [binaryPath],
            { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        reject(new Error(
                            `dump_syms not found. Install Breakpad's dump_syms and ensure ` +
                            `it is on PATH, or set "minidump-parser.customDumpSymsPath".`,
                        ));
                        return;
                    }
                    reject(new Error(`dump_syms failed for ${path.basename(binaryPath)}: ${error.message}`));
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

interface ModuleHeader {
    os: string;
    arch: string;
    debugId: string;
    moduleName: string;
}

export function parseModuleHeader(symContent: string): ModuleHeader | null {
    const firstLine = symContent.split(/\r?\n/, 1)[0];
    if (!firstLine || !firstLine.startsWith('MODULE ')) {
        return null;
    }
    // MODULE <os> <arch> <debug_id> <module_name (may contain spaces)>
    const parts = firstLine.split(' ');
    if (parts.length < 5) {
        return null;
    }
    return {
        os: parts[1],
        arch: parts[2],
        debugId: parts[3].toUpperCase(),
        moduleName: parts.slice(4).join(' ').trim(),
    };
}

function collectBinaries(directoryPath: string): string[] {
    const valid = new Set(['.exe', '.dll', '.so', '.dylib']);
    const out: string[] = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (valid.has(ext) || (process.platform !== 'win32' && /\.so(\.\d+)*$/.test(entry.name))) {
                    out.push(full);
                }
            }
        }
    };
    walk(directoryPath);
    return out;
}

// Tiny helper exposed for tests
export const _internal = { parseModuleHeader, collectBinaries };
// Avoid unused-import warning when bundlers tree-shake
void os;
