import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findDynamicLibraries, getNmCommand, isNmAvailable } from '../config/config';
import { localization } from '../localization/localization';

export async function extractSymbolsFromBinary(binaryPath: string, symbolPath: string) {
    try {
        // Check if nm is available
        if (!isNmAvailable()) {
            throw new Error('nm command not found. Please install Xcode Command Line Tools on macOS or build-essential on Linux.');
        }
        
        // Get the preferred nm command (nm or llvm-nm)
        const nmCommand = getNmCommand();
        
        // Debug: Print the actual nm command being used
        console.log(`DEBUG: Using nm command: ${nmCommand}`);
        
        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Extracting symbols with nm...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: `Running ${nmCommand} command...` });
            
            const binaryName = path.basename(binaryPath, path.extname(binaryPath));
            const outputFile = path.join(symbolPath, `${binaryName}_nm.txt`);
            
            // Log the exact command being executed for debugging
            console.log(`Executing ${nmCommand} for symbol extraction:`);
            console.log(`  Input file: ${binaryPath}`);
            console.log(`  Output file: ${outputFile}`);
            console.log(`  Command: ${nmCommand} -C "${binaryPath}"`);

            return new Promise<void>((resolve, reject) => {
                // Use async execFile to avoid blocking the UI thread
                execFile(nmCommand, ['-C', binaryPath], { 
                    encoding: 'utf8',
                    maxBuffer: 200 * 1024 * 1024 // 200MB buffer for large symbol tables
                }, (error, nmOutput, stderr) => {
                    if (error) {
                        if (error.message.includes('command not found') || (error as any).status === 127) {
                            reject(`${nmCommand} command not found. Please ensure developer tools are installed (Xcode Command Line Tools on macOS).`);
                        } else if (error.message.includes('no symbols') || error.message.includes('not a dynamic object')) {
                            reject(`No symbols found in ${path.basename(binaryPath)}. The binary may be stripped or not contain symbol information.`);
                        } else {
                            reject(`${nmCommand} command failed: ${error.message || error}`);
                        }
                        return;
                    }
                    
                    progress.report({ increment: 50, message: "Processing symbol data..." });
                    
                    // Parse nm output and create a more readable format
                    const processedSymbols = processNmOutput(nmOutput, binaryName);
                    
                    // Write the processed output to the file
                    fs.writeFileSync(outputFile, processedSymbols);
                    console.log(`Symbols extracted to: ${outputFile}`);
                    
                    progress.report({ increment: 100, message: "Symbol extraction completed!" });
                    
                    // Open the generated symbol file
                    vscode.workspace.openTextDocument(outputFile).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                    
                    vscode.window.showInformationMessage(localization.format(localization.getUI('symbolsExtractedSuccessfully'), nmCommand, outputFile));
                    resolve();
                });
            });
        });
        
    } catch (error: any) {
        throw error;
    }
}

export async function extractSymbolsFromDirectory(directoryPath: string, symbolPath: string) {
    try {
        // Check if nm is available
        if (!isNmAvailable()) {
            throw new Error('nm command not found. Please install Xcode Command Line Tools on macOS or build-essential on Linux.');
        }

        // Find all dynamic libraries in the directory recursively
        const dynamicLibraries = findDynamicLibraries(directoryPath);
        
        if (dynamicLibraries.length === 0) {
            vscode.window.showInformationMessage(localization.format(localization.getUI('noDynamicLibrariesFound'), directoryPath));
            return;
        }

        vscode.window.showInformationMessage(localization.format(localization.getUI('foundDynamicLibraries'), dynamicLibraries.length.toString()));

        // Get the preferred nm command (nm or llvm-nm)
        const nmCommand = getNmCommand();
        
        // Debug: Print the actual nm command being used
        console.log(`DEBUG: Batch extraction using nm command: ${nmCommand}`);
        
        // Show progress with detailed reporting
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Batch extracting symbols...",
            cancellable: false
        }, async (progress) => {
            const totalFiles = dynamicLibraries.length;
            let processedFiles = 0;
            let successfulExtractions = 0;
            let failedExtractions = 0;
            const failedFiles: string[] = [];

            for (const binaryPath of dynamicLibraries) {
                const relativePath = path.relative(directoryPath, binaryPath);
                progress.report({ 
                    increment: (100 / totalFiles), 
                    message: localization.format(localization.getUI('batchExtraction.processingLibraries'), relativePath, (processedFiles + 1).toString(), totalFiles.toString())
                });

                try {
                    const binaryName = path.basename(binaryPath, path.extname(binaryPath));
                    const outputFile = path.join(symbolPath, `${binaryName}_nm.txt`);
                    
                    // Log the exact command being executed for debugging
                    console.log(`Batch processing: ${nmCommand} for ${binaryPath}`);

                    // Use async execFile to avoid blocking the UI thread
                    const nmOutput = await new Promise<string>((resolveNm, rejectNm) => {
                        execFile(nmCommand, ['-C', binaryPath], { 
                            encoding: 'utf8',
                            maxBuffer: 200 * 1024 * 1024 // 200MB buffer for large symbol tables
                        }, (err, stdout) => {
                            if (err) { rejectNm(err); } else { resolveNm(stdout); }
                        });
                    });
                    
                    // Parse nm output and create a more readable format
                    const processedSymbols = processNmOutput(nmOutput, binaryName);
                    
                    // Write the processed output to the file
                    fs.writeFileSync(outputFile, processedSymbols);
                    console.log(`Batch extraction: Symbols extracted to: ${outputFile}`);
                    
                    successfulExtractions++;
                    
                } catch (error: any) {
                    console.error(`Failed to extract symbols from ${binaryPath}: ${error.message}`);
                    failedExtractions++;
                    failedFiles.push(relativePath);
                }

                processedFiles++;
            }

            // Show summary
            const summaryMessage = localization.format(localization.getUI('batchExtraction.batchExtractionCompleted')) + '\n' +
                                 localization.format(localization.getUI('batchExtraction.batchExtractionSummary'), successfulExtractions.toString(), totalFiles.toString(), failedExtractions.toString());
            
            if (failedFiles.length > 0) {
                const failedList = failedFiles.slice(0, 5).join('\n'); // Show first 5 failed files
                const additionalFailed = failedFiles.length > 5 ? `\n... and ${failedFiles.length - 5} more` : '';
                vscode.window.showWarningMessage(
                    `${summaryMessage}\n\n${localization.getUI('batchExtraction.failedFiles')}\n${failedList}${additionalFailed}`,
                    localization.getUI('batchExtraction.showSymbolDirectory')
                ).then(choice => {
                    if (choice === localization.getUI('batchExtraction.showSymbolDirectory')) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(symbolPath));
                    }
                });
            } else {
                vscode.window.showInformationMessage(
                    summaryMessage,
                    localization.getUI('batchExtraction.showSymbolDirectory')
                ).then(choice => {
                    if (choice === localization.getUI('batchExtraction.showSymbolDirectory')) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(symbolPath));
                    }
                });
            }
        });
        
    } catch (error: any) {
        throw error;
    }
}

export function processNmOutput(nmOutput: string, binaryName: string): string {
    // Add a simple header and return the original nm output
    let result = `=== SYMBOLS FOR ${binaryName} ===\n`;
    result += `Generated: ${new Date().toISOString()}\n`;
    result += `nm command output:\n\n`;
    
    // Return the original nm output with minimal processing
    result += nmOutput;
    
    return result;
}

export function getSymbolTypeDescription(type: string): string {
    switch (type) {
        case 'T': return 'Text (code) section - Global functions';
        case 't': return 'Text (code) section - Local functions';
        case 'D': return 'Data section - Initialized global variables';
        case 'd': return 'Data section - Initialized local variables';
        case 'B': return 'BSS section - Uninitialized global variables';
        case 'b': return 'BSS section - Uninitialized local variables';
        case 'U': return 'Undefined - External references';
        case 'W': return 'Weak symbols';
        case 'w': return 'Weak symbols (local)';
        case 'R': return 'Read-only data section';
        case 'r': return 'Read-only data section (local)';
        case 'A': return 'Absolute symbols';
        case 'N': return 'Debug symbols';
        default: return `Other (${type})`;
    }
}
