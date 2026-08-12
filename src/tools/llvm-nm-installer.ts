// LLVM-NM Installer module for DumpStorm extension
// Handles downloading and extracting llvm-nm tools

import * as fs from 'fs';
import * as path from 'path';
import { LLVM_NM_CONFIG, getLlvmNmBinaryName, getLlvmNmDownloadUrl } from '../config/config';
import { localization } from '../localization/localization';
import { BaseInstaller, BinaryInfo, ToolConfig } from './base-installer';

/**
 * LlvmNm installer implementation
 */
class LlvmNmInstaller extends BaseInstaller {
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
        return localization.getUI('startingLlvmNmInstallation');
    }

    protected getInstallingMessage(): string {
        return localization.getUI('installingLlvmNm');
    }

    protected getSuccessMessage(): string {
        return localization.getUI('llvmNmInstalledSuccessfully');
    }

    protected findExecutablesInDir(dir: string, platform: string): Record<string, string> {
        if (platform === 'win32') {
            return this.findLlvmNmExesInDir(dir);
        } else {
            return this.findLlvmNmBinariesInDir(dir);
        }
    }

    /**
     * Helper function to find llvm-nm executables in Windows directory
     */
    private findLlvmNmExesInDir(dir: string): { llvmNm?: string } {
        const found: { llvmNm?: string } = {};
        
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    console.log(`Searching in directory: ${fullPath}`);
                    // Look for the binaries in subdirectories first
                    const subdirFound = this.findLlvmNmExesInDir(fullPath);
                    if (subdirFound.llvmNm) found.llvmNm = subdirFound.llvmNm;
                } else if (item.name === 'llvm-nm.exe') {
                    console.log(`Found llvm-nm exe at: ${fullPath}`);
                    found.llvmNm = fullPath;
                }
            }
        } catch (error) {
            console.log(`Error searching directory ${dir}: ${error}`);
        }
        return found;
    }

    /**
     * Helper function to find llvm-nm binaries in Unix directory
     */
    private findLlvmNmBinariesInDir(dir: string): { llvmNm?: string } {
        const found: { llvmNm?: string } = {};
        
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    console.log(`Searching in directory: ${fullPath}`);
                    // Look for the binaries in subdirectories first
                    const subdirFound = this.findLlvmNmBinariesInDir(fullPath);
                    if (subdirFound.llvmNm) found.llvmNm = subdirFound.llvmNm;
                } else if (item.name === 'llvm-nm') {
                    console.log(`Found llvm-nm binary at: ${fullPath}`);
                    found.llvmNm = fullPath;
                }
            }
        } catch (error) {
            console.log(`Error searching directory ${dir}: ${error}`);
        }
        return found;
    }
}

/**
 * Install llvm-nm tool automatically
 */
export async function installLlvmNm(): Promise<boolean> {
    const installer = new LlvmNmInstaller();
    return installer.install();
}
