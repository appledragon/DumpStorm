// Minidump-stackwalk installer with curl-based download (more reliable on Windows)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MINIDUMP_STACKWALK_CONFIG, getBinaryName, getDownloadUrl } from '../config/config';
import { localization } from '../localization/localization';
import { BinaryInfo, ToolConfig } from './base-installer';
import { CurlBaseInstaller } from './curl-installer';

/**
 * Minidump Stackwalk curl installer implementation
 */
class MinidumpStackwalkCurlInstaller extends CurlBaseInstaller {
    protected getToolConfig(): ToolConfig {
        return MINIDUMP_STACKWALK_CONFIG;
    }

    protected getBinaryInfo(platform: string, arch: string): BinaryInfo {
        return {
            downloadUrl: getDownloadUrl(platform, arch),
            binaryName: getBinaryName(platform),
            toolName: 'minidump_stackwalk'
        };
    }

    protected getStartingInstallationMessage(): string {
        const platform = os.platform();
        const installMessage = localization.format(localization.getUI('installWillDownload'), platform, path.join(os.homedir(), '.dumpstorm', 'bin'));
        return installMessage;
    }

    protected getInstallingMessage(): string {
        return localization.getUI('installingMinidumpStackwalkAlt');
    }

    protected getSuccessMessage(): string {
        return localization.getUI('minidumpStackwalkInstalledSuccessfully');
    }

    protected findExecutablesInDir(dir: string, platform: string): Record<string, string> {
        const filename = platform === 'win32' ? 'minidump_stackwalk.exe' : 'minidump_stackwalk';
        const foundPath = this.findExecutableInDirectory(dir, filename);
        return foundPath ? { minidump_stackwalk: foundPath } : {};
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
    public async install(): Promise<boolean> {
        const choice = await vscode.window.showInformationMessage(
            this.getStartingInstallationMessage(),
            { modal: true },
            localization.getUI('yesInstall'),
            localization.getUI('cancel')
        );
        
        if (choice !== localization.getUI('yesInstall')) {
            return false;
        }

        return this.installConfirmed();
    }
}

/**
 * Curl-based installer with better error handling and reliability
 */
export async function installMinidumpStackwalkWithCurl(): Promise<boolean> {
    const installer = new MinidumpStackwalkCurlInstaller();
    return installer.install();
}
