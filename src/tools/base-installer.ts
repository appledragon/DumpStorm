// Base installer module for DumpStorm extension
// Contains common installation logic for binary tools

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { localization } from '../localization/localization';

export interface ToolConfig {
    INSTALL_PATHS: {
        DUMPSTORM_BIN: string;
        TEMP_ZIP: string;
        TEMP_TAR?: string;
        TEMP_EXTRACT: string;
    };
}

export interface BinaryInfo {
    downloadUrl: string;
    binaryName: string;
    toolName: string;
}

/**
 * Base installer class with common installation logic
 */
export abstract class BaseInstaller {
    protected abstract getToolConfig(): ToolConfig;
    protected abstract getBinaryInfo(platform: string, arch: string): BinaryInfo;
    protected abstract getStartingInstallationMessage(): string;
    protected abstract getInstallingMessage(): string;
    protected abstract getSuccessMessage(): string;
    protected abstract findExecutablesInDir(dir: string, platform: string): Record<string, string>;

    /**
     * Install tool automatically
     */
    public async install(): Promise<void> {
        const platform = os.platform();
        const arch = os.arch();
        
        const binaryInfo = this.getBinaryInfo(platform, arch);

        // First show a modal information dialog
        await vscode.window.showInformationMessage(
            this.getStartingInstallationMessage(),
            { modal: true }, 
            'OK'
        );

        // Show a persistent progress dialog
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.getInstallingMessage(),
            cancellable: true
        }, async (progress, token) => {
            
            // Show initial status
            progress.report({ 
                increment: 0, 
                message: localization.getUI('installationStarting')
            });
            
            // Add a delay to ensure user sees the initial message
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            return new Promise<void>((resolveProgress, rejectProgress) => {
                if (platform === 'win32') {
                    // For Windows, download and extract manually
                    this.installOnWindows(binaryInfo, progress, resolveProgress, rejectProgress, token);
                } else {
                    // For Unix-like systems, use the tar.gz method
                    this.installOnUnix(binaryInfo, progress, resolveProgress, rejectProgress, token);
                }
            });
        });
        
        // Show final confirmation modal
        await vscode.window.showInformationMessage(
            this.getSuccessMessage(),
            { modal: true }, 
            'OK'
        );
    }

    /**
     * Install on Windows platform
     */
    protected async installOnWindows(
        binaryInfo: BinaryInfo,
        progress: vscode.Progress<any>, 
        resolve: () => void, 
        reject: (error: string) => void, 
        token: vscode.CancellationToken
    ): Promise<void> {
        const https = require('https');
        
        try {
            // Check if cancelled
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }
            
            console.log(`Installing ${binaryInfo.toolName} for Windows`);
            console.log(`Download URL: ${binaryInfo.downloadUrl}`);
            
            // Ensure .dumpstorm/bin directory exists
            const config = this.getToolConfig();
            const dumpstormDir = path.join(os.homedir(), config.INSTALL_PATHS.DUMPSTORM_BIN);
            console.log(`Target installation directory: ${dumpstormDir}`);
            if (!fs.existsSync(dumpstormDir)) {
                fs.mkdirSync(dumpstormDir, { recursive: true });
                console.log(`Created directory: ${dumpstormDir}`);
            }

            // Download the zip file
            const tempFile = path.join(os.tmpdir(), config.INSTALL_PATHS.TEMP_ZIP);
            const tempDir = path.join(os.tmpdir(), config.INSTALL_PATHS.TEMP_EXTRACT);
            
            // Clean up existing temp files
            this.cleanupTempFiles(tempFile, tempDir);
            
            const file = fs.createWriteStream(tempFile);
            
            // Function to handle the actual download response
            const handleDownloadResponse = (response: any) => {
                console.log(`Download response status: ${response.statusCode}`);
                
                if (response.statusCode !== 200) {
                    reject(localization.format(localization.getUI('installer.httpError'), response.statusCode, response.statusMessage));
                    return;
                }
                
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    
                    // Check file size
                    if (!this.validateDownloadedFile(tempFile, reject)) {
                        return;
                    }
                    
                    // Check if cancelled before proceeding
                    if (token.isCancellationRequested) {
                        reject(localization.getUI('installer.installationCancelledByUser'));
                        return;
                    }
                    
                    progress.report({ increment: 25, message: `Downloading ${binaryInfo.toolName} binary file...` });
                    
                    try {
                        // Create temp extraction directory
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        
                        progress.report({ increment: 50, message: `Extracting ${binaryInfo.toolName} binary files...` });
                        
                        // Use PowerShell to extract zip file (available on Windows 10+)
                        const extractCommand = `powershell -command "Expand-Archive -Path '${tempFile}' -DestinationPath '${tempDir}' -Force"`;
                        console.log(`Extracting with command: ${extractCommand}`);
                        execSync(extractCommand);
                        console.log(`Extraction completed to: ${tempDir}`);
                        
                        // List all files immediately after extraction for debugging
                        const allFiles = this.listAllFiles(tempDir);
                        console.log(`All extracted files:\n${allFiles.join('\n')}`);
                        
                        // Find the executable files
                        const foundExes = this.findExecutablesInDir(tempDir, 'win32');
                        console.log(`Executables found by recursive search:`, foundExes);
                        
                        const mainExecutable = Object.values(foundExes)[0];
                        if (!mainExecutable) {
                            console.log('No executables found, listing all files for debugging');
                            reject(localization.format(localization.getUI('installer.noExecutableFound'), tempDir, allFiles.join('\n')));
                            return;
                        }
                        
                        progress.report({ increment: 75, message: `Installing ${binaryInfo.toolName} to .dumpstorm/bin directory...` });
                        
                        // Copy binary to dumpstorm bin directory
                        const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
                        fs.copyFileSync(mainExecutable, targetPath);
                        console.log(`Installed ${binaryInfo.toolName} to: ${targetPath}`);
                        
                        // Clean up temp files
                        fs.unlinkSync(tempFile);
                        fs.rmSync(tempDir, { recursive: true, force: true });
                        
                        progress.report({ increment: 100, message: `${binaryInfo.toolName} installation completed successfully!` });
                        
                        // Keep the progress dialog open for a few seconds so user can see completion
                        setTimeout(() => {
                            resolve();
                        }, 3000);
                    } catch (extractError) {
                        reject(localization.format(localization.getUI('installer.failedToExtractBinary'), extractError));
                    }
                });
                
                file.on('error', (err: any) => {
                    reject(localization.format(localization.getUI('installer.failedToDownload'), err.message));
                });
            };
            
            // Start the download with redirect handling
            this.startDownload(binaryInfo.downloadUrl, handleDownloadResponse, reject);
            
        } catch (error) {
            reject(localization.format(localization.getUI('installer.installationFailed'), error));
        }
    }

    /**
     * Install on Unix-like platforms (macOS, Linux)
     */
    protected async installOnUnix(
        binaryInfo: BinaryInfo,
        progress: vscode.Progress<any>, 
        resolve: () => void, 
        reject: (error: string) => void, 
        token: vscode.CancellationToken
    ): Promise<void> {
        const https = require('https');
        
        try {
            // Check if cancelled
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }
            
            const platform = os.platform();
            const arch = os.arch();
            
            console.log(`Installing ${binaryInfo.toolName} for platform: ${platform}, arch: ${arch}`);
            console.log(`Download URL: ${binaryInfo.downloadUrl}`);
            
            // Ensure .dumpstorm/bin directory exists
            const config = this.getToolConfig();
            const dumpstormDir = path.join(os.homedir(), config.INSTALL_PATHS.DUMPSTORM_BIN);
            console.log(`Target installation directory: ${dumpstormDir}`);
            if (!fs.existsSync(dumpstormDir)) {
                fs.mkdirSync(dumpstormDir, { recursive: true });
                console.log(`Created directory: ${dumpstormDir}`);
            }

            // Download the tar.gz file
            const tempFile = path.join(os.tmpdir(), config.INSTALL_PATHS.TEMP_TAR || 'temp-download.tar.gz');
            const tempDir = path.join(os.tmpdir(), config.INSTALL_PATHS.TEMP_EXTRACT);
            
            console.log(`Temp file: ${tempFile}`);
            console.log(`Temp dir: ${tempDir}`);
            
            // Clean up any existing temp files/directories
            this.cleanupTempFiles(tempFile, tempDir);
            
            const file = fs.createWriteStream(tempFile);
            
            progress.report({ increment: 10, message: `Downloading ${binaryInfo.toolName} binary file...` });
            
            // Function to handle the actual download response
            const handleDownloadResponse = (response: any) => {
                console.log(`Download response status: ${response.statusCode}`);
                
                if (response.statusCode !== 200) {
                    reject(localization.format(localization.getUI('installer.httpError'), response.statusCode, response.statusMessage));
                    return;
                }
                
                response.pipe(file);
                
                file.on('finish', () => {
                    file.close();
                    
                    // Check if cancelled before proceeding
                    if (token.isCancellationRequested) {
                        reject(localization.getUI('installer.installationCancelledByUser'));
                        return;
                    }
                    
                    // Check file size
                    if (!this.validateDownloadedFile(tempFile, reject)) {
                        return;
                    }
                    
                    progress.report({ increment: 40, message: `Extracting ${binaryInfo.toolName} binary files...` });
                    
                    try {
                        // Create temp extraction directory
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                            console.log(`Created extraction directory: ${tempDir}`);
                        } else {
                            console.log(`Extraction directory already exists: ${tempDir}`);
                        }
                        
                        // Verify temp file exists before extraction
                        if (!fs.existsSync(tempFile)) {
                            reject(localization.format(localization.getUI('installer.tempFileDisappeared'), tempFile));
                            return;
                        }
                        
                        // Extract tar.gz file
                        const extractCommand = `tar -xzf "${tempFile}" -C "${tempDir}"`;
                        console.log(`Extracting with command: ${extractCommand}`);
                        
                        try {
                            const extractOutput = execSync(extractCommand, { encoding: 'utf8' });
                            console.log(`Extraction output: ${extractOutput}`);
                        } catch (extractError: any) {
                            console.log(`Extraction error: ${extractError.message}`);
                            console.log(`Extraction stderr: ${extractError.stderr}`);
                            reject(localization.format(localization.getUI('installer.extractionFailed'), extractError.message));
                            return;
                        }
                        
                        console.log(`Extraction completed to: ${tempDir}`);
                        
                        // Verify extraction directory exists and has content
                        if (!fs.existsSync(tempDir)) {
                            reject(localization.format(localization.getUI('installer.extractionDirectoryNotCreated'), tempDir));
                            return;
                        }
                        
                        const tempDirContents = fs.readdirSync(tempDir);
                        console.log(`Extraction directory contents: ${tempDirContents.join(', ')}`);
                        if (tempDirContents.length === 0) {
                            reject(localization.format(localization.getUI('installer.extractionDirectoryEmpty'), tempDir));
                            return;
                        }
                        
                        progress.report({ increment: 70, message: `Installing ${binaryInfo.toolName} to .dumpstorm/bin directory...` });
                        
                        // List all files immediately after extraction for debugging
                        const allFiles = this.listAllFiles(tempDir);
                        console.log(`All extracted files:\n${allFiles.join('\n')}`);
                        
                        // Find the binaries in extracted files
                        const foundBinaries = this.findExecutablesInDir(tempDir, platform);
                        console.log(`Binaries found by recursive search:`, foundBinaries);
                        
                        const mainExecutable = Object.values(foundBinaries)[0];
                        if (!mainExecutable) {
                            console.log('No binaries found, listing all files for debugging');
                            reject(localization.format(localization.getUI('installer.noBinaryFound'), platform, arch, tempDir, allFiles.join('\n')));
                            return;
                        }
                        
                        // Copy binary to dumpstorm bin directory
                        const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
                        fs.copyFileSync(mainExecutable, targetPath);
                        fs.chmodSync(targetPath, 0o755);
                        console.log(`Installed ${binaryInfo.toolName} to: ${targetPath}`);
                        
                        progress.report({ increment: 100, message: `${binaryInfo.toolName} installation completed successfully!` });
                        
                        // Clean up temp files
                        try {
                            fs.unlinkSync(tempFile);
                            fs.rmSync(tempDir, { recursive: true, force: true });
                        } catch (cleanupError) {
                            // Ignore cleanup errors
                        }
                        
                        // Keep the progress dialog open for a few seconds so user can see completion
                        setTimeout(() => {
                            resolve();
                        }, 2000);
                        
                    } catch (extractError) {
                        reject(localization.format(localization.getUI('installer.failedToExtractBinary'), extractError));
                    }
                });
                
                file.on('error', (err: any) => {
                    reject(localization.format(localization.getUI('installer.failedToDownload'), err.message));
                });
            };
            
            // Start the download with redirect handling
            this.startDownload(binaryInfo.downloadUrl, handleDownloadResponse, reject);
            
        } catch (error) {
            reject(localization.format(localization.getUI('installer.installationFailed'), error));
        }
    }

    /**
     * Start download with redirect handling
     */
    protected startDownload(
        downloadUrl: string, 
        handleDownloadResponse: (response: any) => void, 
        reject: (error: string) => void
    ): void {
        const https = require('https');
        
        https.get(downloadUrl, (response: any) => {
            console.log(`HTTP response status: ${response.statusCode}`);
            console.log(`HTTP response headers:`, response.headers);
            
            // Handle redirects
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                console.log(`Redirecting to: ${redirectUrl}`);
                
                if (!redirectUrl) {
                    reject(localization.getUI('installer.redirectMissingLocation'));
                    return;
                }
                
                // Follow the redirect
                https.get(redirectUrl, handleDownloadResponse).on('error', (err: any) => {
                    reject(localization.format(localization.getUI('installer.redirectDownloadFailed'), err.message));
                });
            } else {
                handleDownloadResponse(response);
            }
        }).on('error', (err: any) => {
            reject(localization.format(localization.getUI('installer.downloadFailed'), err.message));
        });
    }

    /**
     * Clean up temporary files
     */
    protected cleanupTempFiles(tempFile: string, tempDir: string): void {
        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
                console.log(`Cleaned up existing temp file: ${tempFile}`);
            }
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                console.log(`Cleaned up existing temp dir: ${tempDir}`);
            }
        } catch (cleanupError) {
            console.log(`Cleanup error (non-fatal): ${cleanupError}`);
        }
    }

    /**
     * Validate downloaded file
     */
    protected validateDownloadedFile(tempFile: string, reject: (error: string) => void): boolean {
        try {
            const stats = fs.statSync(tempFile);
            console.log(`Downloaded file size: ${stats.size} bytes`);
            if (stats.size === 0) {
                reject(localization.getUI('installer.downloadedFileEmpty'));
                return false;
            }
            return true;
        } catch (statError) {
            reject(localization.format(localization.getUI('installer.failedToCheckDownloadedFile'), statError));
            return false;
        }
    }

    /**
     * Helper function to list all files in a directory recursively
     */
    protected listAllFiles(dir: string, prefix = ''): string[] {
        const files: string[] = [];
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    files.push(`${prefix}${item.name}/`);
                    files.push(...this.listAllFiles(fullPath, `${prefix}${item.name}/`));
                } else {
                    files.push(`${prefix}${item.name}`);
                }
            }
        } catch (error) {
            files.push(`Error reading directory ${dir}: ${error}`);
        }
        return files;
    }
}
