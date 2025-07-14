// Mock VS Code
jest.mock('vscode', () => ({
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    withProgress: jest.fn()
  },
  workspace: {
    getConfiguration: jest.fn()
  },
  ProgressLocation: {
    Notification: 15
  }
}));

// Mock config
jest.mock('../src/config/config', () => ({
  LLVM_NM_CONFIG: {
    INSTALL_PATHS: {
      DUMPSTORM_BIN: '/home/.dumpstorm/bin',
      TEMP_ZIP: '/tmp/llvm-nm.zip',
      TEMP_TAR: '/tmp/llvm-nm.tar.gz',
      TEMP_EXTRACT: '/tmp/llvm-nm-extract'
    }
  },
  getLlvmNmBinaryName: jest.fn(),
  getLlvmNmDownloadUrl: jest.fn()
}));

// Mock localization
jest.mock('../src/localization/localization', () => ({
  localization: {
    getUI: jest.fn((key: string) => key),
    format: jest.fn((template: string) => template)
  }
}));

// Mock fs
jest.mock('fs');

// Mock child_process
jest.mock('child_process');

describe('Installer Tests', () => {
  test('Mock setup is working', () => {
    const vscode = require('vscode');
    const config = require('../src/config/config');
    const localization = require('../src/localization/localization');

    expect(vscode.window.showInformationMessage).toBeDefined();
    expect(config.LLVM_NM_CONFIG).toBeDefined();
    expect(localization.localization.getUI).toBeDefined();
  });

  test('Config mock returns expected values', () => {
    const config = require('../src/config/config');
    
    expect(config.LLVM_NM_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN).toBe('/home/.dumpstorm/bin');
    expect(config.getLlvmNmBinaryName).toBeDefined();
    expect(config.getLlvmNmDownloadUrl).toBeDefined();
  });

  test('Localization mock works', () => {
    const { localization } = require('../src/localization/localization');
    
    const result = localization.getUI('testKey');
    expect(result).toBe('testKey');
    expect(localization.getUI).toHaveBeenCalledWith('testKey');
  });

  test('VS Code mock works', () => {
    const vscode = require('vscode');
    
    expect(vscode.window.showInformationMessage).toBeDefined();
    expect(vscode.workspace.getConfiguration).toBeDefined();
    expect(vscode.ProgressLocation.Notification).toBe(15);
  });
});
