"use strict";
describe('Installer Logic Tests', () => {
    describe('Platform Detection', () => {
        test('detects Windows platform correctly', () => {
            const getBinaryName = (platform, baseName) => {
                return platform === 'win32' ? `${baseName}.exe` : baseName;
            };
            expect(getBinaryName('win32', 'llvm-nm')).toBe('llvm-nm.exe');
            expect(getBinaryName('win32', 'minidump_stackwalk')).toBe('minidump_stackwalk.exe');
        });
        test('detects Unix-like platforms correctly', () => {
            const getBinaryName = (platform, baseName) => {
                return platform === 'win32' ? `${baseName}.exe` : baseName;
            };
            expect(getBinaryName('linux', 'llvm-nm')).toBe('llvm-nm');
            expect(getBinaryName('darwin', 'llvm-nm')).toBe('llvm-nm');
            expect(getBinaryName('freebsd', 'llvm-nm')).toBe('llvm-nm');
        });
    });
    describe('URL Construction', () => {
        test('constructs download URLs correctly', () => {
            const getDownloadUrl = (platform, arch, toolName, version = 'latest') => {
                return `https://github.com/example/${toolName}/releases/download/${version}/${toolName}-${platform}-${arch}.tar.gz`;
            };
            const llvmUrl = getDownloadUrl('linux', 'x64', 'llvm');
            expect(llvmUrl).toBe('https://github.com/example/llvm/releases/download/latest/llvm-linux-x64.tar.gz');
            const windowsUrl = getDownloadUrl('win32', 'x64', 'breakpad');
            expect(windowsUrl).toBe('https://github.com/example/breakpad/releases/download/latest/breakpad-win32-x64.tar.gz');
        });
        test('handles different architectures', () => {
            const getDownloadUrl = (platform, arch, toolName) => {
                return `https://releases.example.com/${toolName}/${platform}/${arch}/download`;
            };
            expect(getDownloadUrl('linux', 'x64', 'tool')).toContain('x64');
            expect(getDownloadUrl('linux', 'arm64', 'tool')).toContain('arm64');
            expect(getDownloadUrl('darwin', 'arm64', 'tool')).toContain('arm64');
        });
    });
    describe('Path Operations', () => {
        test('constructs install paths correctly', () => {
            const path = require('path');
            const os = require('os');
            const getInstallPath = (toolName) => {
                return path.join(os.homedir(), '.dumpstorm', toolName, 'bin');
            };
            const llvmPath = getInstallPath('llvm-nm');
            expect(llvmPath).toContain('.dumpstorm');
            expect(llvmPath).toContain('llvm-nm');
            expect(llvmPath).toContain('bin');
        });
        test('handles temporary file paths', () => {
            const path = require('path');
            const os = require('os');
            const getTempPaths = (toolName) => {
                const tempDir = os.tmpdir();
                return {
                    zipFile: path.join(tempDir, `${toolName}.zip`),
                    tarFile: path.join(tempDir, `${toolName}.tar.gz`),
                    extractDir: path.join(tempDir, `${toolName}-extract`)
                };
            };
            const paths = getTempPaths('llvm-nm');
            expect(paths.zipFile).toContain('llvm-nm.zip');
            expect(paths.tarFile).toContain('llvm-nm.tar.gz');
            expect(paths.extractDir).toContain('llvm-nm-extract');
        });
    });
    describe('File Validation', () => {
        test('validates file existence logic', () => {
            const validateFile = (filePath, minSize = 1024) => {
                // Simulate file validation logic
                const mockFileExists = filePath.includes('valid');
                const mockFileSize = filePath.includes('large') ? 2048 : 512;
                if (!mockFileExists) {
                    return { valid: false, error: 'File does not exist' };
                }
                if (mockFileSize < minSize) {
                    return { valid: false, error: 'File is too small' };
                }
                return { valid: true, error: null };
            };
            expect(validateFile('/path/to/valid-large-file.zip')).toEqual({ valid: true, error: null });
            expect(validateFile('/path/to/nonexistent-file.zip')).toEqual({ valid: false, error: 'File does not exist' });
            expect(validateFile('/path/to/valid-small-file.zip')).toEqual({ valid: false, error: 'File is too small' });
        });
    });
    describe('Progress Reporting', () => {
        test('calculates progress percentages correctly', () => {
            const calculateProgress = (current, total) => {
                if (total === 0)
                    return 0;
                return Math.round((current / total) * 100);
            };
            expect(calculateProgress(50, 100)).toBe(50);
            expect(calculateProgress(25, 100)).toBe(25);
            expect(calculateProgress(100, 100)).toBe(100);
            expect(calculateProgress(33, 100)).toBe(33);
            expect(calculateProgress(0, 100)).toBe(0);
            expect(calculateProgress(0, 0)).toBe(0);
        });
        test('formats progress messages correctly', () => {
            const formatProgressMessage = (step, progress) => {
                return `${step}: ${progress}% complete`;
            };
            expect(formatProgressMessage('Downloading', 25)).toBe('Downloading: 25% complete');
            expect(formatProgressMessage('Extracting', 75)).toBe('Extracting: 75% complete');
            expect(formatProgressMessage('Installing', 100)).toBe('Installing: 100% complete');
        });
    });
    describe('Error Handling', () => {
        test('creates appropriate error messages', () => {
            const createErrorMessage = (operation, error) => {
                return `Failed to ${operation}: ${error}`;
            };
            expect(createErrorMessage('download', 'Network error')).toBe('Failed to download: Network error');
            expect(createErrorMessage('extract', 'Archive corrupted')).toBe('Failed to extract: Archive corrupted');
            expect(createErrorMessage('install', 'Permission denied')).toBe('Failed to install: Permission denied');
        });
        test('validates input parameters', () => {
            const validateInstallParams = (platform, arch) => {
                const validPlatforms = ['win32', 'linux', 'darwin'];
                const validArchs = ['x64', 'arm64', 'ia32'];
                if (!validPlatforms.includes(platform)) {
                    return { valid: false, error: `Unsupported platform: ${platform}` };
                }
                if (!validArchs.includes(arch)) {
                    return { valid: false, error: `Unsupported architecture: ${arch}` };
                }
                return { valid: true, error: null };
            };
            expect(validateInstallParams('linux', 'x64')).toEqual({ valid: true, error: null });
            expect(validateInstallParams('unsupported', 'x64')).toEqual({ valid: false, error: 'Unsupported platform: unsupported' });
            expect(validateInstallParams('linux', 'unsupported')).toEqual({ valid: false, error: 'Unsupported architecture: unsupported' });
        });
    });
    describe('Configuration Management', () => {
        test('creates tool configuration objects', () => {
            const createToolConfig = (toolName) => {
                const path = require('path');
                const os = require('os');
                return {
                    name: toolName,
                    installDir: path.join(os.homedir(), '.dumpstorm', toolName),
                    binaryName: toolName,
                    tempPrefix: `${toolName}-temp`
                };
            };
            const config = createToolConfig('llvm-nm');
            expect(config.name).toBe('llvm-nm');
            expect(config.installDir).toContain('.dumpstorm');
            expect(config.binaryName).toBe('llvm-nm');
            expect(config.tempPrefix).toBe('llvm-nm-temp');
        });
    });
});
//# sourceMappingURL=installer-logic.test.js.map