import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ChildProcess, execFile, execSync } from 'child_process';
import { MINIDUMP_STACKWALK_CONFIG, getCustomMinidumpStackwalkPath, getDownloadUrl, getBinaryName, getShowStackScanFrames, isValidMinidumpStackwalkPath } from '../config/config';
import { installMinidumpStackwalk } from '../tools/minidump-stackwalk-installer';
import { enhanceStackTraceWithSymbols } from '../symbols/enhancer';
import { localization } from '../localization/localization';
import { MachineDump, parseMachineFormat } from './machine-format';

export const STACKWALK_EXEC_TIMEOUT_MS = 120_000;
export const ANALYSIS_CANCELLED_CODE = 'ANALYSIS_CANCELLED';

export function createAnalysisCancelledError(): Error & { code: string } {
    const error = new Error(localization.getUI('analysisCancelled'));
    error.name = ANALYSIS_CANCELLED_CODE;
    (error as Error & { code: string }).code = ANALYSIS_CANCELLED_CODE;
    return error as Error & { code: string };
}

export function isAnalysisCancelledError(error: unknown): boolean {
    return Boolean(
        error &&
        typeof error === 'object' &&
        ((error as { code?: string }).code === ANALYSIS_CANCELLED_CODE ||
            (error as { name?: string }).name === ANALYSIS_CANCELLED_CODE),
    );
}

export const PARTIAL_ANALYSIS_MARKER = '=== PARTIAL ANALYSIS ===';
export const INVALID_ANALYSIS_MARKER = '=== INVALID ANALYSIS ===';

export type StackwalkResultStatus = 'complete' | 'partial' | 'invalid';

export interface StackwalkResultAssessment {
    status: StackwalkResultStatus;
    frameCount: number;
    severeDiagnostics: string[];
}

const SEVERE_STACKWALK_DIAGNOSTICS: readonly RegExp[] = [
    /readstring\b.*odd[-\s]?sized/i,
    /minidumpmodulelist\b.*(?:size\s+mismatch|index\s+out\s+of\s+range)/i,
    /\b(?:thread|exception|context)\b.*\b(?:invalid|cannot\s+read|could\s+not\s+read|unavailable|missing)\b/i,
    /\b(?:minidumpcontext|context)\b.*\bsize\s+mismatch\b/i,
    /\bminidumpsysteminfo\b.*\b(?:could\s+not\s+read|cannot\s+read|invalid|missing)\b/i,
    /\b(?:memory|stack)\s+(?:region|descriptor)\b.*\b(?:invalid|problem|out\s+of\s+range|missing)\b/i,
    /\bno\s+memory\s+region\b/i,
    /\bno\s+stackwalker\b/i,
    /can't\s+choose\s+a\s+stackwalker.*context/i,
    /\b(?:invalid|corrupt(?:ed)?|malformed|truncated)\s+(?:dump|minidump|stream|file)\b/i,
];

/**
 * Return only diagnostics that indicate the dump could not be walked
 * reliably. Symbol lookup warnings are intentionally not included: a dump
 * without local symbols can still have a valid context frame.
 */
export function getSevereStackwalkDiagnostics(stderr: string): string[] {
    const diagnostics: string[] = [];
    for (const line of (stderr || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || !SEVERE_STACKWALK_DIAGNOSTICS.some(pattern => pattern.test(trimmed))) {
            continue;
        }
        if (!diagnostics.includes(trimmed)) {
            diagnostics.push(trimmed);
        }
    }
    return diagnostics;
}

/**
 * Count actual frame lines in human-readable stackwalk output.
 * Numbered lines outside a Thread block are not treated as stack frames.
 */
export function countStackwalkFrames(output: string): number {
    let inThread = false;
    let count = 0;
    for (const line of (output || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^Thread\s+\d+\b/i.test(trimmed)) {
            inThread = true;
            continue;
        }
        if (inThread && /^(?:\d+)\s+\S+/.test(trimmed)) {
            count++;
        }
        if (inThread && /^(?:Loaded modules:|Crash reason:|Operating system:|GPU:)/i.test(trimmed)) {
            inThread = false;
        }
    }
    return count;
}

/**
 * Assess the result independently of the process exit code. Breakpad can
 * exit 0 after emitting a structurally broken dump, so stdout alone is not a
 * success signal.
 */
export function assessStackwalkResult(
    stdout: string,
    stderr: string,
    machineFrameCount = 0,
    executionFailed = false,
): StackwalkResultAssessment {
    const severeDiagnostics = getSevereStackwalkDiagnostics(stderr);
    const frameCount = Math.max(countStackwalkFrames(stdout), machineFrameCount);
    let status: StackwalkResultStatus = 'complete';
    if (frameCount === 0) {
        status = 'invalid';
    } else if (severeDiagnostics.length > 0 || executionFailed) {
        status = 'partial';
    }
    return { status, frameCount, severeDiagnostics };
}

export function getStackwalkResultStatus(output: string): StackwalkResultStatus {
    if (output.includes(INVALID_ANALYSIS_MARKER)) {
        return 'invalid';
    }
    if (output.includes(PARTIAL_ANALYSIS_MARKER)) {
        return 'partial';
    }
    return 'complete';
}

function addStackwalkStatus(
    output: string,
    assessment: StackwalkResultAssessment,
    executionError?: Error | null,
): string {
    if (assessment.status === 'complete') {
        return output;
    }
    const marker = assessment.status === 'invalid'
        ? INVALID_ANALYSIS_MARKER
        : PARTIAL_ANALYSIS_MARKER;
    const descriptionKey = assessment.status === 'invalid'
        ? 'invalidAnalysisResult'
        : 'partialAnalysisResult';
    const lines = [marker, localization.getUI(descriptionKey)];
    if (executionError) {
        lines.push(`Process error: ${executionError.message}`);
    }
    for (const diagnostic of assessment.severeDiagnostics) {
        lines.push(`Stackwalk diagnostic: ${diagnostic}`);
    }
    lines.push('', output);
    return lines.join('\n');
}

export async function getBinaryPath(context: vscode.ExtensionContext): Promise<string> {
    // First check if user has specified a custom minidump_stackwalk path
    const customPath = getCustomMinidumpStackwalkPath();
    if (customPath && isValidMinidumpStackwalkPath(customPath)) {
        console.log(`Using custom minidump-stackwalk path: ${customPath}`);
        return customPath;
    }
    
    const platform = os.platform();
    
    // Determine the correct binary name and path based on platform
    const binaryName = getBinaryName(platform, 'minidump_stackwalk');
    const dumpstormPath = path.join(os.homedir(), MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN, binaryName);
    
    if (fs.existsSync(dumpstormPath)) {
        console.log(`Found minidump-stackwalk at: ${dumpstormPath}`);
        return dumpstormPath;
    }
    
    // Check system PATH for minidump-stackwalk
    try {
        const whichCommand = platform === 'win32' ? 'where' : 'which';
        const whichResult = execSync(`${whichCommand} ${binaryName}`, { encoding: 'utf8' }).trim();
        if (whichResult && fs.existsSync(whichResult)) {
            console.log(`Found minidump-stackwalk in PATH: ${whichResult}`);
            return whichResult;
        }
    } catch (error) {
        // minidump-stackwalk not found in PATH
    }
    
    // If not found, prompt user to install
    const response = await vscode.window.showWarningMessage(
        localization.getUI('minidumpStackwalkNotFound'),
        localization.getUI('autoInstall'), localization.getUI('manualInstall'), localization.getUI('cancel')
    );
    
    if (response === localization.getUI('autoInstall')) {
        try {
            await installMinidumpStackwalk();
            // Check again after installation
            if (fs.existsSync(dumpstormPath)) {
                return dumpstormPath;
            } else {
                throw new Error(localization.getUI('installationCompletedButNotFound'));
            }
        } catch (error) {
            throw new Error(localization.format(localization.getUI('installationFailed'), error));
        }
    } else if (response === localization.getUI('manualInstall')) {
        const installInstructions = platform === 'win32' 
            ? localization.format(localization.getUI('downloadWindowsVersion'), MINIDUMP_STACKWALK_CONFIG.DOWNLOAD_URLS.WIN32)
            : localization.format(localization.getUI('downloadAndExtract'), getDownloadUrl(platform, os.arch()));
        
        vscode.window.showInformationMessage(installInstructions);
        throw new Error(localization.getUI('userChoseManualInstallation'));
    } else {
        throw new Error(localization.getUI('userCancelledInstallation'));
    }
}

export async function runStackwalk(
    context: vscode.ExtensionContext,
    dumpPath: string,
    symbolPath: string,
    cancellationToken?: vscode.CancellationToken,
): Promise<string> {
    const token = cancellationToken ?? {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
    } as vscode.CancellationToken;
    if (token.isCancellationRequested) {
        return Promise.reject(createAnalysisCancelledError());
    }

    const exe = await getBinaryPath(context);
    if (token.isCancellationRequested) {
        return Promise.reject(createAnalysisCancelledError());
    }
    
    try {
        // Ensure binary is executable on Unix systems (skip for auto-installed dumpstorm binaries which are already set)
        if (os.platform() !== 'win32' && !exe.includes(MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN)) {
            try {
                fs.accessSync(exe, fs.constants.X_OK);
            } catch {
                fs.chmodSync(exe, 0o755);
            }
        }
    } catch (error) {
        throw new Error(localization.format(localization.getUI('failedToMakeBinaryExecutable'), error));
    }

    // Log the exact command being executed for debugging
    console.log(`Executing minidump_stackwalk:`);
    console.log(`  Binary: ${exe}`);
    console.log(`  Dump file: ${dumpPath}`);
    console.log(`  Symbol path: ${symbolPath}`);
    console.log(`  Command: ${exe} "${dumpPath}" "${symbolPath}"`);

    return new Promise<string>((resolve, reject) => {
        let machineProcess: ChildProcess | undefined;
        let humanProcess: ChildProcess | undefined;
        let cancellationDisposable: vscode.Disposable | undefined;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const cleanup = () => {
            cancellationDisposable?.dispose();
            cancellationDisposable = undefined;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
        };

        const terminate = (process: ChildProcess | undefined) => {
            if (process && !process.killed) {
                process.kill();
            }
        };

        const cancel = () => {
            if (settled) {
                return;
            }
            settled = true;
            terminate(machineProcess);
            terminate(humanProcess);
            cleanup();
            reject(createAnalysisCancelledError());
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const complete = (result: string) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        };

        if (token.isCancellationRequested) {
            cancel();
            return;
        }
        if (token.onCancellationRequested) {
            cancellationDisposable = token.onCancellationRequested(cancel);
        }
        timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            terminate(machineProcess);
            terminate(humanProcess);
            cleanup();
            reject(new Error(localization.format(localization.getUI('analysisTimedOut'), STACKWALK_EXEC_TIMEOUT_MS)));
        }, STACKWALK_EXEC_TIMEOUT_MS * 2);

        // First pass: pipe-separated machine format. Stable across Breakpad
        // releases and gives us module debug_ids, base addresses, and per-frame
        // function/source info — the foundation for accurate enhancement and
        // build-id verification.
        try {
            machineProcess = execFile(
                exe,
                ['-m', dumpPath, symbolPath],
                { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8', timeout: STACKWALK_EXEC_TIMEOUT_MS },
                (mErr: Error | null, mStdout: string) => {
            if (settled) {
                return;
            }
            const machineDump: MachineDump | null = mErr || !mStdout
                ? null
                : parseMachineFormat(mStdout);
            if (mErr) {
                console.log(`minidump_stackwalk -m pre-pass failed (continuing without machine data): ${mErr.message}`);
            } else if (machineDump) {
                console.log(`minidump_stackwalk -m parsed: ${machineDump.modules.length} modules, ` +
                    `${machineDump.frames.length} frames, crashed thread=${machineDump.crashingThread}`);
            }

            // Second pass: human-readable output. We keep this as the user-
            // facing format and overlay the machine data on top.
            try {
                humanProcess = execFile(
                    exe,
                    [dumpPath, symbolPath],
                    { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8', timeout: STACKWALK_EXEC_TIMEOUT_MS },
                    async (err: Error | null, stdout: string, stderr: string) => {
                if (settled) {
                    return;
                }
                // Always log stderr for debugging
                if (stderr && stderr.trim().length > 0) {
                    console.log(`minidump_stackwalk stderr: ${stderr}`);
                }

                const assessment = assessStackwalkResult(
                    stdout,
                    stderr,
                    machineDump?.frames.length ?? 0,
                    Boolean(err),
                );

                // Do not treat stdout as success by itself. A broken dump can
                // still yield a crash summary while all usable frames failed.
                if (stdout && stdout.trim().length > 0) {
                    console.log(`minidump_stackwalk produced output (${stdout.length} characters)`);

                    // Clean up the output by separating debug info from actual crash data
                    const cleanOutput = cleanStackwalkOutput(stdout, stderr, {
                        machineDump,
                        symbolPath,
                    });

                    const finish = (output: string) => {
                        if (token.isCancellationRequested) {
                            cancel();
                            return;
                        }
                        complete(addStackwalkStatus(output, assessment, err));
                    };

                    // There is nothing reliable for symbol enhancement to
                    // improve when no stack frame survived the tool output.
                    if (assessment.status === 'invalid') {
                        finish(cleanOutput);
                    } else {
                        try {
                            const enhancedOutput = await enhanceStackTraceWithSymbols(cleanOutput, symbolPath, machineDump ?? undefined);
                            finish(enhancedOutput);
                        } catch (enhanceError: any) {
                            console.log(`Symbol enhancement failed (proceeding with basic output): ${enhanceError.message}`);
                            finish(cleanOutput);
                        }
                    }
                } else if (err) {
                    // No output and there was an error
                    console.error(`minidump_stackwalk error: ${err.message}`);

                    if (err.message.includes('ENOENT') || err.message.includes('command not found')) {
                        fail(new Error(localization.getUI('stackwalkToolNotFound')));
                    } else if (err.message.includes('Invalid dump file') || stderr.includes('Invalid dump file')) {
                        fail(new Error(localization.getUI('invalidDumpFile')));
                    } else if (err.message.includes('Permission denied')) {
                        fail(new Error(localization.getUI('stackwalkPermissionDenied')));
                    } else {
                        fail(new Error(localization.format(localization.getUI('stackwalkExecutionFailed'), err.message, stderr)));
                    }
                } else {
                    // No output but no error either - this might be an empty dump or other issue
                    complete(addStackwalkStatus(localization.getUI('noStackTraceData'), assessment));
                }
                });
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
            });
        } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

/**
 * Stack frame confidence level based on "Found by:" method from minidump_stackwalk.
 */
export enum FrameConfidence {
    /** First frame from exception context - always accurate */
    CONTEXT = 'context',
    /** Unwound via CFI/DWARF unwind info - high confidence */
    CFI = 'cfi',
    /** Unwound via frame pointer chain - medium confidence */
    FRAME_POINTER = 'frame_pointer',
    /** Found by scanning stack for return addresses - low confidence, often inaccurate */
    STACK_SCANNING = 'stack_scanning',
    /** Unknown unwinding method */
    UNKNOWN = 'unknown'
}

/**
 * Map "Found by:" text from minidump_stackwalk to confidence level.
 */
export function parseFrameConfidence(foundByText: string): FrameConfidence {
    const lower = foundByText.toLowerCase().trim();
    if (lower.includes('given as instruction pointer in context')) {
        return FrameConfidence.CONTEXT;
    }
    if (lower.includes('call frame info')) {
        return FrameConfidence.CFI;
    }
    if (lower.includes('frame pointer')) {
        return FrameConfidence.FRAME_POINTER;
    }
    if (lower.includes('stack scanning')) {
        return FrameConfidence.STACK_SCANNING;
    }
    return FrameConfidence.UNKNOWN;
}

/**
 * Get a human-readable confidence label for a frame confidence level.
 */
function getConfidenceLabel(confidence: FrameConfidence): string {
    switch (confidence) {
        case FrameConfidence.CONTEXT:
            return '[confidence: HIGH - exception context]';
        case FrameConfidence.CFI:
            return '[confidence: HIGH - CFI unwind]';
        case FrameConfidence.FRAME_POINTER:
            return '[confidence: MEDIUM - frame pointer]';
        case FrameConfidence.STACK_SCANNING:
            return '[confidence: LOW - stack scanning ⚠]';
        case FrameConfidence.UNKNOWN:
            return '';
    }
}

/**
 * Crash summary extracted from minidump_stackwalk output.
 */
export interface CrashSummary {
    crashReason: string;
    crashAddress: string;
    crashingThread: number;
    crashingModule: string;
    operatingSystem: string;
    cpuInfo: string;
    processUptime: string;
    assertion: string;
    /** Number of frames found by stack scanning (low confidence) */
    stackScanFrameCount: number;
    /** Total number of stack frames */
    totalFrameCount: number;
    /**
     * Optional symbol-match diagnostics, populated when the caller passes a
     * parsed -m machine dump and the symbol directory to {@link cleanStackwalkOutput}.
     */
    symbolMatch?: SymbolMatchReport;
}

/**
 * Per-module symbol availability report. Generated by comparing each module
 * (name, debug_id) in the minidump against `<symbolPath>/<name>/<id>/<name>.sym`.
 */
export interface SymbolMatchReport {
    /** Number of modules that have a matching .sym file. */
    matched: number;
    /** Total number of modules in the dump. */
    totalModules: number;
    /** Modules with no .sym at all (under the expected path). */
    missing: string[];
    /**
     * Modules whose name has at least one .sym on disk but with a different
     * debug_id — strong indicator that the symbol file came from a different
     * build of the same binary.
     */
    mismatched: { name: string; expected: string; foundIds: string[] }[];
    /** True if the crashing module specifically lacks a matching .sym. */
    crashingModuleHasSymbols: boolean;
}

/**
 * Parse a crash summary from minidump_stackwalk raw output.
 */
export function parseCrashSummary(output: string): CrashSummary {
    const summary: CrashSummary = {
        crashReason: '',
        crashAddress: '',
        crashingThread: -1,
        crashingModule: '',
        operatingSystem: '',
        cpuInfo: '',
        processUptime: '',
        assertion: '',
        stackScanFrameCount: 0,
        totalFrameCount: 0
    };

    const lines = output.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();

        // Crash reason: EXCEPTION_ACCESS_VIOLATION_READ
        const reasonMatch = trimmed.match(/^Crash reason:\s*(.+)$/i);
        if (reasonMatch) {
            summary.crashReason = reasonMatch[1].trim();
            continue;
        }

        // Crash address: 0x0
        const addrMatch = trimmed.match(/^Crash address:\s*(0x[0-9a-fA-F]+)$/i);
        if (addrMatch) {
            summary.crashAddress = addrMatch[1];
            continue;
        }

        // Thread 0 (crashed)
        const threadMatch = trimmed.match(/^Thread\s+(\d+)\s+\(crashed\)/i);
        if (threadMatch) {
            summary.crashingThread = parseInt(threadMatch[1], 10);
            continue;
        }

        // First frame of crashed thread: "0  module_name + 0xoffset"
        if (summary.crashingThread >= 0 && !summary.crashingModule) {
            const frameMatch = trimmed.match(/^0\s+([^\s+]+)/);
            if (frameMatch) {
                summary.crashingModule = frameMatch[1];
            }
        }

        // Operating system: Windows NT 10.0.19041
        const osMatch = trimmed.match(/^Operating system:\s*(.+)$/i);
        if (osMatch) {
            summary.operatingSystem = osMatch[1].trim();
            continue;
        }

        // CPU: amd64 family 6 model ...
        const cpuMatch = trimmed.match(/^CPU:\s*(.+)$/i);
        if (cpuMatch) {
            summary.cpuInfo = cpuMatch[1].trim();
            continue;
        }

        // Process uptime: 12 seconds
        const uptimeMatch = trimmed.match(/^Process uptime:\s*(.+)$/i);
        if (uptimeMatch) {
            summary.processUptime = uptimeMatch[1].trim();
            continue;
        }

        // Assertion: ...
        const assertMatch = trimmed.match(/^Assertion:\s*(.+)$/i);
        if (assertMatch) {
            summary.assertion = assertMatch[1].trim();
            continue;
        }

        // Count stack-scan frames here; total frames are counted below with
        // thread-section awareness so CPU details such as "8 CPUs" are not
        // mistaken for stack frames.
        if (trimmed.startsWith('Found by:') && trimmed.toLowerCase().includes('stack scanning')) {
            summary.stackScanFrameCount++;
        }
    }

    summary.totalFrameCount = countStackwalkFrames(output);
    return summary;
}

/**
 * Fold contiguous low-confidence stack-scanning frames within the crashing
 * thread into a single summary line. Only the crashing thread is affected —
 * non-crashed threads keep their full frame list because they are usually
 * skimmed by humans, not analyzed in depth.
 *
 * The filter recognises a frame line by the `[confidence: LOW - stack scanning`
 * marker that {@link cleanStackwalkOutput} appends in its first pass. Other
 * frames (CFI, frame pointer, context) and surrounding metadata pass through
 * unchanged.
 */
function foldStackScanFrames(text: string): string {
    const lines = text.split('\n');
    const out: string[] = [];
    let inCrashedThread = false;
    let runCount = 0;

    const flushRun = () => {
        if (runCount > 0) {
            out.push(
                `   ?? [${runCount} low-confidence frame${runCount > 1 ? 's' : ''} hidden — found by stack scanning;` +
                ` enable "minidump-parser.showStackScanFrames" to expand]`
            );
        }
        runCount = 0;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Track which thread block we're in so we only fold inside the crashing one.
        if (trimmed.startsWith('Thread')) {
            flushRun();
            inCrashedThread = trimmed.includes('crashed');
            out.push(line);
            continue;
        }

        const isStackScanFrame = inCrashedThread &&
            /^\d+\s+/.test(trimmed) &&
            line.includes('[confidence: LOW - stack scanning');

        if (isStackScanFrame) {
            runCount++;
            // Consume the multi-line annotation block that follows this frame
            // (registers, "Found by:", source ref, etc.) so the fold keeps
            // contiguous low-confidence frames merged into one summary line.
            // The annotation block ends at the next frame number, the next
            // Thread header, or a blank line.
            while (i + 1 < lines.length) {
                const nextTrim = lines[i + 1].trim();
                if (nextTrim === '' || nextTrim.startsWith('Thread') || /^\d+\s+/.test(nextTrim)) {
                    break;
                }
                i++;
            }
            continue;
        }

        // A blank line inside a run is harmless padding — keep folding.
        if (runCount > 0 && trimmed === '') {
            continue;
        }

        // Any non-fold line breaks the run.
        flushRun();
        out.push(line);
    }
    flushRun();

    return out.join('\n');
}

/**
 * Format a crash summary block to prepend to the output.
 */
function formatCrashSummaryBlock(summary: CrashSummary): string {
    const lines: string[] = ['=== CRASH SUMMARY ==='];

    if (summary.crashReason) {
        lines.push(`Crash Reason  : ${summary.crashReason}`);
    }
    if (summary.crashAddress) {
        lines.push(`Crash Address : ${summary.crashAddress}`);
    }
    if (summary.crashingThread >= 0) {
        lines.push(`Crashing Thread: ${summary.crashingThread}`);
    }
    if (summary.crashingModule) {
        lines.push(`Crashing Module: ${summary.crashingModule}`);
    }
    if (summary.operatingSystem) {
        lines.push(`OS            : ${summary.operatingSystem}`);
    }
    if (summary.cpuInfo) {
        lines.push(`CPU           : ${summary.cpuInfo}`);
    }
    if (summary.processUptime) {
        lines.push(`Uptime        : ${summary.processUptime}`);
    }
    if (summary.assertion) {
        lines.push(`Assertion     : ${summary.assertion}`);
    }

    // Stack quality indicator
    if (summary.totalFrameCount > 0) {
        const scanPercent = Math.round((summary.stackScanFrameCount / summary.totalFrameCount) * 100);
        let quality = 'HIGH';
        let qualityNote = '';
        if (scanPercent > 50) {
            quality = 'LOW';
            qualityNote = ' - majority of frames found by stack scanning, results may be inaccurate';
        } else if (scanPercent > 20) {
            quality = 'MEDIUM';
            qualityNote = ' - some frames found by stack scanning';
        }
        lines.push(`Stack Quality : ${quality} (${summary.stackScanFrameCount}/${summary.totalFrameCount} frames from stack scanning)${qualityNote}`);
    }

    // Symbol match diagnostics. We surface mismatched modules first because
    // wrong-version symbols silently corrupt every other piece of analysis.
    if (summary.symbolMatch && summary.symbolMatch.totalModules > 0) {
        const sm = summary.symbolMatch;
        const detail: string[] = [];
        if (sm.mismatched.length > 0) {
            detail.push(`${sm.mismatched.length} version mismatched ⚠`);
        }
        if (sm.missing.length > 0) {
            detail.push(`${sm.missing.length} missing`);
        }
        const detailStr = detail.length > 0 ? ` (${detail.join(', ')})` : '';
        lines.push(`Symbol Match  : ${sm.matched}/${sm.totalModules} modules have matching .sym${detailStr}`);
        for (const m of sm.mismatched.slice(0, 3)) {
            lines.push(`  ⚠ ${m.name}: dump expects debug_id ${m.expected}, found [${m.foundIds.join(', ')}]`);
        }
        if (sm.mismatched.length > 3) {
            lines.push(`  … and ${sm.mismatched.length - 3} more mismatched modules`);
        }
        if (summary.crashingModule && !sm.crashingModuleHasSymbols) {
            lines.push(`  ⚠ Crashing module "${summary.crashingModule}" has no matching symbols — stack frames may be inaccurate.`);
        }
    }

    lines.push('='.repeat(50));
    lines.push('');
    return lines.join('\n');
}

/**
 * Inspect `<symbolPath>/<module>/<debug_id>/<module>.sym` for each module in
 * the parsed minidump and report which ones match, which are missing, and
 * which have a different debug_id (wrong-build symbol files).
 */
export function buildSymbolMatchReport(
    machineDump: MachineDump,
    symbolPath: string,
    crashingModuleName: string,
): SymbolMatchReport {
    const report: SymbolMatchReport = {
        matched: 0,
        totalModules: machineDump.modules.length,
        missing: [],
        mismatched: [],
        crashingModuleHasSymbols: false,
    };

    if (!symbolPath || machineDump.modules.length === 0) {
        return report;
    }

    let symbolsRootExists = false;
    try {
        symbolsRootExists = fs.existsSync(symbolPath) && fs.statSync(symbolPath).isDirectory();
    } catch {
        symbolsRootExists = false;
    }
    if (!symbolsRootExists) {
        return report;
    }

    const crashingNorm = (crashingModuleName || '').toLowerCase().split(/[!\\/]/)[0];

    for (const mod of machineDump.modules) {
        if (!mod.name) {
            continue;
        }
        const moduleDir = path.join(symbolPath, mod.name);
        let foundIds: string[] = [];
        try {
            if (fs.existsSync(moduleDir) && fs.statSync(moduleDir).isDirectory()) {
                foundIds = fs.readdirSync(moduleDir).filter(entry => {
                    try {
                        return fs.statSync(path.join(moduleDir, entry)).isDirectory();
                    } catch {
                        return false;
                    }
                });
            }
        } catch {
            // ignore I/O errors; treat as missing
        }

        const expectedId = mod.debugId;
        const expectedSym = expectedId
            ? path.join(moduleDir, expectedId, `${stripSymExt(mod.name)}.sym`)
            : '';
        const matched = !!expectedSym && safeExists(expectedSym);

        if (matched) {
            report.matched++;
            if (mod.name.toLowerCase() === crashingNorm) {
                report.crashingModuleHasSymbols = true;
            }
        } else if (foundIds.length > 0 && expectedId) {
            report.mismatched.push({ name: mod.name, expected: expectedId, foundIds });
        } else {
            report.missing.push(mod.name);
        }
    }

    return report;
}

function safeExists(p: string): boolean {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

/** Drop trailing `.pdb`/`.exe`/`.dll` for the .sym base name (Breakpad convention). */
function stripSymExt(name: string): string {
    return name.replace(/\.(pdb|exe|dll)$/i, '');
}

/** Optional context that callers can supply to enrich the cleaned output. */
export interface CleanContext {
    machineDump?: MachineDump | null;
    symbolPath?: string;
}

export function cleanStackwalkOutput(stdout: string, stderr: string, context?: CleanContext): string {
    const lines = stdout.split('\n');
    const cleanLines: string[] = [];
    let inCrashSection = false;
    let foundMainInfo = false;
    let previousLineWasHeader = false;
    let lastFrameIndex = -1;
    
    // First pass: parse crash summary from raw output
    const summary = parseCrashSummary(stdout);

    // Overlay machine-format data when available: it gives us the authoritative
    // crashing thread index plus an opportunity to verify symbol freshness.
    if (context?.machineDump) {
        const md = context.machineDump;
        if (md.crashingThread >= 0 && summary.crashingThread < 0) {
            summary.crashingThread = md.crashingThread;
        }
        if (md.crashReason && !summary.crashReason) {
            summary.crashReason = md.crashReason;
        }
        if (md.crashAddress && !summary.crashAddress) {
            summary.crashAddress = md.crashAddress;
        }
        if (context.symbolPath) {
            summary.symbolMatch = buildSymbolMatchReport(md, context.symbolPath, summary.crashingModule);
        }
    }
    
    // Filter out debug/informational lines and keep relevant crash data
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Skip empty lines
        if (trimmedLine === '') {
            if (foundMainInfo) {
                cleanLines.push('');
            }
            previousLineWasHeader = false;
            continue;
        }
        
        // Skip debug/loading messages (but keep 'Loaded modules:' section header)
        if (trimmedLine.startsWith('INFO') || 
            trimmedLine.startsWith('DEBUG') ||
            trimmedLine.startsWith('Loading') ||
            (trimmedLine.startsWith('Loaded') && !trimmedLine.startsWith('Loaded modules')) ||
            trimmedLine.includes('symbol file') ||
            trimmedLine.includes('Found debug info')) {
            continue;
        }
        
        // Keep crash-related information
        if (trimmedLine.startsWith('Crash') ||
            trimmedLine.startsWith('Operating system:') ||
            trimmedLine.startsWith('CPU:') ||
            trimmedLine.startsWith('GPU:') ||
            trimmedLine.startsWith('Process uptime:') ||
            trimmedLine.startsWith('Assertion:') ||
            trimmedLine.startsWith('Thread') ||
            trimmedLine.startsWith('Loaded modules:') ||
            trimmedLine.includes('crashed') ||
            trimmedLine.match(/^\d+\s+\S+/)) { // Stack frame lines: frame number followed by module/address
            foundMainInfo = true;
            
            // Annotate stack frames with confidence level from the next "Found by:" line
            if (trimmedLine.match(/^\d+\s+\S+/)) {
                lastFrameIndex = cleanLines.length;
                // Look ahead for "Found by:" line
                for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
                    const nextTrimmed = lines[j].trim();
                    if (nextTrimmed.startsWith('Found by:')) {
                        const confidence = parseFrameConfidence(nextTrimmed);
                        const label = getConfidenceLabel(confidence);
                        if (label) {
                            cleanLines.push(`${line}  ${label}`);
                            lastFrameIndex = -1;
                            break;
                        }
                    }
                    // Stop if we hit another frame or major section
                    if (nextTrimmed.match(/^\d+\s+\S+/) || nextTrimmed.startsWith('Thread')) {
                        break;
                    }
                }
                if (lastFrameIndex >= 0) {
                    cleanLines.push(line);
                    lastFrameIndex = -1;
                }
            } else {
                cleanLines.push(line);
            }
            
            previousLineWasHeader = (
                trimmedLine.startsWith('CPU:') ||
                trimmedLine.startsWith('GPU:') ||
                trimmedLine.startsWith('Loaded modules:')
            );
            
            if (trimmedLine.startsWith('Thread') && trimmedLine.includes('crashed')) {
                inCrashSection = true;
            }
            // Reset crash section when we hit a non-crashed thread
            if (trimmedLine.startsWith('Thread') && !trimmedLine.includes('crashed')) {
                inCrashSection = false;
            }
        }
        // "Found by:" lines - keep them as they indicate stack frame quality
        else if (trimmedLine.startsWith('Found by:')) {
            // Already handled in look-ahead above for frame annotation;
            // Still keep standalone Found by: lines for reference
            cleanLines.push(line);
        }
        // Keep continuation/detail lines (indented lines following CPU:, GPU:, etc.)
        else if (previousLineWasHeader && line.startsWith(' ')) {
            cleanLines.push(line);
        } else if (inCrashSection || foundMainInfo) {
            previousLineWasHeader = false;
            // Keep lines that look like stack frames, module info, or other useful data
            if (trimmedLine.match(/^\d+/) ||  // Frame numbers
                trimmedLine.includes('!') ||  // Module!symbol notation
                trimmedLine.includes('0x') || // Addresses
                trimmedLine.startsWith('Module') ||
                trimmedLine.startsWith('Found by:') ||
                trimmedLine.match(/=\s*0x/) ||  // Register values (eax = 0x...)
                trimmedLine.match(/\.(cpp|c|cc|cxx|h|hpp|rs|go|swift|java|cs|mm|m):\d+/) || // Source file refs
                trimmedLine.includes('.so') ||  // Shared libraries
                trimmedLine.includes('.dll') || // Windows DLLs
                trimmedLine.includes('.dylib') || // macOS dynamic libraries
                trimmedLine.match(/^0x[0-9a-fA-F]+\s+-\s+0x[0-9a-fA-F]+/)) {  // Module address ranges
                cleanLines.push(line);
            }
        }
    }
    
    // If we didn't find much useful info, include more of the original output
    if (cleanLines.length < 5) {
        return stdout;
    }
    
    let result = cleanLines.join('\n');

    // Fold contiguous low-confidence (stack-scanning) frames within the
    // crashing thread so users don't read them as a real call chain.
    if (!getShowStackScanFrames()) {
        result = foldStackScanFrames(result);
    }

    // Prepend crash summary if we have meaningful info
    if (summary.crashReason || summary.crashAddress || summary.crashingThread >= 0) {
        result = formatCrashSummaryBlock(summary) + result;
    }
    
    // Add stderr info if it contains useful error messages (not just debug info)
    if (stderr && stderr.trim().length > 0) {
        const stderrLines = stderr.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed.length > 0 && 
                   !trimmed.startsWith('INFO') && 
                   !trimmed.startsWith('DEBUG') &&
                   !trimmed.includes('symbol file');
        });
        
        if (stderrLines.length > 0) {
            result += '\n\n=== Additional Information ===\n' + stderrLines.join('\n');
        }
    }
    
    return result;
}

export async function analyzeDumpFile(context: vscode.ExtensionContext, dumpPath: string, symbolPath: string) {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: localization.getUI('analyzingDumpFile'),
        cancellable: true,
    }, async (progress, token) => {
        try {
            if (token.isCancellationRequested) {
                return;
            }
            progress.report({ increment: 10, message: localization.getUI('preparingAnalysis') });
            
            const analysisResult = await runStackwalk(context, dumpPath, symbolPath, token);
            if (token.isCancellationRequested) {
                return;
            }
            const resultStatus = getStackwalkResultStatus(analysisResult);
            
            progress.report({ increment: 50, message: localization.getUI('processingAnalysisResults') });
            
            // Create a new document with the analysis result
            const doc = await vscode.workspace.openTextDocument({
                content: analysisResult,
                language: 'plaintext'  // use plaintext instead of text，ensure hover provider can recognize
            });
            
            if (token.isCancellationRequested) {
                return;
            }
            progress.report({
                increment: 100,
                message: localization.getUI(
                    resultStatus === 'complete'
                        ? 'analysisComplete'
                        : resultStatus === 'partial'
                            ? 'analysisPartial'
                            : 'analysisInvalid',
                ),
            });
            
            await vscode.window.showTextDocument(doc);
            
            if (resultStatus === 'complete') {
                vscode.window.showInformationMessage(
                    localization.format(localization.getUI('dumpFileAnalysisCompleted'), path.basename(dumpPath)),
                );
            } else {
                vscode.window.showWarningMessage(
                    localization.format(
                        localization.getUI(resultStatus === 'partial' ? 'dumpFileAnalysisPartial' : 'dumpFileAnalysisInvalid'),
                        path.basename(dumpPath),
                    ),
                );
            }
            
        } catch (error: unknown) {
            if (isAnalysisCancelledError(error)) {
                return;
            }
            throw error;
        }
    });
}
