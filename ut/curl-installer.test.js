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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const curl_installer_1 = require("../src/tools/curl-installer");
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
// Mock child_process
jest.mock('child_process', () => ({
    spawn: jest.fn()
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
                'installationStarting': 'Installation starting...',
                'downloadingFile': 'Downloading file...',
                'extractingFiles': 'Extracting files...',
                'settingPermissions': 'Setting permissions...'
            };
            return messages[key] || key;
        }),
        format: jest.fn((template, ...args) => {
            return template.replace(/%s/g, () => args.shift());
        })
    }
}));
// Test implementation of CurlBaseInstaller
class TestCurlInstaller extends curl_installer_1.CurlBaseInstaller {
    getToolConfig() {
        return {
            INSTALL_PATHS: {
                DUMPSTORM_BIN: path.join(os.homedir(), '.test-curl-tool', 'bin'),
                TEMP_ZIP: path.join(os.tmpdir(), 'test-curl-tool.zip'),
                TEMP_TAR: path.join(os.tmpdir(), 'test-curl-tool.tar.gz'),
                TEMP_EXTRACT: path.join(os.tmpdir(), 'test-curl-tool-extract')
            }
        };
    }
    getBinaryInfo(platform, arch) {
        return {
            downloadUrl: `https://example.com/test-curl-tool-${platform}-${arch}.tar.gz`,
            binaryName: platform === 'win32' ? 'test-curl-tool.exe' : 'test-curl-tool',
            toolName: 'test-curl-tool'
        };
    }
    getStartingInstallationMessage() {
        return 'Starting test curl tool installation';
    }
    getInstallingMessage() {
        return 'Installing test curl tool';
    }
    getSuccessMessage() {
        return 'Test curl tool installed successfully';
    }
    findExecutablesInDir(dir, platform) {
        const filename = platform === 'win32' ? 'test-curl-tool.exe' : 'test-curl-tool';
        const fullPath = path.join(dir, filename);
        return { testCurlTool: fullPath };
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
    // Test the curl installation method
    testInstallWithCurl(binaryInfo, progress, resolve, reject, token) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.installWithCurl(binaryInfo, progress, resolve, reject, token);
        });
    }
}
describe('CurlBaseInstaller', () => {
    let installer;
    let mockFs;
    let mockChildProcess;
    beforeEach(() => {
        installer = new TestCurlInstaller();
        mockFs = require('fs');
        mockChildProcess = require('child_process');
        jest.clearAllMocks();
    });
    describe('getToolConfig', () => {
        it('should return correct tool configuration', () => {
            const config = installer.testGetToolConfig();
            expect(config.INSTALL_PATHS.DUMPSTORM_BIN).toContain('.test-curl-tool');
            expect(config.INSTALL_PATHS.TEMP_ZIP).toContain('test-curl-tool.zip');
            expect(config.INSTALL_PATHS.TEMP_TAR).toContain('test-curl-tool.tar.gz');
            expect(config.INSTALL_PATHS.TEMP_EXTRACT).toContain('test-curl-tool-extract');
        });
    });
    describe('getBinaryInfo', () => {
        it('should return correct binary info for different platforms', () => {
            const linuxInfo = installer.testGetBinaryInfo('linux', 'x64');
            expect(linuxInfo.downloadUrl).toContain('linux-x64');
            expect(linuxInfo.binaryName).toBe('test-curl-tool');
            expect(linuxInfo.toolName).toBe('test-curl-tool');
            const windowsInfo = installer.testGetBinaryInfo('win32', 'x64');
            expect(windowsInfo.downloadUrl).toContain('win32-x64');
            expect(windowsInfo.binaryName).toBe('test-curl-tool.exe');
            expect(windowsInfo.toolName).toBe('test-curl-tool');
        });
    });
    describe('findExecutablesInDir', () => {
        it('should find executable for different platforms', () => {
            const testDir = '/test/dir';
            const linuxExecs = installer.testFindExecutablesInDir(testDir, 'linux');
            expect(linuxExecs.testCurlTool).toBe(path.join(testDir, 'test-curl-tool'));
            const windowsExecs = installer.testFindExecutablesInDir(testDir, 'win32');
            expect(windowsExecs.testCurlTool).toBe(path.join(testDir, 'test-curl-tool.exe'));
        });
    });
    describe('installWithCurl', () => {
        let mockProgress;
        let mockToken;
        let mockResolve;
        let mockReject;
        beforeEach(() => {
            mockProgress = { report: jest.fn() };
            mockToken = { isCancellationRequested: false };
            mockResolve = jest.fn();
            mockReject = jest.fn();
        });
        it('should handle successful curl download', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock successful curl process
            const mockSpawn = {
                on: jest.fn((event, callback) => {
                    if (event === 'close') {
                        setTimeout(() => callback(0), 100); // Success
                    }
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            };
            mockChildProcess.spawn.mockReturnValue(mockSpawn);
            // Mock file system operations
            mockFs.existsSync.mockReturnValue(true);
            mockFs.statSync.mockReturnValue({ size: 1024 });
            mockFs.readdirSync.mockReturnValue(['test-curl-tool']);
            const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
            // Start the installation
            const installPromise = installer.testInstallWithCurl(binaryInfo, mockProgress, mockResolve, mockReject, mockToken);
            // Wait for the installation to complete
            yield new Promise(resolve => setTimeout(resolve, 200));
            expect(mockChildProcess.spawn).toHaveBeenCalled();
            expect(mockProgress.report).toHaveBeenCalled();
        }));
        it('should handle curl download failure', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock failed curl process
            const mockSpawn = {
                on: jest.fn((event, callback) => {
                    if (event === 'close') {
                        setTimeout(() => callback(1), 100); // Failure
                    }
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            };
            mockChildProcess.spawn.mockReturnValue(mockSpawn);
            const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
            // Start the installation
            const installPromise = installer.testInstallWithCurl(binaryInfo, mockProgress, mockResolve, mockReject, mockToken);
            // Wait for the installation to complete
            yield new Promise(resolve => setTimeout(resolve, 200));
            expect(mockChildProcess.spawn).toHaveBeenCalled();
            expect(mockReject).toHaveBeenCalledWith(expect.stringContaining('curl'));
        }));
        it('should handle cancellation', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock cancellation token
            mockToken.isCancellationRequested = true;
            const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
            yield installer.testInstallWithCurl(binaryInfo, mockProgress, mockResolve, mockReject, mockToken);
            expect(mockReject).toHaveBeenCalledWith('Installation cancelled by user');
        }));
        it('should report progress during installation', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock successful curl process
            const mockSpawn = {
                on: jest.fn((event, callback) => {
                    if (event === 'close') {
                        setTimeout(() => callback(0), 100);
                    }
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            };
            mockChildProcess.spawn.mockReturnValue(mockSpawn);
            mockFs.existsSync.mockReturnValue(true);
            mockFs.statSync.mockReturnValue({ size: 1024 });
            mockFs.readdirSync.mockReturnValue(['test-curl-tool']);
            const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
            yield installer.testInstallWithCurl(binaryInfo, mockProgress, mockResolve, mockReject, mockToken);
            // Wait for async operations
            yield new Promise(resolve => setTimeout(resolve, 200));
            // Verify progress was reported multiple times
            expect(mockProgress.report).toHaveBeenCalledWith(expect.objectContaining({
                increment: expect.any(Number),
                message: expect.any(String)
            }));
        }));
    });
    describe('messages', () => {
        it('should return correct message strings', () => {
            expect(installer['getStartingInstallationMessage']()).toBe('Starting test curl tool installation');
            expect(installer['getInstallingMessage']()).toBe('Installing test curl tool');
            expect(installer['getSuccessMessage']()).toBe('Test curl tool installed successfully');
        });
    });
});
//# sourceMappingURL=curl-installer.test.js.map