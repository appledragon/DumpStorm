import {
  getBatchSymbolOutputPath,
  processNmOutput,
  getSymbolTypeDescription,
} from '../src/symbols/extractor';

// Mock vscode and other dependencies
jest.mock('vscode', () => ({
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    withProgress: jest.fn()
  },
  workspace: {
    getConfiguration: jest.fn().mockReturnValue({ get: jest.fn() }),
    openTextDocument: jest.fn()
  },
  ProgressLocation: { Notification: 15 },
  Uri: { file: jest.fn() }
}));

jest.mock('../src/localization/localization', () => ({
  localization: {
    getUI: jest.fn((key: string) => key),
    format: jest.fn((template: string, ...args: any[]) => {
      let i = 0;
      return template.replace(/\{(\d+)\}/g, () => String(args[i++] ?? ''));
    })
  }
}));

describe('Symbol Extractor', () => {

  describe('processNmOutput', () => {
    it('should add header with binary name', () => {
      const result = processNmOutput('some output', 'mylib');
      expect(result).toContain('=== SYMBOLS FOR mylib ===');
    });

    it('should include generation timestamp', () => {
      const result = processNmOutput('some output', 'test');
      expect(result).toContain('Generated:');
    });

    it('should include nm command output header', () => {
      const result = processNmOutput('some output', 'test');
      expect(result).toContain('nm command output:');
    });

    it('should include original nm output', () => {
      const nmOutput = '0000000000001000 T main\n0000000000002000 T helper';
      const result = processNmOutput(nmOutput, 'test');
      expect(result).toContain('0000000000001000 T main');
      expect(result).toContain('0000000000002000 T helper');
    });

    it('should handle empty output', () => {
      const result = processNmOutput('', 'empty');
      expect(result).toContain('=== SYMBOLS FOR empty ===');
    });
  });

  it('uses distinct output names for same-named binaries in different directories', () => {
    const first = getBatchSymbolOutputPath('C:\\symbols\\one\\foo.dll', 'C:\\output');
    const second = getBatchSymbolOutputPath('C:\\symbols\\two\\foo.dll', 'C:\\output');

    expect(first).not.toBe(second);
    expect(first).toMatch(/foo_[0-9a-f]{12}_nm\.txt$/i);
    expect(second).toMatch(/foo_[0-9a-f]{12}_nm\.txt$/i);
  });

  describe('getSymbolTypeDescription', () => {
    it('should describe text section global functions (T)', () => {
      const desc = getSymbolTypeDescription('T');
      expect(desc).toContain('Text');
      expect(desc).toContain('Global');
    });

    it('should describe text section local functions (t)', () => {
      const desc = getSymbolTypeDescription('t');
      expect(desc).toContain('Text');
      expect(desc).toContain('Local');
    });

    it('should describe data section global (D)', () => {
      const desc = getSymbolTypeDescription('D');
      expect(desc).toContain('Data');
      expect(desc).toContain('global');
    });

    it('should describe data section local (d)', () => {
      const desc = getSymbolTypeDescription('d');
      expect(desc).toContain('Data');
      expect(desc).toContain('local');
    });

    it('should describe BSS section global (B)', () => {
      const desc = getSymbolTypeDescription('B');
      expect(desc).toContain('BSS');
      expect(desc).toContain('global');
    });

    it('should describe BSS section local (b)', () => {
      const desc = getSymbolTypeDescription('b');
      expect(desc).toContain('BSS');
      expect(desc).toContain('local');
    });

    it('should describe undefined symbols (U)', () => {
      const desc = getSymbolTypeDescription('U');
      expect(desc).toContain('Undefined');
    });

    it('should describe weak symbols (W)', () => {
      const desc = getSymbolTypeDescription('W');
      expect(desc).toContain('Weak');
    });

    it('should describe weak local symbols (w)', () => {
      const desc = getSymbolTypeDescription('w');
      expect(desc).toContain('Weak');
    });

    it('should describe read-only data (R)', () => {
      const desc = getSymbolTypeDescription('R');
      expect(desc).toContain('Read-only');
    });

    it('should describe read-only data local (r)', () => {
      const desc = getSymbolTypeDescription('r');
      expect(desc).toContain('Read-only');
    });

    it('should describe absolute symbols (A)', () => {
      const desc = getSymbolTypeDescription('A');
      expect(desc).toContain('Absolute');
    });

    it('should describe debug symbols (N)', () => {
      const desc = getSymbolTypeDescription('N');
      expect(desc).toContain('Debug');
    });

    it('should handle unknown types', () => {
      const desc = getSymbolTypeDescription('Z');
      expect(desc).toContain('Other');
      expect(desc).toContain('Z');
    });
  });
});
