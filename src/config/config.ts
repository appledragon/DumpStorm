// Configuration constants for Minidump Parser extension
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const MINIDUMP_STACKWALK_CONFIG = {
    VERSION: 'nightly',
    BASE_URL: 'https://github.com/appledragon/breakpad/releases/download',
    
    // Download URLs for different platforms
    DOWNLOAD_URLS: {
        WIN32: 'https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-windows-x64.zip',
        DARWIN_ARM64: 'https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-macos-arm64.tar.gz',
        DARWIN_X64: 'https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-macos-x86_64.tar.gz',
        LINUX_X64: 'https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-linux-x86_64.tar.gz'
    },
    
    // Binary names for different platforms
    BINARY_NAMES: {
        MINIDUMP_STACKWALK: {
            WIN32: 'minidump_stackwalk.exe',
            UNIX: 'minidump_stackwalk'
        }
    },
    
    // Installation paths
    INSTALL_PATHS: {
        DUMPSTORM_BIN: '.dumpstorm/bin',
        TEMP_ZIP: 'breakpad-temp.zip',
        TEMP_EXTRACT: 'breakpad-extract'
    }
};

export const LLVM_NM_CONFIG = {
    VERSION: 'nightly',
    BASE_URL: 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download',
    
    // Download URLs for different platforms  
    DOWNLOAD_URLS: {
        WIN32_X64: 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-windows-x64.zip',
        WIN32_X86: 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-windows-x86.zip',
        DARWIN_ARM64: 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-macos-arm64.tar.gz',
        DARWIN_X64: 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-macos-x86_64.tar.gz',
        LINUX_X64: 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-linux-x86_64.tar.gz'
    },
    
    // Binary names for different platforms
    BINARY_NAMES: {
        LLVM_NM: {
            WIN32: 'llvm-nm.exe',
            UNIX: 'llvm-nm'
        }
    },
    
    // Installation paths
    INSTALL_PATHS: {
        DUMPSTORM_BIN: '.dumpstorm/bin',
        TEMP_ZIP: 'llvm-nm-temp.zip',
        TEMP_TAR: 'llvm-nm-temp.tar.gz',
        TEMP_EXTRACT: 'llvm-nm-extract'
    }
};

// Helper function to get download URL based on platform and architecture
export function getDownloadUrl(platform: string, arch: string): string {
    const urls = MINIDUMP_STACKWALK_CONFIG.DOWNLOAD_URLS;
    
    switch (platform) {
        case 'win32':
            return urls.WIN32;
        case 'darwin':
            return arch === 'arm64' ? urls.DARWIN_ARM64 : urls.DARWIN_X64;
        case 'linux':
            return urls.LINUX_X64;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

// Helper function to get llvm-nm download URL based on platform and architecture
export function getLlvmNmDownloadUrl(platform: string, arch: string): string {
    const urls = LLVM_NM_CONFIG.DOWNLOAD_URLS;
    
    switch (platform) {
        case 'win32':
            return arch === 'x64' ? urls.WIN32_X64 : urls.WIN32_X86;
        case 'darwin':
            return arch === 'arm64' ? urls.DARWIN_ARM64 : urls.DARWIN_X64;
        case 'linux':
            return urls.LINUX_X64;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

// Helper function to get binary name based on platform
export function getBinaryName(platform: string, tool: 'minidump_stackwalk' = 'minidump_stackwalk'): string {
    const binaryNames = MINIDUMP_STACKWALK_CONFIG.BINARY_NAMES.MINIDUMP_STACKWALK;
    
    return platform === 'win32' ? binaryNames.WIN32 : binaryNames.UNIX;
}

// Helper function to get llvm-nm binary name based on platform
export function getLlvmNmBinaryName(platform: string): string {
    const binaryNames = LLVM_NM_CONFIG.BINARY_NAMES.LLVM_NM;
    
    return platform === 'win32' ? binaryNames.WIN32 : binaryNames.UNIX;
}

// Helper function to check if nm command is available
export function isNmAvailable(): boolean {
    return findNmBinaryPath() !== null;
}

// Helper function to get the preferred nm command
export function getNmCommand(): string {
    const nmPath = findNmBinaryPath();
    if (nmPath) {
        return nmPath;
    }
    throw new Error('Neither nm nor llvm-nm command found');
}

// Shared logic: find the best available nm binary path
function findNmBinaryPath(): string | null {
    // First check if user has specified a custom llvm-nm path
    const customLlvmNmPath = getCustomLlvmNmPath();
    if (customLlvmNmPath && isValidLlvmNmPath(customLlvmNmPath)) {
        return customLlvmNmPath;
    }
    
    // Then check if user has specified a custom nm path
    const customNmPath = getCustomNmPath();
    if (customNmPath && isValidNmPath(customNmPath)) {
        return customNmPath;
    }
    
    // Check if auto-installed llvm-nm exists in ~/.dumpstorm/bin
    try {
        const platform = os.platform();
        const binaryName = getLlvmNmBinaryName(platform);
        const autoInstalledPath = path.join(os.homedir(), LLVM_NM_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN, binaryName);
        if (fs.existsSync(autoInstalledPath)) {
            return autoInstalledPath;
        }
    } catch (error) {
        // Continue to check system paths
    }
    
    try {
        const platform = os.platform();
        const whichCommand = platform === 'win32' ? 'where' : 'which';
        
        // Try regular nm first
        try {
            const nmResult = execSync(`${whichCommand} nm`, { encoding: 'utf8' }).trim();
            if (nmResult && nmResult.length > 0) {
                return 'nm';
            }
        } catch (error) {
            // nm not found, continue to try llvm-nm
        }
        
        // Try llvm-nm if nm is not available
        try {
            const llvmNmResult = execSync(`${whichCommand} llvm-nm`, { encoding: 'utf8' }).trim();
            if (llvmNmResult && llvmNmResult.length > 0) {
                return 'llvm-nm';
            }
        } catch (error) {
            // llvm-nm not found either
        }
    } catch (error) {
        // Unexpected error
    }
    
    return null;
}

// Default configuration values
export const DEFAULT_CONFIG = {
    SYMBOL_PATH: os.platform() === 'win32'
        ? path.join(os.homedir(), '.dumpstorm', 'symbols')
        : '/tmp/symbols',
    HOME_SYMBOL_PATH: 'symbols'
};

// Helper function to get custom tool path from VS Code settings
function getCustomSettingPath(settingName: string): string | undefined {
    const config = vscode.workspace.getConfiguration('minidump-parser');
    return config.get(settingName) as string | undefined;
}

// Helper function to get custom minidump_stackwalk path from VS Code settings
export function getCustomMinidumpStackwalkPath(): string | undefined {
    return getCustomSettingPath('customMinidumpStackwalkPath');
}

/**
 * When false (default), contiguous low-confidence stack-scanning frames in the
 * crashing thread are folded into a single summary line. Users who want the
 * full unfiltered output can toggle this setting on.
 */
export function getShowStackScanFrames(): boolean {
    try {
        const config = vscode.workspace.getConfiguration('minidump-parser');
        return config.get<boolean>('showStackScanFrames') ?? false;
    } catch {
        return false;
    }
}

// Helper function to get custom llvm-nm path from VS Code settings
export function getCustomLlvmNmPath(): string | undefined {
    return getCustomSettingPath('customLlvmNmPath');
}

// Helper function to get custom nm path from VS Code settings
export function getCustomNmPath(): string | undefined {
    return getCustomSettingPath('customNmPath');
}

// Helper function to get custom Breakpad dump_syms path from VS Code settings
export function getCustomDumpSymsPath(): string | undefined {
    return getCustomSettingPath('customDumpSymsPath');
}

// Helper function to get custom llvm-undname path from VS Code settings
export function getCustomLlvmUndnamePath(): string | undefined {
    return getCustomSettingPath('customLlvmUndnamePath');
}

// Helper function to check if a path points to a valid executable
function isValidExecutablePath(customPath: string): boolean {
    try {
        if (!fs.existsSync(customPath)) {
            return false;
        }
        
        const stats = fs.statSync(customPath);
        if (!stats.isFile()) {
            return false;
        }
        
        // Check if it's executable (on Unix-like systems)
        if (os.platform() !== 'win32') {
            try {
                fs.accessSync(customPath, fs.constants.X_OK);
            } catch (error) {
                return false;
            }
        }
        
        return true;
    } catch (error) {
        return false;
    }
}

// Helper function to check if a custom minidump_stackwalk path is valid
export function isValidMinidumpStackwalkPath(customPath: string): boolean {
    return isValidExecutablePath(customPath);
}

// Helper function to check if a custom llvm-nm path is valid
export function isValidLlvmNmPath(customPath: string): boolean {
    return isValidExecutablePath(customPath);
}

// Helper function to check if a custom nm path is valid
export function isValidNmPath(customPath: string): boolean {
    return isValidExecutablePath(customPath);
}

// Helper function to check a custom dump_syms executable
export function isValidDumpSymsPath(customPath: string): boolean {
    return isValidExecutablePath(customPath);
}

// Helper function to check a custom llvm-undname executable
export function isValidLlvmUndnamePath(customPath: string): boolean {
    return isValidExecutablePath(customPath);
}

// Dynamic library file extensions for different platforms
export const DYNAMIC_LIBRARY_EXTENSIONS = {
    win32: ['.dll', '.exe'],
    darwin: ['.dylib', '.so', '.app'],
    linux: ['.so'],
    default: ['.so', '.dylib', '.dll', '.exe', '.app']
};

// Helper function to get dynamic library extensions for current platform
export function getDynamicLibraryExtensions(): string[] {
    const platform = os.platform();
    return DYNAMIC_LIBRARY_EXTENSIONS[platform as keyof typeof DYNAMIC_LIBRARY_EXTENSIONS] || DYNAMIC_LIBRARY_EXTENSIONS.default;
}

// Helper function to get dynamic library extensions for all platforms (for cross-platform analysis)
export function getAllDynamicLibraryExtensions(): string[] {
    return DYNAMIC_LIBRARY_EXTENSIONS.default;
}

// Helper function to check if a file is a dynamic library
export function isDynamicLibrary(filePath: string): boolean {
    const extensions = getDynamicLibraryExtensions();
    const ext = path.extname(filePath).toLowerCase();
    return extensions.includes(ext);
}

// Helper function to check if a file is a dynamic library (cross-platform)
export function isDynamicLibraryCrossPlatform(filePath: string): boolean {
    const extensions = getAllDynamicLibraryExtensions();
    const ext = path.extname(filePath).toLowerCase();
    return extensions.includes(ext);
}

// Helper function to recursively find all dynamic libraries in a directory
export function findDynamicLibraries(directoryPath: string, recursive: boolean = true): string[] {
    const libraries: string[] = [];
    
    try {
        if (!fs.existsSync(directoryPath)) {
            return libraries;
        }
        
        const items = fs.readdirSync(directoryPath, { withFileTypes: true });
        
        for (const item of items) {
            const fullPath = path.join(directoryPath, item.name);
            
            if (item.isDirectory() && recursive) {
                // Recursively search subdirectories
                libraries.push(...findDynamicLibraries(fullPath, recursive));
            } else if (item.isFile() && isDynamicLibraryCrossPlatform(fullPath)) {
                // Add dynamic library to the list (using cross-platform detection)
                libraries.push(fullPath);
            }
        }
    } catch (error) {
        console.log(`Error scanning directory ${directoryPath}: ${error}`);
    }
    
    return libraries;
}
