import { execFile } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Best-effort MSVC C++ symbol demangler powered by llvm-undname.
 *
 * Many Windows symbol tables (especially those produced by `llvm-nm` on
 * `.lib`/`.obj` files) carry MSVC-mangled names like `?Foo@Bar@@QEAAXXZ`.
 * `nm -C` only knows the Itanium ABI, so those names survive untouched and
 * make stack frames unreadable. When `llvm-undname` is available we batch
 * those names through it and substitute the demangled form.
 *
 * The helper is intentionally tolerant: any failure falls back to the
 * original mangled name so callers never lose data.
 */

const UNDNAME_BINARY = process.platform === 'win32' ? 'llvm-undname.exe' : 'llvm-undname';

let cachedAvailability: boolean | null = null;

function getCommand(): string {
    const cfg = vscode.workspace.getConfiguration('minidump-parser');
    const custom = cfg.get<string>('customLlvmUndnamePath');
    if (custom && fs.existsSync(custom)) {
        return custom;
    }
    return UNDNAME_BINARY;
}

export function resetMsvcDemangleAvailability(): void {
    cachedAvailability = null;
}

export async function isMsvcDemangleAvailable(): Promise<boolean> {
    if (cachedAvailability !== null) {
        return cachedAvailability;
    }
    cachedAvailability = await new Promise<boolean>(resolve => {
        execFile(getCommand(), ['--version'], { timeout: 5000 }, error => resolve(!error));
    });
    return cachedAvailability;
}

/** True for symbols that look like MSVC mangling (`?...`). */
export function isMsvcMangled(name: string): boolean {
    return name.length > 1 && name.charCodeAt(0) === 0x3f /* '?' */;
}

/**
 * Demangle a list of MSVC names in a single llvm-undname invocation.
 * Returns a Map keyed by the original mangled name. Names that fail to
 * demangle (or all names, if llvm-undname is unavailable) are simply absent.
 */
export async function demangleMsvcNames(names: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (names.length === 0) {
        return result;
    }
    if (!(await isMsvcDemangleAvailable())) {
        return result;
    }

    // Deduplicate to keep the input small for symbol-heavy modules.
    const unique = Array.from(new Set(names.filter(isMsvcMangled)));
    if (unique.length === 0) {
        return result;
    }

    return new Promise(resolve => {
        const child = execFile(
            getCommand(),
            // `--no-access-specifier --no-calling-convention` would be nice but
            // are not supported everywhere; keep flags minimal for portability.
            [],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve(result);
                    return;
                }
                // llvm-undname emits one demangled name per input line, in order.
                const out = stdout.split(/\r?\n/);
                for (let i = 0; i < unique.length && i < out.length; i++) {
                    const demangled = out[i].trim();
                    if (demangled && demangled !== unique[i]) {
                        result.set(unique[i], demangled);
                    }
                }
                resolve(result);
            },
        );
        if (child.stdin) {
            child.stdin.end(unique.join('\n') + '\n');
        } else {
            resolve(result);
        }
    });
}
