// Installer module for DumpStorm extension
// Handles downloading and extracting minidump_stackwalk tools

import * as fs from 'fs';
import * as path from 'path';
import { MINIDUMP_STACKWALK_CONFIG, getBinaryName, getDownloadUrl } from '../config/config';
import { localization } from '../localization/localization';
import { BaseInstaller, BinaryInfo, ToolConfig } from './base-installer';

/**
 * MinidumpStackwalk installer implementation
 */
class MinidumpStackwalkInstaller extends BaseInstaller {
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
        return localization.getUI('startingInstallation');
    }

    protected getInstallingMessage(): string {
        return localization.getUI('installingMinidumpStackwalk');
    }

    protected getSuccessMessage(): string {
        return localization.getUI('minidumpStackwalkInstalledSuccessfully');
    }

    protected findExecutablesInDir(dir: string, platform: string): Record<string, string> {
        if (platform === 'win32') {
            return this.findExesInDir(dir);
        } else {
            return this.findBinariesInDir(dir);
        }
    }

    /**
     * Helper function to find executables in Windows directory
     */
    private findExesInDir(dir: string): { minidump_stackwalk?: string } {
        const found: { minidump_stackwalk?: string } = {};
        
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    console.log(`Searching in directory: ${fullPath}`);
                    // Look for the binaries in subdirectories first
                    const subdirFound = this.findExesInDir(fullPath);
                    if (subdirFound.minidump_stackwalk) found.minidump_stackwalk = subdirFound.minidump_stackwalk;
                } else if (item.name === 'minidump_stackwalk.exe' || item.name === 'minidump-stackwalk.exe') {
                    console.log(`Found minidump_stackwalk exe at: ${fullPath}`);
                    found.minidump_stackwalk = fullPath;
                }
            }
        } catch (error) {
            console.log(`Error searching directory ${dir}: ${error}`);
        }
        return found;
    }

    /**
     * Helper function to find binaries in Unix directory
     */
    private findBinariesInDir(dir: string): { minidump_stackwalk?: string } {
        const found: { minidump_stackwalk?: string } = {};
        
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    console.log(`Searching in directory: ${fullPath}`);
                    // Look for the binaries in subdirectories first
                    const subdirFound = this.findBinariesInDir(fullPath);
                    if (subdirFound.minidump_stackwalk) found.minidump_stackwalk = subdirFound.minidump_stackwalk;
                } else if (item.name === 'minidump_stackwalk' || item.name === 'minidump-stackwalk') {
                    console.log(`Found minidump_stackwalk binary at: ${fullPath}`);
                    found.minidump_stackwalk = fullPath;
                }
            }
        } catch (error) {
            console.log(`Error searching directory ${dir}: ${error}`);
        }
        return found;
    }
}

/**
 * Install minidump_stackwalk tool automatically
 */
export async function installMinidumpStackwalk(): Promise<boolean> {
    const installer = new MinidumpStackwalkInstaller();
    return installer.install();
}
