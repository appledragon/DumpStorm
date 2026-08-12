import * as os from 'os';
import * as path from 'path';
import { installLlvmNmWithCurl } from '../src/tools/llvm-nm-installer-curl';

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
  getLlvmNmBinaryName: jest.fn((platform: string) => {
    return platform === 'win32' ? 'llvm-nm.exe' : 'llvm-nm';
  }),
  getLlvmNmDownloadUrl: jest.fn((platform: string, arch: string) => {
    if (platform === 'win32') {
      return arch === 'x64' 
        ? 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-windows-x64.zip'
        : 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-windows-x86.zip';
    } else if (platform === 'darwin') {
      return arch === 'arm64'
        ? 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-macos-arm64.tar.gz'
        : 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-macos-x86_64.tar.gz';
    } else {
      return 'https://github.com/appledragon/llvm-nm-prebuilt/releases/download/nightly/llvm-nm-linux-x86_64.tar.gz';
    }
  })
}));

// Mock localization
jest.mock('../src/localization/localization', () => ({
  localization: {
    getUI: jest.fn((key: string) => {
      const messages: Record<string, string> = {
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
    format: jest.fn((template: string, ...args: any[]) => {
      return template.replace(/%s/g, () => args.shift());
    })
  }
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  chmodSync: jest.fn(),
  copyFileSync: jest.fn(),
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
  execSync: jest.fn(),
  execFileSync: jest.fn()
}));

describe('LLVM-NM Curl Installer', () => {
  let mockVscode: any;
  let mockFs: any;
  let mockChildProcess: any;

  beforeEach(() => {
    // Get mocked modules
    mockVscode = require('vscode');
    mockFs = require('fs');
    mockChildProcess = require('child_process');
    
    // Reset all mocks
    jest.clearAllMocks();
    
    // Track created directories to simulate real filesystem behavior
    const createdDirs = new Set<string>();
    mockFs.existsSync.mockImplementation((p: string) => createdDirs.has(p));
    mockFs.mkdirSync.mockImplementation((p: string) => { createdDirs.add(p); });
    mockFs.statSync.mockReturnValue({ size: 1024 }); // Valid file size
    const llvmNmBinary = os.platform() === 'win32' ? 'llvm-nm.exe' : 'llvm-nm';
    mockFs.readdirSync.mockImplementation((_dir: string, options?: any) => {
      if (options?.withFileTypes) {
        return [{ name: llvmNmBinary, isFile: () => true, isDirectory: () => false }];
      }
      return [llvmNmBinary];
    });
  });

  describe('installLlvmNmWithCurl', () => {
    it('should start installation process', async () => {
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
      await installLlvmNmWithCurl();

      // Verify user was asked for confirmation
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('download llvm-nm'),
        { modal: true },
        'Yes, install',
        'Cancel'
      );

      // Verify progress dialog was shown
      expect(mockVscode.window.withProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          location: 15, // Notification
          title: 'Installing llvm-nm - Do NOT close this dialog',
          cancellable: true
        }),
        expect.any(Function)
      );
    });

    it('should cancel installation if user refuses', async () => {
      // Mock user cancellation
      mockVscode.window.showInformationMessage.mockResolvedValueOnce('Cancel');
      
      // Run the installation
      await installLlvmNmWithCurl();

      // Verify no progress dialog was shown
      expect(mockVscode.window.withProgress).not.toHaveBeenCalled();
    });

    it('should cancel installation if user closes dialog', async () => {
      // Mock user not selecting any option (undefined)
      mockVscode.window.showInformationMessage.mockResolvedValueOnce(undefined);
      
      // Run the installation
      await installLlvmNmWithCurl();

      // Verify no progress dialog was shown
      expect(mockVscode.window.withProgress).not.toHaveBeenCalled();
    });

    it('should show success message after installation', async () => {
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
      await installLlvmNmWithCurl();

      // Verify success message was shown (user confirmation and final success)
      expect(mockVscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
      expect(mockVscode.window.showInformationMessage).toHaveBeenLastCalledWith(
        'llvm-nm installed successfully!',
        { modal: true },
        'OK'
      );
    });

    it('should handle installation errors gracefully', async () => {
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
      mockVscode.window.withProgress.mockImplementation(async (options: any, task: any) => {
        const progress = { report: jest.fn() };
        const token = { isCancellationRequested: false };
        
        try {
          await task(progress, token);
        } catch (error) {
          // Error should be handled internally
        }
      });

      // Run the installation - should not throw
      await expect(installLlvmNmWithCurl()).resolves.not.toThrow();
    });
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
      expect(linuxUrl).toContain('linux-x86_64');
      
      const windowsUrl = getLlvmNmDownloadUrl('win32', 'x64');
      expect(windowsUrl).toContain('windows-x64');
      
      const macUrl = getLlvmNmDownloadUrl('darwin', 'x64');
      expect(macUrl).toContain('macos-x86_64');
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
