// Base installer module for DumpStorm extension
// Contains common installation logic for binary tools

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { localization } from '../localization/localization';
import { downloadFile, DownloadCancellationToken } from './download';

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

export function getPowerShellArchiveArgs(archivePath: string, destinationPath: string): string[] {
    const extractScript = '& { param([string]$archivePath, [string]$destinationPath) ' +
        'Expand-Archive -LiteralPath $archivePath -DestinationPath $destinationPath -Force -ErrorAction Stop }';
    return [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        extractScript,
        archivePath,
        destinationPath,
    ];
}

export function appendTempSuffix(fileName: string, suffix: string): string {
    const extension = path.extname(fileName);
    const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
    return `${baseName}-${suffix}${extension}`;
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
    public async install(): Promise<boolean> {
        const platform = os.platform();
        const arch = os.arch();
        
        const binaryInfo = this.getBinaryInfo(platform, arch);

        // First show a modal information dialog
        const confirmation = await vscode.window.showInformationMessage(
            this.getStartingInstallationMessage(),
            { modal: true }, 
            'OK'
        );
        if (confirmation !== 'OK') {
            return false;
        }

        // Show a persistent progress dialog
        try {
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
        } catch (error) {
            if (String(error) === localization.getUI('installer.installationCancelledByUser')) {
                return false;
            }
            throw error;
        }
        
        // Show final confirmation modal
        await vscode.window.showInformationMessage(
            this.getSuccessMessage(),
            { modal: true }, 
            'OK'
        );
        return true;
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
            const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const tempFile = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_ZIP), tempSuffix),
            );
            const tempDir = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_EXTRACT), tempSuffix),
            );
            
            // Clean up existing temp files
            this.cleanupTempFiles(tempFile, tempDir);

            await downloadFile(binaryInfo.downloadUrl, tempFile, {
                token: token as DownloadCancellationToken,
            });

            // Check file size
            if (!this.validateDownloadedFile(tempFile, reject)) {
                return;
            }

            // Check if cancelled before proceeding
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }

            progress.report({
                increment: 25,
                message: localization.format(localization.getUI('downloadingTool'), binaryInfo.toolName),
            });

            // Create temp extraction directory
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            progress.report({
                increment: 50,
                message: localization.format(localization.getUI('extractingTool'), binaryInfo.toolName),
            });

            // Use PowerShell to extract zip file (available on Windows 10+)
            console.log(`Extracting archive with PowerShell using parameterized paths`);
            execFileSync('powershell.exe', getPowerShellArchiveArgs(tempFile, tempDir));
            console.log(`Extraction completed to: ${tempDir}`);

            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }

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

            progress.report({
                increment: 75,
                message: localization.format(localization.getUI('installingTool'), binaryInfo.toolName),
            });

            // Copy binary to dumpstorm bin directory
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }
            const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
            fs.copyFileSync(mainExecutable, targetPath);
            console.log(`Installed ${binaryInfo.toolName} to: ${targetPath}`);

            // Clean up temp files
            fs.unlinkSync(tempFile);
            fs.rmSync(tempDir, { recursive: true, force: true });

            progress.report({
                increment: 100,
                message: localization.format(localization.getUI('toolInstallationCompleted'), binaryInfo.toolName),
            });

            // Keep the progress dialog open for a few seconds so user can see completion
            setTimeout(() => {
                if (token.isCancellationRequested) {
                    reject(localization.getUI('installer.installationCancelledByUser'));
                } else {
                    resolve();
                }
            }, 3000);
            
        } catch (error) {
            if (token.isCancellationRequested || (error as any)?.code === 'DOWNLOAD_CANCELLED') {
                reject(localization.getUI('installer.installationCancelledByUser'));
            } else {
                reject(localization.format(localization.getUI('installer.installationFailed'), error));
            }
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
            const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const tempFile = path.join(
                os.tmpdir(),
                appendTempSuffix(
                    path.basename(config.INSTALL_PATHS.TEMP_TAR || 'temp-download.tar.gz'),
                    tempSuffix,
                ),
            );
            const tempDir = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_EXTRACT), tempSuffix),
            );
            
            console.log(`Temp file: ${tempFile}`);
            console.log(`Temp dir: ${tempDir}`);
            
            // Clean up any existing temp files/directories
            this.cleanupTempFiles(tempFile, tempDir);

            await downloadFile(binaryInfo.downloadUrl, tempFile, {
                token: token as DownloadCancellationToken,
            });

            // Check if cancelled before proceeding
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }

            // Check file size
            if (!this.validateDownloadedFile(tempFile, reject)) {
                return;
            }

            progress.report({
                increment: 10,
                message: localization.format(localization.getUI('downloadingTool'), binaryInfo.toolName),
            });

            progress.report({
                increment: 40,
                message: localization.format(localization.getUI('extractingTool'), binaryInfo.toolName),
            });

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
            console.log(`Extracting archive with parameterized tar arguments`);

            try {
                const extractOutput = execFileSync('tar', ['-xzf', tempFile, '-C', tempDir], { encoding: 'utf8' });
                console.log(`Extraction output: ${extractOutput}`);
            } catch (extractError: any) {
                console.log(`Extraction error: ${extractError.message}`);
                console.log(`Extraction stderr: ${extractError.stderr}`);
                reject(localization.format(localization.getUI('installer.extractionFailed'), extractError.message));
                return;
            }

            console.log(`Extraction completed to: ${tempDir}`);

            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }

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

            progress.report({
                increment: 70,
                message: localization.format(localization.getUI('installingTool'), binaryInfo.toolName),
            });

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
            if (token.isCancellationRequested) {
                reject(localization.getUI('installer.installationCancelledByUser'));
                return;
            }
            const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
            fs.copyFileSync(mainExecutable, targetPath);
            fs.chmodSync(targetPath, 0o755);
            console.log(`Installed ${binaryInfo.toolName} to: ${targetPath}`);

            progress.report({
                increment: 100,
                message: localization.format(localization.getUI('toolInstallationCompleted'), binaryInfo.toolName),
            });

            // Clean up temp files
            try {
                fs.unlinkSync(tempFile);
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                // Ignore cleanup errors
            }

            // Keep the progress dialog open for a few seconds so user can see completion
            setTimeout(() => {
                if (token.isCancellationRequested) {
                    reject(localization.getUI('installer.installationCancelledByUser'));
                } else {
                    resolve();
                }
            }, 2000);
            
        } catch (error) {
            if (token.isCancellationRequested || (error as any)?.code === 'DOWNLOAD_CANCELLED') {
                reject(localization.getUI('installer.installationCancelledByUser'));
            } else {
                reject(localization.format(localization.getUI('installer.installationFailed'), error));
            }
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
