import * as os from 'os';
import * as path from 'path';
import { BinaryInfo, ToolConfig } from '../src/tools/base-installer';
import { CurlBaseInstaller } from '../src/tools/curl-installer';

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
  copyFileSync: jest.fn(),
  createWriteStream: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  unlinkSync: jest.fn(),
  rmSync: jest.fn()
}));

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execSync: jest.fn()
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
        'installationStarting': 'Installation starting...',
        'downloadingFile': 'Downloading file...',
        'extractingFiles': 'Extracting files...',
        'settingPermissions': 'Setting permissions...',
        'installer.installationCancelledByUser': 'Installation cancelled by user',
        'installer.downloadFailed': 'Failed to download via curl: %s'
      };
      return messages[key] || key;
    }),
    format: jest.fn((template: string, ...args: any[]) => {
      return template.replace(/%s/g, () => args.shift());
    })
  }
}));

// Test implementation of CurlBaseInstaller
class TestCurlInstaller extends CurlBaseInstaller {
  protected getToolConfig(): ToolConfig {
    return {
      INSTALL_PATHS: {
        DUMPSTORM_BIN: path.join(os.homedir(), '.test-curl-tool', 'bin'),
        TEMP_ZIP: path.join(os.tmpdir(), 'test-curl-tool.zip'),
        TEMP_TAR: path.join(os.tmpdir(), 'test-curl-tool.tar.gz'),
        TEMP_EXTRACT: path.join(os.tmpdir(), 'test-curl-tool-extract')
      }
    };
  }

  protected getBinaryInfo(platform: string, arch: string): BinaryInfo {
    return {
      downloadUrl: `https://example.com/test-curl-tool-${platform}-${arch}.tar.gz`,
      binaryName: platform === 'win32' ? 'test-curl-tool.exe' : 'test-curl-tool',
      toolName: 'test-curl-tool'
    };
  }

  protected getStartingInstallationMessage(): string {
    return 'Starting test curl tool installation';
  }

  protected getInstallingMessage(): string {
    return 'Installing test curl tool';
  }

  protected getSuccessMessage(): string {
    return 'Test curl tool installed successfully';
  }

  protected findExecutablesInDir(dir: string, platform: string): Record<string, string> {
    const filename = platform === 'win32' ? 'test-curl-tool.exe' : 'test-curl-tool';
    const fullPath = path.join(dir, filename);
    return { testCurlTool: fullPath };
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

  // Test the curl installation method
  public async testInstallWithCurl(
    binaryInfo: BinaryInfo,
    progress: any,
    resolve: () => void,
    reject: (error: string) => void,
    token: any
  ): Promise<void> {
    return this.installWithCurl(binaryInfo, progress, resolve, reject, token);
  }
}

describe('CurlBaseInstaller', () => {
  let installer: TestCurlInstaller;
  let mockFs: any;
  let mockChildProcess: any;

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
    let mockProgress: any;
    let mockToken: any;
    let mockResolve: jest.Mock;
    let mockReject: jest.Mock;

    beforeEach(() => {
      mockProgress = { report: jest.fn() };
      mockToken = { isCancellationRequested: false };
      mockResolve = jest.fn();
      mockReject = jest.fn();
    });

    it('should handle successful curl download', async () => {
      // Mock file system operations
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 1024 });
      mockFs.readdirSync.mockReturnValue(['test-curl-tool']);

      const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
      
      // Start the installation
      await installer.testInstallWithCurl(
        binaryInfo,
        mockProgress,
        mockResolve,
        mockReject,
        mockToken
      );

      // Wait for setTimeout resolve
      await new Promise(resolve => setTimeout(resolve, 2100));

      expect(mockChildProcess.execSync).toHaveBeenCalled();
      expect(mockProgress.report).toHaveBeenCalled();
      expect(mockReject).not.toHaveBeenCalled();
    });

    it('should handle curl download failure', async () => {
      // Mock failed execSync (curl download fails)
      mockChildProcess.execSync.mockImplementation(() => {
        throw new Error('curl: (7) Failed to connect to host');
      });

      const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
      
      // Start the installation
      await installer.testInstallWithCurl(
        binaryInfo,
        mockProgress,
        mockResolve,
        mockReject,
        mockToken
      );

      expect(mockReject).toHaveBeenCalledWith(expect.stringContaining('curl'));
    });

    it('should handle cancellation', async () => {
      // Mock cancellation token
      mockToken.isCancellationRequested = true;

      const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
      
      await installer.testInstallWithCurl(
        binaryInfo,
        mockProgress,
        mockResolve,
        mockReject,
        mockToken
      );

      expect(mockReject).toHaveBeenCalledWith('Installation cancelled by user');
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('should report progress during installation', async () => {
      // Mock file system operations
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 1024 });
      mockFs.readdirSync.mockReturnValue(['test-curl-tool']);

      const binaryInfo = installer.testGetBinaryInfo('linux', 'x64');
      
      await installer.testInstallWithCurl(
        binaryInfo,
        mockProgress,
        mockResolve,
        mockReject,
        mockToken
      );

      // Wait for setTimeout resolve
      await new Promise(resolve => setTimeout(resolve, 2100));

      // Verify progress was reported multiple times
      expect(mockProgress.report).toHaveBeenCalledWith(
        expect.objectContaining({
          increment: expect.any(Number),
          message: expect.any(String)
        })
      );
    });
  });

  describe('messages', () => {
    it('should return correct message strings', () => {
      expect(installer['getStartingInstallationMessage']()).toBe('Starting test curl tool installation');
      expect(installer['getInstallingMessage']()).toBe('Installing test curl tool');
      expect(installer['getSuccessMessage']()).toBe('Test curl tool installed successfully');
    });
  });
});
