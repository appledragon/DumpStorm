// Jest setup file for test environment configuration

// Mock VS Code API
const mockVSCode = {
  window: {
    showInformationMessage: () => Promise.resolve('OK'),
    showErrorMessage: () => Promise.resolve('OK'),
    showWarningMessage: () => Promise.resolve('OK'),
    withProgress: () => Promise.resolve(),
    createOutputChannel: () => ({
      appendLine: () => {},
      clear: () => {},
      dispose: () => {},
      show: () => {}
    })
  },
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      update: () => Promise.resolve()
    })
  },
  ProgressLocation: {
    Notification: 15
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, path })
  }
};

// Export for use in tests
module.exports = { mockVSCode };
