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
const llvm_nm_installer_curl_1 = require("../src/tools/llvm-nm-installer-curl");
// Mock VS Code
jest.mock('vscode', () => ({
    window: {
        showInformationMessage: jest.fn().mockResolvedValue('Yes, install'),
        showErrorMessage: jest.fn().mockResolvedValue('OK'),
        withProgress: jest.fn().mockImplementation((options, task) => {
            // Mock the progress function
            const progress = {
                report: jest.fn()
            };
            const token = {
                isCancellationRequested: false
            };
            return task(progress, token);
        })
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
// Mock config
jest.mock('../src/config/config', () => ({
    LLVM_NM_CONFIG: {
        INSTALL_PATHS: {
            DUMPSTORM_BIN: path.join(os.homedir(), '.dumpstorm', 'bin'),
            TEMP_ZIP: path.join(os.tmpdir(), 'llvm-nm.zip'),
            TEMP_TAR: path.join(os.tmpdir(), 'llvm-nm.tar.gz'),
            TEMP_EXTRACT: path.join(os.tmpdir(), 'llvm-nm-extract')
        }
    },
    getLlvmNmBinaryName: jest.fn((platform) => {
        return platform === 'win32' ? 'llvm-nm.exe' : 'llvm-nm';
    }),
    getLlvmNmDownloadUrl: jest.fn((platform, arch) => {
        return `https://example.com/llvm-nm-${platform}-${arch}.tar.gz`;
    })
}));
// Mock localization
jest.mock('../src/localization/localization', () => ({
    localization: {
        getUI: jest.fn((key) => {
            const messages = {
                'installingLlvmNm': 'Installing llvm-nm - Do NOT close this dialog',
                'llvmNmInstalledSuccessfully': 'llvm-nm installed successfully!',
                'yesInstall': 'Yes, install',
                'cancel': 'Cancel',
                'installWillDownload': 'This will download llvm-nm for %s to %s',
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
// Mock fs
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    mkdirSync: jest.fn(),
    chmodSync: jest.fn(),
    createWriteStream: jest.fn(() => ({
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn()
    })),
    readdirSync: jest.fn(),
    statSync: jest.fn(),
    unlinkSync: jest.fn(),
    rmSync: jest.fn()
}));
// Mock child_process
jest.mock('child_process', () => ({
    spawn: jest.fn().mockImplementation(() => ({
        on: jest.fn((event, callback) => {
            if (event === 'close') {
                setTimeout(() => callback(0), 100); // Simulate successful completion
            }
        }),
        stdout: {
            on: jest.fn()
        },
        stderr: {
            on: jest.fn()
        }
    })),
    execSync: jest.fn()
}));
describe('LLVM-NM Curl Installer', () => {
    let mockVscode;
    let mockFs;
    let mockChildProcess;
    beforeEach(() => {
        // Get mocked modules
        mockVscode = require('vscode');
        mockFs = require('fs');
        mockChildProcess = require('child_process');
        // Reset all mocks
        jest.clearAllMocks();
        // Setup default mock implementations
        mockFs.existsSync.mockReturnValue(false); // Tool not installed initially
        mockFs.statSync.mockReturnValue({ size: 1024 }); // Valid file size
        mockFs.readdirSync.mockReturnValue(['llvm-nm']);
    });
    describe('installLlvmNmWithCurl', () => {
        it('should start installation process', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock user confirmation
            mockVscode.window.showInformationMessage.mockResolvedValueOnce('Yes, install');
            // Mock successful curl download
            mockChildProcess.spawn.mockImplementation(() => ({
                on: jest.fn((event, callback) => {
                    if (event === 'close') {
                        setTimeout(() => callback(0), 100); // Success
                    }
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            }));
            // Run the installation
            yield (0, llvm_nm_installer_curl_1.installLlvmNmWithCurl)();
            // Verify user was asked for confirmation
            expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('download llvm-nm'), { modal: true }, 'Yes, install', 'Cancel');
            // Verify progress dialog was shown
            expect(mockVscode.window.withProgress).toHaveBeenCalledWith(expect.objectContaining({
                location: 15,
                title: 'Installing llvm-nm - Do NOT close this dialog',
                cancellable: true
            }), expect.any(Function));
        }));
        it('should cancel installation if user refuses', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock user cancellation
            mockVscode.window.showInformationMessage.mockResolvedValueOnce('Cancel');
            // Run the installation
            yield (0, llvm_nm_installer_curl_1.installLlvmNmWithCurl)();
            // Verify no progress dialog was shown
            expect(mockVscode.window.withProgress).not.toHaveBeenCalled();
        }));
        it('should cancel installation if user closes dialog', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock user not selecting any option (undefined)
            mockVscode.window.showInformationMessage.mockResolvedValueOnce(undefined);
            // Run the installation
            yield (0, llvm_nm_installer_curl_1.installLlvmNmWithCurl)();
            // Verify no progress dialog was shown
            expect(mockVscode.window.withProgress).not.toHaveBeenCalled();
        }));
        it('should show success message after installation', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock user confirmation
            mockVscode.window.showInformationMessage.mockResolvedValueOnce('Yes, install');
            // Mock successful installation
            mockChildProcess.spawn.mockImplementation(() => ({
                on: jest.fn((event, callback) => {
                    if (event === 'close') {
                        setTimeout(() => callback(0), 100); // Success
                    }
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            }));
            // Run the installation
            yield (0, llvm_nm_installer_curl_1.installLlvmNmWithCurl)();
            // Verify success message was shown (should be called twice: initial confirmation and final success)
            expect(mockVscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
            expect(mockVscode.window.showInformationMessage).toHaveBeenLastCalledWith('llvm-nm installed successfully!', { modal: true }, 'OK');
        }));
        it('should handle installation errors gracefully', () => __awaiter(void 0, void 0, void 0, function* () {
            // Mock user confirmation
            mockVscode.window.showInformationMessage.mockResolvedValueOnce('Yes, install');
            // Mock failed curl download
            mockChildProcess.spawn.mockImplementation(() => ({
                on: jest.fn((event, callback) => {
                    if (event === 'close') {
                        setTimeout(() => callback(1), 100); // Error
                    }
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            }));
            // Mock withProgress to handle the error
            mockVscode.window.withProgress.mockImplementation((options, task) => __awaiter(void 0, void 0, void 0, function* () {
                const progress = { report: jest.fn() };
                const token = { isCancellationRequested: false };
                try {
                    yield task(progress, token);
                }
                catch (error) {
                    // Error should be handled internally
                }
            }));
            // Run the installation - should not throw
            yield expect((0, llvm_nm_installer_curl_1.installLlvmNmWithCurl)()).resolves.not.toThrow();
        }));
    });
    describe('Platform-specific behavior', () => {
        it('should use correct binary name for Windows', () => {
            const getLlvmNmBinaryName = require('../src/config/config').getLlvmNmBinaryName;
            const binaryName = getLlvmNmBinaryName('win32');
            expect(binaryName).toBe('llvm-nm.exe');
        });
        it('should use correct binary name for Unix-like systems', () => {
            const getLlvmNmBinaryName = require('../src/config/config').getLlvmNmBinaryName;
            expect(getLlvmNmBinaryName('linux')).toBe('llvm-nm');
            expect(getLlvmNmBinaryName('darwin')).toBe('llvm-nm');
        });
        it('should generate correct download URLs', () => {
            const getLlvmNmDownloadUrl = require('../src/config/config').getLlvmNmDownloadUrl;
            const linuxUrl = getLlvmNmDownloadUrl('linux', 'x64');
            expect(linuxUrl).toContain('linux-x64');
            const windowsUrl = getLlvmNmDownloadUrl('win32', 'x64');
            expect(windowsUrl).toContain('win32-x64');
            const macUrl = getLlvmNmDownloadUrl('darwin', 'x64');
            expect(macUrl).toContain('darwin-x64');
        });
    });
    describe('Localization', () => {
        it('should use localized messages', () => {
            const localization = require('../src/localization/localization').localization;
            expect(localization.getUI('installingLlvmNm')).toBe('Installing llvm-nm - Do NOT close this dialog');
            expect(localization.getUI('llvmNmInstalledSuccessfully')).toBe('llvm-nm installed successfully!');
            expect(localization.getUI('yesInstall')).toBe('Yes, install');
            expect(localization.getUI('cancel')).toBe('Cancel');
        });
    });
});
//# sourceMappingURL=llvm-nm-installer-curl.test.js.map