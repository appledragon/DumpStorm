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
        // Ensure binary is executable (only needed for local binaries)
        if (!exe.includes(MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN)) {
            fs.chmodSync(exe, 0o755);
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

export function cleanStackwalkOutput(stdout: string, stderr: string): string {
    const lines = stdout.split('\n');
    const cleanLines: string[] = [];
    let inCrashSection = false;
    let foundMainInfo = false;
    
    // Filter out debug/informational lines and keep relevant crash data
    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Skip empty lines
        if (trimmedLine === '') {
            if (foundMainInfo) {
                cleanLines.push('');
            }
            continue;
        }
        
        // Skip debug/loading messages
        if (trimmedLine.startsWith('INFO') || 
            trimmedLine.startsWith('DEBUG') ||
            trimmedLine.startsWith('Loading') ||
            trimmedLine.startsWith('Loaded') ||
            trimmedLine.includes('symbol file') ||
            trimmedLine.includes('Found debug info')) {
            continue;
        }
        
        // Keep crash-related information
        if (trimmedLine.startsWith('Crash') ||
            trimmedLine.startsWith('Operating system:') ||
            trimmedLine.startsWith('CPU:') ||
            trimmedLine.startsWith('Process uptime:') ||
            trimmedLine.startsWith('Thread') ||
            trimmedLine.includes('crashed') ||
            trimmedLine.match(/^\d+\s+/)) { // Stack frame lines typically start with frame number
            foundMainInfo = true;
            cleanLines.push(line);
            
            if (trimmedLine.startsWith('Thread') && trimmedLine.includes('crashed')) {
                inCrashSection = true;
            }
        } else if (inCrashSection || foundMainInfo) {
            // In crash section, keep all lines that look like stack frames or module info
            if (trimmedLine.match(/^\d+/) ||  // Frame numbers
                trimmedLine.includes('!') ||  // Module symbols
                trimmedLine.includes('0x') || // Addresses
                trimmedLine.startsWith('Module') ||
                trimmedLine.includes('libr') ||  // Library names
                trimmedLine.includes('.so') ||  // Shared libraries
                trimmedLine.includes('.dll') || // Windows DLLs
                trimmedLine.includes('.dylib')) {  // macOS dynamic libraries
                cleanLines.push(line);
            }
        }
    }
    
    // If we didn't find much useful info, include more of the original output
    if (cleanLines.length < 5) {
        return stdout;
    }
    
    let result = cleanLines.join('\n');
    
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
