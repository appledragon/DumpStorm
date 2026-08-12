import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vscode is mocked globally via jest.config.js moduleNameMapper

import {
  MINIDUMP_STACKWALK_CONFIG,
  LLVM_NM_CONFIG,
  getDownloadUrl,
  getLlvmNmDownloadUrl,
  getBinaryName,
  getLlvmNmBinaryName,
  isValidMinidumpStackwalkPath,
  isValidLlvmNmPath,
  isValidNmPath,
  getDynamicLibraryExtensions,
  getAllDynamicLibraryExtensions,
  isDynamicLibrary,
  isDynamicLibraryCrossPlatform,
  findDynamicLibraries,
  DEFAULT_CONFIG,
  DYNAMIC_LIBRARY_EXTENSIONS,
  getDefaultSymbolPath,
  getSymbolPath
} from '../src/config/config';

// We need real fs for path validation tests, so we only mock selectively
// For isValid* tests we'll mock fs inline

describe('Config Module', () => {

  describe('getDownloadUrl', () => {
    it('should return Windows URL for win32', () => {
      const url = getDownloadUrl('win32', 'x64');
      expect(url).toBe(MINIDUMP_STACKWALK_CONFIG.DOWNLOAD_URLS.WIN32);
    });

    it('should return macOS ARM64 URL for darwin arm64', () => {
      const url = getDownloadUrl('darwin', 'arm64');
      expect(url).toBe(MINIDUMP_STACKWALK_CONFIG.DOWNLOAD_URLS.DARWIN_ARM64);
    });

    it('should return macOS x64 URL for darwin x64', () => {
      const url = getDownloadUrl('darwin', 'x64');
      expect(url).toBe(MINIDUMP_STACKWALK_CONFIG.DOWNLOAD_URLS.DARWIN_X64);
    });

    it('should return Linux URL for linux', () => {
      const url = getDownloadUrl('linux', 'x64');
      expect(url).toBe(MINIDUMP_STACKWALK_CONFIG.DOWNLOAD_URLS.LINUX_X64);
    });

    it('should throw for unsupported platform', () => {
      expect(() => getDownloadUrl('freebsd', 'x64')).toThrow('Unsupported platform: freebsd');
    });
  });

  describe('getLlvmNmDownloadUrl', () => {
    it('should return Windows x64 URL', () => {
      const url = getLlvmNmDownloadUrl('win32', 'x64');
      expect(url).toBe(LLVM_NM_CONFIG.DOWNLOAD_URLS.WIN32_X64);
    });

    it('should return Windows x86 URL for non-x64 arch', () => {
      const url = getLlvmNmDownloadUrl('win32', 'ia32');
      expect(url).toBe(LLVM_NM_CONFIG.DOWNLOAD_URLS.WIN32_X86);
    });

    it('should return macOS ARM64 URL', () => {
      const url = getLlvmNmDownloadUrl('darwin', 'arm64');
      expect(url).toBe(LLVM_NM_CONFIG.DOWNLOAD_URLS.DARWIN_ARM64);
    });

    it('should return macOS x64 URL', () => {
      const url = getLlvmNmDownloadUrl('darwin', 'x64');
      expect(url).toBe(LLVM_NM_CONFIG.DOWNLOAD_URLS.DARWIN_X64);
    });

    it('should return Linux URL', () => {
      const url = getLlvmNmDownloadUrl('linux', 'x64');
      expect(url).toBe(LLVM_NM_CONFIG.DOWNLOAD_URLS.LINUX_X64);
    });

    it('should throw for unsupported platform', () => {
      expect(() => getLlvmNmDownloadUrl('freebsd', 'x64')).toThrow('Unsupported platform: freebsd');
    });
  });

  describe('getBinaryName', () => {
    it('should return .exe name for win32', () => {
      expect(getBinaryName('win32')).toBe('minidump_stackwalk.exe');
    });

    it('should return unix name for linux', () => {
      expect(getBinaryName('linux')).toBe('minidump_stackwalk');
    });

    it('should return unix name for darwin', () => {
      expect(getBinaryName('darwin')).toBe('minidump_stackwalk');
    });
  });

  describe('getLlvmNmBinaryName', () => {
    it('should return .exe name for win32', () => {
      expect(getLlvmNmBinaryName('win32')).toBe('llvm-nm.exe');
    });

    it('should return unix name for linux', () => {
      expect(getLlvmNmBinaryName('linux')).toBe('llvm-nm');
    });

    it('should return unix name for darwin', () => {
      expect(getLlvmNmBinaryName('darwin')).toBe('llvm-nm');
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('should have expected defaults', () => {
      const expectedSymbolPath = os.platform() === 'win32'
        ? path.join(os.homedir(), '.dumpstorm', 'symbols')
        : '/tmp/symbols';
      expect(DEFAULT_CONFIG.SYMBOL_PATH).toBe(expectedSymbolPath);
      expect(DEFAULT_CONFIG.HOME_SYMBOL_PATH).toBe('symbols');
    });
  });

  describe('getSymbolPath', () => {
    const vscode = require('vscode');

    function mockSymbolPathSetting(value: string | undefined) {
      vscode.workspace.getConfiguration.mockReturnValue({
        get: jest.fn((key: string) => key === 'symbolPath' ? value : undefined),
        update: jest.fn().mockResolvedValue(undefined)
      });
    }

    afterEach(() => {
      vscode.workspace.getConfiguration.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined)
      });
    });

    it('returns a trimmed configured path', () => {
      mockSymbolPathSetting('  D:\\crash-symbols  ');
      expect(getSymbolPath()).toBe('D:\\crash-symbols');
    });

    it('uses ~/.dumpstorm/symbols on Windows when the setting is empty', () => {
      expect(getDefaultSymbolPath('win32', 'C:\\Users\\test')).toBe(
        path.join('C:\\Users\\test', '.dumpstorm', 'symbols'),
      );
      mockSymbolPathSetting('');
      expect(getSymbolPath()).toBe(DEFAULT_CONFIG.SYMBOL_PATH);
    });

    it('uses /tmp/symbols on non-Windows when the setting is unset', () => {
      expect(getDefaultSymbolPath('linux', '/home/test')).toBe('/tmp/symbols');
      expect(getDefaultSymbolPath('darwin', '/Users/test')).toBe('/tmp/symbols');
      mockSymbolPathSetting(undefined);
      expect(getSymbolPath()).toBe(DEFAULT_CONFIG.SYMBOL_PATH);
    });

    it('treats whitespace-only settings as empty', () => {
      mockSymbolPathSetting('   ');
      expect(getSymbolPath()).toBe(DEFAULT_CONFIG.SYMBOL_PATH);
    });
  });

  describe('DYNAMIC_LIBRARY_EXTENSIONS', () => {
    it('should have correct extensions for win32', () => {
      expect(DYNAMIC_LIBRARY_EXTENSIONS.win32).toEqual(['.dll', '.exe']);
    });

    it('should have correct extensions for darwin', () => {
      expect(DYNAMIC_LIBRARY_EXTENSIONS.darwin).toEqual(['.dylib', '.so', '.app']);
    });

    it('should have correct extensions for linux', () => {
      expect(DYNAMIC_LIBRARY_EXTENSIONS.linux).toEqual(['.so']);
    });

    it('should have default extensions covering all platforms', () => {
      const defaults = DYNAMIC_LIBRARY_EXTENSIONS.default;
      expect(defaults).toContain('.so');
      expect(defaults).toContain('.dylib');
      expect(defaults).toContain('.dll');
      expect(defaults).toContain('.exe');
      expect(defaults).toContain('.app');
    });
  });

  describe('getAllDynamicLibraryExtensions', () => {
    it('should return default extensions', () => {
      const exts = getAllDynamicLibraryExtensions();
      expect(exts).toEqual(DYNAMIC_LIBRARY_EXTENSIONS.default);
    });
  });

  describe('isDynamicLibraryCrossPlatform', () => {
    it('should recognize .dll files', () => {
      expect(isDynamicLibraryCrossPlatform('test.dll')).toBe(true);
    });

    it('should recognize .so files', () => {
      expect(isDynamicLibraryCrossPlatform('libfoo.so')).toBe(true);
    });

    it('should recognize .dylib files', () => {
      expect(isDynamicLibraryCrossPlatform('libfoo.dylib')).toBe(true);
    });

    it('should recognize .exe files', () => {
      expect(isDynamicLibraryCrossPlatform('app.exe')).toBe(true);
    });

    it('should reject non-library files', () => {
      expect(isDynamicLibraryCrossPlatform('readme.txt')).toBe(false);
      expect(isDynamicLibraryCrossPlatform('main.ts')).toBe(false);
      expect(isDynamicLibraryCrossPlatform('data.json')).toBe(false);
    });
  });

  describe('MINIDUMP_STACKWALK_CONFIG', () => {
    it('should have valid install paths', () => {
      expect(MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN).toBe('.dumpstorm/bin');
      expect(MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.TEMP_ZIP).toBeDefined();
      expect(MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.TEMP_EXTRACT).toBeDefined();
    });

    it('should have version set to nightly', () => {
      expect(MINIDUMP_STACKWALK_CONFIG.VERSION).toBe('nightly');
    });
  });

  describe('LLVM_NM_CONFIG', () => {
    it('should have valid install paths', () => {
      expect(LLVM_NM_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN).toBe('.dumpstorm/bin');
      expect(LLVM_NM_CONFIG.INSTALL_PATHS.TEMP_ZIP).toBeDefined();
      expect(LLVM_NM_CONFIG.INSTALL_PATHS.TEMP_EXTRACT).toBeDefined();
    });

    it('should have version set to nightly', () => {
      expect(LLVM_NM_CONFIG.VERSION).toBe('nightly');
    });
  });
});

describe('Path Validation Functions', () => {
  // These tests validate behavior with non-existent paths - the real fs works fine here
  describe('isValidMinidumpStackwalkPath', () => {
    it('should return false for non-existent path', () => {
      expect(isValidMinidumpStackwalkPath('/nonexistent/path/to/binary')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidMinidumpStackwalkPath('')).toBe(false);
    });

    it('should return false for directory path', () => {
      // os.tmpdir() always exists and is a directory  
      expect(isValidMinidumpStackwalkPath(os.tmpdir())).toBe(false);
    });
  });

  describe('isValidLlvmNmPath', () => {
    it('should return false for non-existent path', () => {
      expect(isValidLlvmNmPath('/nonexistent/llvm-nm')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidLlvmNmPath('')).toBe(false);
    });

    it('should return false for directory path', () => {
      expect(isValidLlvmNmPath(os.tmpdir())).toBe(false);
    });
  });

  describe('isValidNmPath', () => {
    it('should return false for non-existent path', () => {
      expect(isValidNmPath('/nonexistent/nm')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidNmPath('')).toBe(false);
    });

    it('should return false for directory path', () => {
      expect(isValidNmPath(os.tmpdir())).toBe(false);
    });
  });
});
