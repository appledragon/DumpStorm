// Curl-based installer module for DumpStorm extension
// Alternative implementation using curl for downloads

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { localization } from '../localization/localization';
import { spawn, execFileSync } from 'child_process';
import { appendTempSuffix, BinaryInfo, extractZipWithPowerShell, InstallCancelledError, isInstallCancelledError, ToolConfig } from './base-installer';
import { DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_REDIRECTS, DownloadCancellationToken, DownloadError } from './download';

function downloadWithCurl(
    downloadUrl: string,
    destination: string,
    token: DownloadCancellationToken,
): Promise<void> {
    const timeoutSeconds = Math.max(1, Math.ceil(DOWNLOAD_TIMEOUT_MS / 1000));

    return new Promise<void>((resolve, reject) => {
        let child: ReturnType<typeof spawn> | undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let cancellationDisposable: { dispose(): void } | undefined;
        let stderr = '';
        let settled = false;

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            cancellationDisposable?.dispose();
            cancellationDisposable = undefined;
        };

        const removePartialDestination = () => {
            try {
                if (fs.existsSync(destination)) {
                    fs.unlinkSync(destination);
                }
            } catch {
                // Preserve the download error if cleanup itself fails.
            }
        };

        const fail = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            child?.kill?.();
            removePartialDestination();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const complete = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve();
        };

        if (token.isCancellationRequested) {
            fail(new DownloadError('Download cancelled by user', 'DOWNLOAD_CANCELLED'));
            return;
        }

        try {
            child = spawn('curl', [
                '--fail',
                '--silent',
                '--show-error',
                '--location',
                '--max-redirs', String(MAX_DOWNLOAD_REDIRECTS),
                '--proto', '=https',
                '--proto-redir', '=https',
                '--connect-timeout', '30',
                '--max-time', String(timeoutSeconds),
                '--output', destination,
                downloadUrl,
            ], {
                stdio: ['ignore', 'ignore', 'pipe'],
            });
        } catch (error) {
            fail(error);
            return;
        }

        if (!child) {
            fail(new Error('Unable to start curl'));
            return;
        }

        child.stderr?.setEncoding?.('utf8');
        child.stderr?.on?.('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', error => {
            fail(error);
        });
        child.on('close', (code, signal) => {
            if (settled) {
                return;
            }
            if (code === 0) {
                complete();
            } else {
                const detail = stderr.trim() || `curl exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
                fail(new Error(detail));
            }
        });

        timeoutHandle = setTimeout(() => {
            fail(new DownloadError(
                `Download timed out after ${DOWNLOAD_TIMEOUT_MS} ms`,
                'DOWNLOAD_TIMEOUT',
            ));
        }, DOWNLOAD_TIMEOUT_MS);

        if (token.onCancellationRequested) {
            cancellationDisposable = token.onCancellationRequested(() => {
                fail(new DownloadError('Download cancelled by user', 'DOWNLOAD_CANCELLED'));
            });
        }
    });
}

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
    public async install(): Promise<boolean> {
        // First show a modal information dialog
        const confirmation = await vscode.window.showInformationMessage(
            this.getStartingInstallationMessage(),
            { modal: true }, 
            'OK'
        );
        if (confirmation !== 'OK') {
            return false;
        }

        return this.installConfirmed();
    }

    /**
     * Run the installation after the caller has confirmed it.
     *
     * Curl-based subclasses can provide a localized confirmation dialog with
     * tool-specific actions without showing a second generic dialog.
     */
    protected async installConfirmed(): Promise<boolean> {
        const platform = os.platform();
        const arch = os.arch();
        const binaryInfo = this.getBinaryInfo(platform, arch);

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
                    this.installWithCurl(binaryInfo, progress, resolveProgress, rejectProgress, token);
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
     * Install using curl (works on all platforms)
     */
    protected async installWithCurl(
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
            if (token.isCancellationRequested) {
                reject(new InstallCancelledError());
                return;
            }
            
            const platform = os.platform();
            
            console.log(`Installing ${binaryInfo.toolName} using curl`);
            console.log(`Download URL: ${binaryInfo.downloadUrl}`);
            
            const dumpstormDir = path.join(os.homedir(), config.INSTALL_PATHS.DUMPSTORM_BIN);
            console.log(`Target installation directory: ${dumpstormDir}`);
            if (!fs.existsSync(dumpstormDir)) {
                fs.mkdirSync(dumpstormDir, { recursive: true });
                console.log(`Created directory: ${dumpstormDir}`);
            }

            const isZip = platform === 'win32';
            const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            tempFile = path.join(
                os.tmpdir(),
                appendTempSuffix(
                    path.basename(isZip ? config.INSTALL_PATHS.TEMP_ZIP : (config.INSTALL_PATHS.TEMP_TAR || 'temp-download.tar.gz')),
                    tempSuffix,
                ),
            );
            tempDir = path.join(
                os.tmpdir(),
                appendTempSuffix(path.basename(config.INSTALL_PATHS.TEMP_EXTRACT), tempSuffix),
            );
            
            this.cleanupTempFiles(tempFile, tempDir);
            
            progress.report({
                increment: 10,
                message: localization.format(localization.getUI('downloadingTool'), binaryInfo.toolName),
            });
            
            try {
                console.log(`Downloading with curl to "${tempFile}"`);
                await downloadWithCurl(
                    binaryInfo.downloadUrl,
                    tempFile,
                    token as DownloadCancellationToken,
                );
                console.log(`Download completed to: ${tempFile}`);
            } catch (downloadError: any) {
                if (token.isCancellationRequested || downloadError?.code === 'DOWNLOAD_CANCELLED') {
                    reject(new InstallCancelledError());
                } else {
                    reject(new Error(localization.format(localization.getUI('installer.downloadFailed'), downloadError.message)));
                }
                return;
            }
            
            if (token.isCancellationRequested) {
                reject(new InstallCancelledError());
                return;
            }
            
            if (!this.validateDownloadedFile(tempFile, reject)) {
                return;
            }
            
            progress.report({
                increment: 40,
                message: localization.format(localization.getUI('extractingTool'), binaryInfo.toolName),
            });
            
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
                console.log(`Created extraction directory: ${tempDir}`);
            }
            
            if (isZip) {
                console.log(`Extracting archive with PowerShell using environment-variable paths`);
                extractZipWithPowerShell(tempFile, tempDir);
            } else {
                console.log(`Extracting archive with parameterized tar arguments`);
                execFileSync('tar', ['-xzf', tempFile, '-C', tempDir], { encoding: 'utf8' });
            }
            
            console.log(`Extraction completed to: ${tempDir}`);

            if (token.isCancellationRequested) {
                reject(new InstallCancelledError());
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
            
            const foundExecutables = this.findExecutablesInDir(tempDir, platform);
            console.log(`Executables found:`, foundExecutables);
            
            const mainExecutable = Object.values(foundExecutables)[0];
            if (!mainExecutable) {
                console.log('No executables found, listing all files for debugging');
                reject(new Error(localization.format(localization.getUI('installer.noExecutableFound'), tempDir, allFiles.join('\n'))));
                return;
            }
            
            if (token.isCancellationRequested) {
                reject(new InstallCancelledError());
                return;
            }
            const targetPath = path.join(dumpstormDir, binaryInfo.binaryName);
            fs.copyFileSync(mainExecutable, targetPath);
            
            if (platform !== 'win32') {
                fs.chmodSync(targetPath, 0o755);
            }
            
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
