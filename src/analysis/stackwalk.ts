import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile, execSync } from 'child_process';
import { MINIDUMP_STACKWALK_CONFIG, getDownloadUrl, getBinaryName, getCustomMinidumpStackwalkPath, isValidMinidumpStackwalkPath } from '../config/config';
import { installMinidumpStackwalk } from '../tools/minidump-stackwalk-installer';
import { enhanceStackTraceWithSymbols } from '../symbols/enhancer';
import { localization } from '../localization/localization';

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
        throw new Error('User cancelled installation');
    }
}

export async function runStackwalk(context: vscode.ExtensionContext, dumpPath: string, symbolPath: string): Promise<string> {
    const exe = await getBinaryPath(context);
    
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
        throw new Error(`Failed to make binary executable: ${error}`);
    }

    // Log the exact command being executed for debugging
    console.log(`Executing minidump_stackwalk:`);
    console.log(`  Binary: ${exe}`);
    console.log(`  Dump file: ${dumpPath}`);
    console.log(`  Symbol path: ${symbolPath}`);
    console.log(`  Command: ${exe} "${dumpPath}" "${symbolPath}"`);

    return new Promise<string>((resolve, reject) => {
        execFile(exe, [dumpPath, symbolPath], async (err: Error | null, stdout: string, stderr: string) => {
            // Always log stderr for debugging
            if (stderr && stderr.trim().length > 0) {
                console.log(`minidump_stackwalk stderr: ${stderr}`);
            }
            
            // Check if we have valid output first, regardless of exit code
            if (stdout && stdout.trim().length > 0) {
                // We have output, so the tool worked - clean it up for display
                console.log(`minidump_stackwalk produced output (${stdout.length} characters)`);
                
                // Clean up the output by separating debug info from actual crash data
                const cleanOutput = cleanStackwalkOutput(stdout, stderr);
                
                // Try to enhance with symbols if available
                try {
                    const enhancedOutput = await enhanceStackTraceWithSymbols(cleanOutput, symbolPath);
                    resolve(enhancedOutput);
                } catch (enhanceError: any) {
                    console.log(`Symbol enhancement failed (proceeding with basic output): ${enhanceError.message}`);
                    resolve(cleanOutput);
                }
            } else if (err) {
                // No output and there was an error
                console.error(`minidump_stackwalk error: ${err.message}`);
                
                if (err.message.includes('ENOENT') || err.message.includes('command not found')) {
                    reject(new Error('minidump_stackwalk tool not found. Please install breakpad tools.'));
                } else if (err.message.includes('Invalid dump file') || stderr.includes('Invalid dump file')) {
                    reject(new Error('Invalid or corrupted dump file format.'));
                } else if (err.message.includes('Permission denied')) {
                    reject(new Error('Permission denied. Check file permissions for the dump file or binary.'));
                } else {
                    reject(new Error(`minidump_stackwalk execution failed: ${err.message}\n\nStderr: ${stderr}`));
                }
            } else {
                // No output but no error either - this might be an empty dump or other issue
                resolve('No stack trace data found in the dump file. The dump might be empty or corrupted.');
            }
        });
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

        // Count stack frames and stack-scan frames
        if (trimmed.match(/^\d+\s+/)) {
            summary.totalFrameCount++;
        }
        if (trimmed.startsWith('Found by:') && trimmed.toLowerCase().includes('stack scanning')) {
            summary.stackScanFrameCount++;
        }
    }

    return summary;
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

    lines.push('='.repeat(50));
    lines.push('');
    return lines.join('\n');
}

export function cleanStackwalkOutput(stdout: string, stderr: string): string {
    const lines = stdout.split('\n');
    const cleanLines: string[] = [];
    let inCrashSection = false;
    let foundMainInfo = false;
    let previousLineWasHeader = false;
    let lastFrameIndex = -1;
    
    // First pass: parse crash summary from raw output
    const summary = parseCrashSummary(stdout);
    
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
        title: "Analyzing dump file...",
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ increment: 10, message: "Preparing analysis..." });
            
            const analysisResult = await runStackwalk(context, dumpPath, symbolPath);
            
            progress.report({ increment: 50, message: "Processing results..." });
            
            // Create a new document with the analysis result
            const doc = await vscode.workspace.openTextDocument({
                content: analysisResult,
                language: 'plaintext'  // use plaintext instead of text，ensure hover provider can recognize
            });
            
            progress.report({ increment: 100, message: "Analysis complete!" });
            
            await vscode.window.showTextDocument(doc);
            
            vscode.window.showInformationMessage(localization.format(localization.getUI('dumpFileAnalysisCompleted'), path.basename(dumpPath)));
            
        } catch (error: any) {
            throw error;
        }
    });
}
