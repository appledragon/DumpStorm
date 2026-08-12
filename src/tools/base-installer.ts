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

export const POWERSHELL_ARCHIVE_ENV = {
    archive: 'DUMPSTORM_ARCHIVE_PATH',
    destination: 'DUMPSTORM_DESTINATION_PATH',
} as const;

/**
 * PowerShell -Command re-parses the raw command line and strips quotes, so
 * archive paths must not be passed as trailing arguments. Environment
 * variables keep spaces and metacharacters out of the script text.
 */
export function getPowerShellArchiveArgs(): string[] {
    return [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; " +
        `Expand-Archive -LiteralPath $env:${POWERSHELL_ARCHIVE_ENV.archive} ` +
        `-DestinationPath $env:${POWERSHELL_ARCHIVE_ENV.destination} -Force`,
    ];
}

export function getPowerShellArchiveEnv(archivePath: string, destinationPath: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        [POWERSHELL_ARCHIVE_ENV.archive]: archivePath,
        [POWERSHELL_ARCHIVE_ENV.destination]: destinationPath,
    };
}

export function extractZipWithPowerShell(archivePath: string, destinationPath: string): void {
    execFileSync('powershell.exe', getPowerShellArchiveArgs(), {
        env: getPowerShellArchiveEnv(archivePath, destinationPath),
        windowsHide: true,
    });
}

export class InstallCancelledError extends Error {
    readonly code = 'INSTALL_CANCELLED';

    constructor(message?: string) {
        super(message ?? localization.getUI('installer.installationCancelledByUser'));
        this.name = 'InstallCancelledError';
    }
}

export function isInstallCancelledError(error: unknown): boolean {
    if (!error) {
        return false;
    }
    if (error instanceof InstallCancelledError) {
        return true;
    }
    if (typeof error === 'object' && (error as { code?: string }).code === 'INSTALL_CANCELLED') {
        return true;
    }
    if (typeof error === 'object' && (error as { code?: string }).code === 'DOWNLOAD_CANCELLED') {
        return true;
    }
    return false;
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
            if (isInstallCancelledError(error)) {
                return false;
            }
            throw error instanceof Error ? error : new Error(String(error));
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
        reject: (error: Error) => void, 
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = this.getToolConfig();
        let tempFile = '';
        let tempDir = '';
        try {
            if (this.rejectIfCancelled(token, reject)) {
                return;
            }
            
            console.log(`Installing ${binaryInfo.toolName} for Windows`);
            console.log(`Download URL: ${binaryInfo.downloadUrl}`);
            
            const dumpstormDir = path.join(os.homedir(), config.INSTALL_PATHS.DUMPSTORM_BIN);
            console.log(`Target installation directory: ${dumpstormDir}`);
            if (!fs.existsSync(dumpstormDir)) {
                fs.mkdirSync(dumpstormDir, { recursive: true });
                console.log(`Created directory: ${dumpstormDir}`);
            }

            const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            tempFile = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_ZIP), tempSuffix),
            );
            tempDir = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_EXTRACT), tempSuffix),
            );
            
            this.cleanupTempFiles(tempFile, tempDir);

            await downloadFile(binaryInfo.downloadUrl, tempFile, {
                token: token as DownloadCancellationToken,
            });

            if (!this.validateDownloadedFile(tempFile, reject)) {
                return;
            }

            if (this.rejectIfCancelled(token, reject)) {
                return;
            }

            progress.report({
                increment: 25,
                message: localization.format(localization.getUI('downloadingTool'), binaryInfo.toolName),
            });

            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            progress.report({
                increment: 50,
                message: localization.format(localization.getUI('extractingTool'), binaryInfo.toolName),
            });

            console.log(`Extracting archive with PowerShell using environment-variable paths`);
            extractZipWithPowerShell(tempFile, tempDir);
            console.log(`Extraction completed to: ${tempDir}`);

            if (this.rejectIfCancelled(token, reject)) {
                return;
            }

            const allFiles = this.listAllFiles(tempDir);
            console.log(`All extracted files:\n${allFiles.join('\n')}`);

            const foundExes = this.findExecutablesInDir(tempDir, 'win32');
            console.log(`Executables found by recursive search:`, foundExes);

            const mainExecutable = Object.values(foundExes)[0];
            if (!mainExecutable) {
                console.log('No executables found, listing all files for debugging');
                reject(new Error(localization.format(localization.getUI('installer.noExecutableFound'), tempDir, allFiles.join('\n'))));
                return;
            }

            progress.report({
                increment: 75,
                message: localization.format(localization.getUI('installingTool'), binaryInfo.toolName),
            });

            if (this.rejectIfCancelled(token, reject)) {
                return;
            }
            const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
            fs.copyFileSync(mainExecutable, targetPath);
            console.log(`Installed ${binaryInfo.toolName} to: ${targetPath}`);

            progress.report({
                increment: 100,
                message: localization.format(localization.getUI('toolInstallationCompleted'), binaryInfo.toolName),
            });

            setTimeout(() => resolve(), 3000);
            
        } catch (error) {
            if (token.isCancellationRequested || isInstallCancelledError(error)) {
                reject(new InstallCancelledError());
            } else {
                reject(new Error(localization.format(
                    localization.getUI('installer.installationFailed'),
                    error instanceof Error ? error.message : error,
                )));
            }
        } finally {
            this.cleanupTempFiles(tempFile, tempDir);
        }
    }

    /**
     * Install on Unix-like platforms (macOS, Linux)
     */
    protected async installOnUnix(
        binaryInfo: BinaryInfo,
        progress: vscode.Progress<any>, 
        resolve: () => void, 
        reject: (error: Error) => void, 
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = this.getToolConfig();
        let tempFile = '';
        let tempDir = '';
        try {
            if (this.rejectIfCancelled(token, reject)) {
                return;
            }
            
            const platform = os.platform();
            const arch = os.arch();
            
            console.log(`Installing ${binaryInfo.toolName} for platform: ${platform}, arch: ${arch}`);
            console.log(`Download URL: ${binaryInfo.downloadUrl}`);
            
            const dumpstormDir = path.join(os.homedir(), config.INSTALL_PATHS.DUMPSTORM_BIN);
            console.log(`Target installation directory: ${dumpstormDir}`);
            if (!fs.existsSync(dumpstormDir)) {
                fs.mkdirSync(dumpstormDir, { recursive: true });
                console.log(`Created directory: ${dumpstormDir}`);
            }

            const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            tempFile = path.join(
                os.tmpdir(),
                appendTempSuffix(
                    path.basename(config.INSTALL_PATHS.TEMP_TAR || 'temp-download.tar.gz'),
                    tempSuffix,
                ),
            );
            tempDir = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_EXTRACT), tempSuffix),
            );
            
            console.log(`Temp file: ${tempFile}`);
            console.log(`Temp dir: ${tempDir}`);
            
            this.cleanupTempFiles(tempFile, tempDir);

            await downloadFile(binaryInfo.downloadUrl, tempFile, {
                token: token as DownloadCancellationToken,
            });

            if (this.rejectIfCancelled(token, reject)) {
                return;
            }

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

            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
                console.log(`Created extraction directory: ${tempDir}`);
            } else {
                console.log(`Extraction directory already exists: ${tempDir}`);
            }

            if (!fs.existsSync(tempFile)) {
                reject(new Error(localization.format(localization.getUI('installer.tempFileDisappeared'), tempFile)));
                return;
            }

            console.log(`Extracting archive with parameterized tar arguments`);

            try {
                const extractOutput = execFileSync('tar', ['-xzf', tempFile, '-C', tempDir], { encoding: 'utf8' });
                console.log(`Extraction output: ${extractOutput}`);
            } catch (extractError: any) {
                console.log(`Extraction error: ${extractError.message}`);
                console.log(`Extraction stderr: ${extractError.stderr}`);
                reject(new Error(localization.format(localization.getUI('installer.extractionFailed'), extractError.message)));
                return;
            }

            console.log(`Extraction completed to: ${tempDir}`);

            if (this.rejectIfCancelled(token, reject)) {
                return;
            }

            if (!fs.existsSync(tempDir)) {
                reject(new Error(localization.format(localization.getUI('installer.extractionDirectoryNotCreated'), tempDir)));
                return;
            }

            const tempDirContents = fs.readdirSync(tempDir);
            console.log(`Extraction directory contents: ${tempDirContents.join(', ')}`);
            if (tempDirContents.length === 0) {
                reject(new Error(localization.format(localization.getUI('installer.extractionDirectoryEmpty'), tempDir)));
                return;
            }

            progress.report({
                increment: 70,
                message: localization.format(localization.getUI('installingTool'), binaryInfo.toolName),
            });

            const allFiles = this.listAllFiles(tempDir);
            console.log(`All extracted files:\n${allFiles.join('\n')}`);

            const foundBinaries = this.findExecutablesInDir(tempDir, platform);
            console.log(`Binaries found by recursive search:`, foundBinaries);

            const mainExecutable = Object.values(foundBinaries)[0];
            if (!mainExecutable) {
                console.log('No binaries found, listing all files for debugging');
                reject(new Error(localization.format(localization.getUI('installer.noBinaryFound'), platform, arch, tempDir, allFiles.join('\n'))));
                return;
            }

            if (this.rejectIfCancelled(token, reject)) {
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

            setTimeout(() => resolve(), 2000);
            
        } catch (error) {
            if (token.isCancellationRequested || isInstallCancelledError(error)) {
                reject(new InstallCancelledError());
            } else {
                reject(new Error(localization.format(
                    localization.getUI('installer.installationFailed'),
                    error instanceof Error ? error.message : error,
                )));
            }
        } finally {
            this.cleanupTempFiles(tempFile, tempDir);
        }
    }

    protected rejectIfCancelled(
        token: vscode.CancellationToken,
        reject: (error: Error) => void,
    ): boolean {
        if (!token.isCancellationRequested) {
            return false;
        }
        reject(new InstallCancelledError());
        return true;
    }

    /**
     * Clean up temporary files
     */
    protected cleanupTempFiles(tempFile: string, tempDir: string): void {
        if (!tempFile && !tempDir) {
            return;
        }
        try {
            if (tempFile && fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
                console.log(`Cleaned up existing temp file: ${tempFile}`);
            }
            if (tempDir && fs.existsSync(tempDir)) {
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
    protected validateDownloadedFile(tempFile: string, reject: (error: Error) => void): boolean {
        try {
            const stats = fs.statSync(tempFile);
            console.log(`Downloaded file size: ${stats.size} bytes`);
            if (stats.size === 0) {
                reject(new Error(localization.getUI('installer.downloadedFileEmpty')));
                return false;
            }
            return true;
        } catch (statError) {
            reject(new Error(localization.format(localization.getUI('installer.failedToCheckDownloadedFile'), statError)));
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
