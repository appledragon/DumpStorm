import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BaseInstaller,
  BinaryInfo,
  appendTempSuffix,
  getPowerShellArchiveArgs,
  ToolConfig,
} from '../src/tools/base-installer';

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
    file: jest.fn((filePath: string) => ({ fsPath: filePath, path: filePath }))
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
  execSync: jest.fn(),
  execFileSync: jest.fn()
}));

// Mock localization
jest.mock('../src/localization/localization', () => ({
  localization: {
    getUI: jest.fn((key: string) => {
      const messages: Record<string, string> = {
        'installingTool': 'Installing tool...',
        'toolInstalledSuccessfully': 'Tool installed successfully!',
        'yesInstall': 'Yes, install',
        'cancel': 'Cancel',
        'installWillDownload': 'This will download tool for %s to %s',
        'installationStarting': 'Installation starting...'
      };
      return messages[key] || key;
    }),
    format: jest.fn((template: string, ...args: any[]) => {
      return template.replace(/%s/g, () => args.shift());
    })
  }
}));

// Test implementation of BaseInstaller
class TestInstaller extends BaseInstaller {
  protected getToolConfig(): ToolConfig {
    return {
      INSTALL_PATHS: {
        DUMPSTORM_BIN: path.join(os.homedir(), '.test-tool', 'bin'),
        TEMP_ZIP: path.join(os.tmpdir(), 'test-tool.zip'),
        TEMP_TAR: path.join(os.tmpdir(), 'test-tool.tar.gz'),
        TEMP_EXTRACT: path.join(os.tmpdir(), 'test-tool-extract')
      }
    };
  }

  protected getBinaryInfo(platform: string, arch: string): BinaryInfo {
    return {
      downloadUrl: `https://example.com/test-tool-${platform}-${arch}.tar.gz`,
      binaryName: platform === 'win32' ? 'test-tool.exe' : 'test-tool',
      toolName: 'test-tool'
    };
  }

  protected getStartingInstallationMessage(): string {
    return 'Starting test tool installation';
  }

  protected getInstallingMessage(): string {
    return 'Installing test tool';
  }

  protected getSuccessMessage(): string {
    return 'Test tool installed successfully';
  }

  protected findExecutablesInDir(dir: string, platform: string): Record<string, string> {
    const filename = platform === 'win32' ? 'test-tool.exe' : 'test-tool';
    const fullPath = path.join(dir, filename);
    return { testTool: fullPath };
  }

  // Expose protected methods for testing
  public testGetToolConfig(): ToolConfig {
    return this.getToolConfig();
  }

  public testGetBinaryInfo(platform: string, arch: string): BinaryInfo {
    return this.getBinaryInfo(platform, arch);
  }

  public testFindExecutablesInDir(dir: string, platform: string): Record<string, string> {
    return this.findExecutablesInDir(dir, platform);
  }

  public testValidateDownloadedFile(tempFile: string, reject: (error: string) => void): boolean {
    return this.validateDownloadedFile(tempFile, reject);
  }

  public testListAllFiles(dir: string, prefix = ''): string[] {
    return this.listAllFiles(dir, prefix);
  }

  public testCleanupTempFiles(tempFile: string, tempDir: string): void {
    return this.cleanupTempFiles(tempFile, tempDir);
  }
}

describe('BaseInstaller', () => {
  let installer: TestInstaller;
  let mockFs: jest.Mocked<typeof fs>;

  beforeEach(() => {
    installer = new TestInstaller();
    mockFs = fs as jest.Mocked<typeof fs>;
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
      mockFs.statSync.mockReturnValue({ size: 1024 } as fs.Stats);

      const rejectFn = jest.fn();
      const isValid = installer.testValidateDownloadedFile(tempFile, rejectFn);
      
      expect(isValid).toBe(true);
      expect(rejectFn).not.toHaveBeenCalled();
    });

    it('should return false for non-existent file', () => {
      const tempFile = '/tmp/non-existent.zip';
      mockFs.statSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const rejectFn = jest.fn();
      const isValid = installer.testValidateDownloadedFile(tempFile, rejectFn);
      
      expect(isValid).toBe(false);
      expect(rejectFn).toHaveBeenCalled();
    });

    it('should return false for empty file', () => {
      const tempFile = '/tmp/empty-file.zip';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 0 } as fs.Stats);

      const rejectFn = jest.fn();
      const isValid = installer.testValidateDownloadedFile(tempFile, rejectFn);
      
      expect(isValid).toBe(false);
      expect(rejectFn).toHaveBeenCalled();
    });
  });

  describe('listAllFiles', () => {
    it('should list files in directory', () => {
      const testDir = '/test/dir';
      mockFs.readdirSync.mockReturnValue([
        { name: 'file1.txt', isDirectory: () => false },
        { name: 'file2.txt', isDirectory: () => false }
      ] as any);

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
      (fs as any).unlinkSync = unlinkSync;
      (fs as any).rmSync = rmSync;

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

  it('returns false without installing when the confirmation dialog is dismissed', async () => {
    const vscodeMock = require('vscode');
    vscodeMock.window.showInformationMessage.mockResolvedValueOnce(undefined);

    await expect(installer.install()).resolves.toBe(false);
    expect(vscodeMock.window.withProgress).not.toHaveBeenCalled();
  });

  it('passes Windows archive paths as arguments even with spaces and quotes', () => {
    const archivePath = "C:\\Crash Tools\\vendor's\\tool.zip";
    const destinationPath = "C:\\Crash Tools\\extract'ed";
    const args = getPowerShellArchiveArgs(archivePath, destinationPath);

    expect(args).toContain(archivePath);
    expect(args).toContain(destinationPath);
    expect(args[args.length - 2]).toBe(archivePath);
    expect(args[args.length - 1]).toBe(destinationPath);
    expect(args.join(' ')).not.toContain(`'${archivePath}'`);
  });

  it('keeps the archive extension after adding a temporary suffix', () => {
    expect(appendTempSuffix('breakpad-temp.zip', '123')).toBe('breakpad-temp-123.zip');
    expect(appendTempSuffix('tool.tar.gz', '456')).toBe('tool.tar-456.gz');
  });
});
