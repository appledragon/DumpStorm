// Shared mock for the 'vscode' module used across all tests

const EventEmitter = {
  event: jest.fn()
};

const vscode = {
  window: {
    showInformationMessage: jest.fn().mockResolvedValue('OK'),
    showErrorMessage: jest.fn().mockResolvedValue('OK'),
    showWarningMessage: jest.fn().mockResolvedValue('OK'),
    withProgress: jest.fn().mockImplementation((_options: any, task: any) => {
      const progress = { report: jest.fn() };
      const token = { isCancellationRequested: false };
      return task(progress, token);
    }),
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      clear: jest.fn(),
      dispose: jest.fn(),
      show: jest.fn()
    })),
    activeTextEditor: undefined,
    showOpenDialog: jest.fn(),
    showQuickPick: jest.fn(),
    registerTreeDataProvider: jest.fn()
  },
  workspace: {
    getConfiguration: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      update: jest.fn().mockResolvedValue(undefined)
    }),
    openTextDocument: jest.fn().mockResolvedValue({
      getText: jest.fn().mockReturnValue(''),
      lineAt: jest.fn().mockReturnValue({ text: '' }),
      getWordRangeAtPosition: jest.fn()
    }),
    onDidChangeConfiguration: jest.fn()
  },
  commands: {
    registerCommand: jest.fn(),
    executeCommand: jest.fn()
  },
  languages: {
    registerHoverProvider: jest.fn()
  },
  env: {
    language: 'en',
    openExternal: jest.fn()
  },
  ProgressLocation: {
    Notification: 15
  },
  Uri: {
    file: jest.fn((filePath: string) => ({ fsPath: filePath, path: filePath })),
    parse: jest.fn((uri: string) => ({ toString: () => uri }))
  },
  EventEmitter: jest.fn().mockImplementation(() => EventEmitter),
  TreeItem: class TreeItem {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  ThemeIcon: class ThemeIcon {
    id: string;
    constructor(id: string) { this.id = id; }
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  Position: class Position {
    line: number;
    character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class Range {
    start: any;
    end: any;
    constructor(start: any, end: any) {
      this.start = start;
      this.end = end;
    }
  },
  Hover: class Hover {
    contents: any;
    range: any;
    constructor(contents: any, range?: any) {
      this.contents = contents;
      this.range = range;
    }
  },
  MarkdownString: class MarkdownString {
    value: string = '';
    isTrusted: boolean = false;
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
    appendText(text: string) {
      this.value += text;
      return this;
    }
  },
  CancellationTokenSource: class CancellationTokenSource {
    token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }
};

module.exports = vscode;
