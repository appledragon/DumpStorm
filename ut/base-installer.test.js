"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const base_installer_1 = require("../src/tools/base-installer");
// Mock VS Code
jest.mock('vscode', () => ({
    window: {
        showInformationMessage: jest.fn().mockResolvedValue('OK'),
        showErrorMessage: jest.fn().mockResolvedValue('OK'),
        withProgress: jest.fn().mockImplementation((options, task) => task())
    },
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue(undefined)
        })
    },
    ProgressLocation: {
        Notification: 15
    },
    Uri: {
        file: jest.fn((filePath) => ({ fsPath: filePath, path: filePath }))
    }
}));
// Mock fs
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    chmodSync: jest.fn(),
    createWriteStream: jest.fn(),
    readdirSync: jest.fn(),
    statSync: jest.fn()
}));
// Mock https
jest.mock('https', () => ({
    get: jest.fn()
}));
// Mock child_process
jest.mock('child_process', () => ({
    spawn: jest.fn(),
    execSync: jest.fn()
}));
// Mock localization
jest.mock('../src/localization/localization', () => ({
    localization: {
        getUI: jest.fn((key) => {
            const messages = {
                'installingTool': 'Installing tool...',
                'toolInstalledSuccessfully': 'Tool installed successfully!',
                'yesInstall': 'Yes, install',
                'cancel': 'Cancel',
                'installWillDownload': 'This will download tool for %s to %s',
                'installationStarting': 'Installation starting...'
            };
            return messages[key] || key;
        }),
        format: jest.fn((template, ...args) => {
            return template.replace(/%s/g, () => args.shift());
        })
    }
}));
// Test implementation of BaseInstaller
class TestInstaller extends base_installer_1.BaseInstaller {
    getToolConfig() {
        return {
            INSTALL_PATHS: {
                DUMPSTORM_BIN: path.join(os.homedir(), '.test-tool', 'bin'),
                TEMP_ZIP: path.join(os.tmpdir(), 'test-tool.zip'),
                TEMP_TAR: path.join(os.tmpdir(), 'test-tool.tar.gz'),
                TEMP_EXTRACT: path.join(os.tmpdir(), 'test-tool-extract')
            }
        };
    }
    getBinaryInfo(platform, arch) {
        return {
            downloadUrl: `https://example.com/test-tool-${platform}-${arch}.tar.gz`,
            binaryName: platform === 'win32' ? 'test-tool.exe' : 'test-tool',
            toolName: 'test-tool'
        };
    }
    getStartingInstallationMessage() {
        return 'Starting test tool installation';
    }
    getInstallingMessage() {
        return 'Installing test tool';
    }
    getSuccessMessage() {
        return 'Test tool installed successfully';
    }
    findExecutablesInDir(dir, platform) {
        const filename = platform === 'win32' ? 'test-tool.exe' : 'test-tool';
        const fullPath = path.join(dir, filename);
        return { testTool: fullPath };
    }
    // Expose protected methods for testing
    testGetToolConfig() {
        return this.getToolConfig();
    }
    testGetBinaryInfo(platform, arch) {
        return this.getBinaryInfo(platform, arch);
    }
    testFindExecutablesInDir(dir, platform) {
        return this.findExecutablesInDir(dir, platform);
    }
    testValidateDownloadedFile(tempFile, reject) {
        return this.validateDownloadedFile(tempFile, reject);
    }
    testListAllFiles(dir, prefix = '') {
        return this.listAllFiles(dir, prefix);
    }
    testCleanupTempFiles(tempFile, tempDir) {
        return this.cleanupTempFiles(tempFile, tempDir);
    }
}
describe('BaseInstaller', () => {
    let installer;
    let mockFs;
    beforeEach(() => {
        installer = new TestInstaller();
        mockFs = fs;
        jest.clearAllMocks();
    });
    describe('getToolConfig', () => {
        it('should return correct tool configuration', () => {
            const config = installer.testGetToolConfig();
            expect(config.INSTALL_PATHS.DUMPSTORM_BIN).toContain('.test-tool');
            expect(config.INSTALL_PATHS.TEMP_ZIP).toContain('test-tool.zip');
            expect(config.INSTALL_PATHS.TEMP_TAR).toContain('test-tool.tar.gz');
            expect(config.INSTALL_PATHS.TEMP_EXTRACT).toContain('test-tool-extract');
        });
    });
    describe('getBinaryInfo', () => {
        it('should return correct binary info for Linux', () => {
            const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
            expect(binaryInfo.downloadUrl).toContain('linux-x64');
            expect(binaryInfo.binaryName).toBe('test-tool');
            expect(binaryInfo.toolName).toBe('test-tool');
        });
        it('should return correct binary info for Windows', () => {
            const binaryInfo = installer.testGetBinaryInfo('win32', 'x64');
            expect(binaryInfo.downloadUrl).toContain('win32-x64');
            expect(binaryInfo.binaryName).toBe('test-tool.exe');
            expect(binaryInfo.toolName).toBe('test-tool');
        });
        it('should return correct binary info for macOS', () => {
            const binaryInfo = installer.testGetBinaryInfo('darwin', 'x64');
            expect(binaryInfo.downloadUrl).toContain('darwin-x64');
            expect(binaryInfo.binaryName).toBe('test-tool');
            expect(binaryInfo.toolName).toBe('test-tool');
        });
    });
    describe('findExecutablesInDir', () => {
        it('should find executable on Unix systems', () => {
            const testDir = '/test/dir';
            const executables = installer.testFindExecutablesInDir(testDir, 'linux');
            expect(executables.testTool).toBe(path.join(testDir, 'test-tool'));
        });
        it('should find executable on Windows', () => {
            const testDir = 'C:\\test\\dir';
            const executables = installer.testFindExecutablesInDir(testDir, 'win32');
            expect(executables.testTool).toBe(path.join(testDir, 'test-tool.exe'));
        });
    });
    describe('validateDownloadedFile', () => {
        it('should return true for valid file', () => {
            const tempFile = '/tmp/test-file.zip';
            mockFs.existsSync.mockReturnValue(true);
            mockFs.statSync.mockReturnValue({ size: 1024 });
            const rejectFn = jest.fn();
            const isValid = installer.testValidateDownloadedFile(tempFile, rejectFn);
            expect(isValid).toBe(true);
            expect(rejectFn).not.toHaveBeenCalled();
        });
        it('should return false for non-existent file', () => {
            const tempFile = '/tmp/non-existent.zip';
            mockFs.existsSync.mockReturnValue(false);
            const rejectFn = jest.fn();
            const isValid = installer.testValidateDownloadedFile(tempFile, rejectFn);
            expect(isValid).toBe(false);
            expect(rejectFn).toHaveBeenCalled();
        });
        it('should return false for empty file', () => {
            const tempFile = '/tmp/empty-file.zip';
            mockFs.existsSync.mockReturnValue(true);
            mockFs.statSync.mockReturnValue({ size: 0 });
            const rejectFn = jest.fn();
            const isValid = installer.testValidateDownloadedFile(tempFile, rejectFn);
            expect(isValid).toBe(false);
            expect(rejectFn).toHaveBeenCalled();
        });
    });
    describe('listAllFiles', () => {
        it('should list files in directory', () => {
            const testDir = '/test/dir';
            mockFs.readdirSync.mockReturnValue(['file1.txt', 'file2.txt']);
            mockFs.statSync.mockReturnValue({ isDirectory: () => false });
            const files = installer.testListAllFiles(testDir);
            expect(files).toHaveLength(2);
            expect(files).toContain('file1.txt');
            expect(files).toContain('file2.txt');
        });
    });
    describe('cleanupTempFiles', () => {
        it('should attempt to cleanup temp files', () => {
            const tempFile = '/tmp/test.zip';
            const tempDir = '/tmp/test-extract';
            // Mock fs.unlinkSync and fs.rmSync
            const unlinkSync = jest.fn();
            const rmSync = jest.fn();
            fs.unlinkSync = unlinkSync;
            fs.rmSync = rmSync;
            installer.testCleanupTempFiles(tempFile, tempDir);
            // Should not throw errors even if cleanup fails
            expect(() => installer.testCleanupTempFiles(tempFile, tempDir)).not.toThrow();
        });
    });
    describe('messages', () => {
        it('should return correct starting installation message', () => {
            const message = installer['getStartingInstallationMessage']();
            expect(message).toBe('Starting test tool installation');
        });
        it('should return correct installing message', () => {
            const message = installer['getInstallingMessage']();
            expect(message).toBe('Installing test tool');
        });
        it('should return correct success message', () => {
            const message = installer['getSuccessMessage']();
            expect(message).toBe('Test tool installed successfully');
        });
    });
});
//# sourceMappingURL=base-installer.test.js.map