// LLVM-NM Installer with curl-based download (more reliable on Windows)
// Based on the successful pattern from minidump-stackwalk-installer-curl.ts

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LLVM_NM_CONFIG, getLlvmNmBinaryName, getLlvmNmDownloadUrl } from '../config/config';
import { localization } from '../localization/localization';
import { BinaryInfo, ToolConfig } from './base-installer';
import { CurlBaseInstaller } from './curl-installer';

/**
 * LLVM-NM curl installer implementation
 */
class LlvmNmCurlInstaller extends CurlBaseInstaller {
    protected getToolConfig(): ToolConfig {
        return LLVM_NM_CONFIG;
    }

    protected getBinaryInfo(platform: string, arch: string): BinaryInfo {
        return {
            downloadUrl: getLlvmNmDownloadUrl(platform, arch),
            binaryName: getLlvmNmBinaryName(platform),
            toolName: 'llvm-nm'
        };
    }

    protected getStartingInstallationMessage(): string {
        const platform = os.platform();
        const installMessage = localization.format(localization.getUI('installWillDownload'), platform, path.join(os.homedir(), '.dumpstorm', 'bin'));
        return installMessage;
    }

    protected getInstallingMessage(): string {
        return localization.getUI('installingLlvmNm');
    }

    protected getSuccessMessage(): string {
        return localization.getUI('llvmNmInstalledSuccessfully');
    }

    protected findExecutablesInDir(dir: string, platform: string): Record<string, string> {
        const filename = platform === 'win32' ? 'llvm-nm.exe' : 'llvm-nm';
        const foundPath = this.findExecutableInDirectory(dir, filename);
        return foundPath ? { llvmNm: foundPath } : {};
    }

    /**
     * Find executable in directory recursively
     */
    private findExecutableInDirectory(dir: string, filename: string): string | null {
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            
            // First, check in current directory
            for (const item of items) {
                if (item.isFile() && item.name === filename) {
                    const fullPath = path.join(dir, item.name);
                    console.log(`Found executable: ${fullPath}`);
                    return fullPath;
                }
            }
            
            // Then, check subdirectories recursively
            for (const item of items) {
                if (item.isDirectory()) {
                    const subDir = path.join(dir, item.name);
                    const found = this.findExecutableInDirectory(subDir, filename);
                    if (found) {
                        return found;
                    }
                }
            }
            
            return null;
        } catch (error) {
            console.log(`Error searching directory ${dir}: ${error}`);
            return null;
        }
    }

    /**
     * Override install method to add user confirmation
     */
    public async install(): Promise<void> {
        const choice = await vscode.window.showInformationMessage(
            this.getStartingInstallationMessage(),
            { modal: true },
            localization.getUI('yesInstall'),
            localization.getUI('cancel')
        );
        
        if (choice !== localization.getUI('yesInstall')) {
            return;
        }

        // Call parent install method
        await super.install();
    }
}

/**
 * Install llvm-nm tool using curl (more reliable method)
 */
export async function installLlvmNmWithCurl(): Promise<void> {
    const installer = new LlvmNmCurlInstaller();
    await installer.install();
}
