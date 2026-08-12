import * as vscode from 'vscode';
import {
  getCustomDumpSymsPath,
  getCustomLlvmUndnamePath,
  isValidDumpSymsPath,
  isValidLlvmUndnamePath,
} from '../src/config/config';
import { getDumpSymsCommand } from '../src/symbols/breakpad-extractor';

describe('custom tool discovery', () => {
  const vscodeMock = vscode as any;

  it('reads custom dump_syms and llvm-undname settings', () => {
    const values: Record<string, string> = {
      customDumpSymsPath: 'C:\\Tools\\dump_syms.exe',
      customLlvmUndnamePath: 'C:\\Tools\\llvm-undname.exe',
    };
    vscodeMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string) => values[key]),
    });

    expect(getCustomDumpSymsPath()).toBe(values.customDumpSymsPath);
    expect(getCustomLlvmUndnamePath()).toBe(values.customLlvmUndnamePath);
  });

  it('accepts only regular files for custom executable paths', () => {
    expect(isValidDumpSymsPath(process.execPath)).toBe(true);
    expect(isValidLlvmUndnamePath(process.execPath)).toBe(true);
    expect(isValidDumpSymsPath(process.cwd())).toBe(false);
  });

  it('uses the configured dump_syms executable', () => {
    const customPath = process.execPath;
    vscodeMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string) => key === 'customDumpSymsPath' ? customPath : undefined),
    });

    expect(getDumpSymsCommand()).toBe(customPath);
  });
});
