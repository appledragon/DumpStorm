// Curl-based installer module for DumpStorm extension
// Alternative implementation using curl for downloads

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { localization } from '../localization/localization';
import { BinaryInfo, ToolConfig } from './base-installer';

const { execSync } = require('child_process');

/**
 * Base curl installer class with common installation logic using curl
 */
export abstract class CurlBaseInstaller {
    protected abstract getToolConfig(): ToolConfig;
    protected abstract getBinaryInfo(platform: string, arch: string): BinaryInfo;
    protected abstract getStartingInstallationMessage(): string;
    protected abstract getInstallingMessage(): string;
    protected abstract getSuccessMessage(): string;
    protected abstract findExecutablesInDir(dir: string, platform: string): Record<string, string>;

    /**
     * Install tool automatically using curl
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
                this.installWithCurl(binaryInfo, progress, resolveProgress, rejectProgress, token);
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
     * Install using curl (works on all platforms)
     */
    protected async installWithCurl(
        binaryInfo: BinaryInfo,
        progress: vscode.Progress<any>, 
        resolve: () => void, 
        reject: (error: string) => void, 
        token: vscode.CancellationToken
    ): Promise<void> {
        try {
            // Check if cancelled
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }
            
            const platform = os.platform();
            
            console.log(`Installing ${binaryInfo.toolName} using curl`);
            console.log(`Download URL: ${binaryInfo.downloadUrl}`);
            
            // Ensure .dumpstorm/bin directory exists
            const config = this.getToolConfig();
            const dumpstormDir = path.join(os.homedir(), config.INSTALL_PATHS.DUMPSTORM_BIN);
            console.log(`Target installation directory: ${dumpstormDir}`);
            if (!fs.existsSync(dumpstormDir)) {
                fs.mkdirSync(dumpstormDir, { recursive: true });
                console.log(`Created directory: ${dumpstormDir}`);
            }

            // Determine file extension and temp file name
            const isZip = platform === 'win32';
            const tempFile = path.join(os.tmpdir(), isZip ? config.INSTALL_PATHS.TEMP_ZIP : (config.INSTALL_PATHS.TEMP_TAR || 'temp-download.tar.gz'));
            const tempDir = path.join(os.tmpdir(), config.INSTALL_PATHS.TEMP_EXTRACT);
            
            // Clean up existing temp files
            this.cleanupTempFiles(tempFile, tempDir);
            
            progress.report({ increment: 10, message: `Downloading ${binaryInfo.toolName} binary file...` });
            
            // Download using curl
            try {
                const curlCommand = `curl -L -o "${tempFile}" "${binaryInfo.downloadUrl}"`;
                console.log(`Downloading with command: ${curlCommand}`);
                execSync(curlCommand, { stdio: 'inherit' });
                console.log(`Download completed to: ${tempFile}`);
            } catch (downloadError: any) {
                reject(localization.format(localization.getUI('installer.downloadFailed'), downloadError.message));
                return;
            }
            
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
                }
                
                // Extract based on platform
                if (isZip) {
                    // Windows: use PowerShell to extract zip
                    const extractCommand = `powershell -command "Expand-Archive -Path '${tempFile}' -DestinationPath '${tempDir}' -Force"`;
                    console.log(`Extracting with command: ${extractCommand}`);
                    execSync(extractCommand);
                } else {
                    // Unix: use tar to extract tar.gz
                    const extractCommand = `tar -xzf "${tempFile}" -C "${tempDir}"`;
                    console.log(`Extracting with command: ${extractCommand}`);
                    execSync(extractCommand, { encoding: 'utf8' });
                }
                
                console.log(`Extraction completed to: ${tempDir}`);
                
                // Verify extraction
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
                
                // List all files for debugging
                const allFiles = this.listAllFiles(tempDir);
                console.log(`All extracted files:\n${allFiles.join('\n')}`);
                
                // Find the executables
                const foundExecutables = this.findExecutablesInDir(tempDir, platform);
                console.log(`Executables found:`, foundExecutables);
                
                const mainExecutable = Object.values(foundExecutables)[0];
                if (!mainExecutable) {
                    console.log('No executables found, listing all files for debugging');
                    reject(localization.format(localization.getUI('installer.noExecutableFound'), tempDir, allFiles.join('\n')));
                    return;
                }
                
                // Copy binary to dumpstorm bin directory
                const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
                fs.copyFileSync(mainExecutable, targetPath);
                
                // Make executable on Unix systems
                if (platform !== 'win32') {
                    fs.chmodSync(targetPath, 0o755);
                }
                
                console.log(`Installed ${binaryInfo.toolName} to: ${targetPath}`);
                
                progress.report({ increment: 100, message: `${binaryInfo.toolName} installation completed successfully!` });
                
                // Clean up temp files
                this.cleanupTempFiles(tempFile, tempDir);
                
                // Keep the progress dialog open for a few seconds so user can see completion
                setTimeout(() => {
                    resolve();
                }, 2000);
                
            } catch (extractError) {
                reject(localization.format(localization.getUI('installer.failedToExtractBinary'), extractError));
            }
            
        } catch (error) {
            reject(localization.format(localization.getUI('installer.installationFailed'), error));
        }
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
