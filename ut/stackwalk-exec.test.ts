import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  execSync: jest.fn(),
}));

jest.mock('../src/symbols/enhancer', () => ({
  enhanceStackTraceWithSymbols: jest.fn(async (output: string) => output),
}));

import {
  ANALYSIS_CANCELLED_CODE,
  INVALID_ANALYSIS_MARKER,
  PARTIAL_ANALYSIS_MARKER,
  runStackwalk,
} from '../src/analysis/stackwalk';

type MockChild = EventEmitter & {
  killed: boolean;
  kill: jest.Mock;
};

function createChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.killed = false;
  child.kill = jest.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function createCancellationToken() {
  const emitter = new EventEmitter();
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      emitter.on('cancel', listener);
      return { dispose: () => emitter.removeListener('cancel', listener) };
    },
    cancel() {
      this.isCancellationRequested = true;
      emitter.emit('cancel');
    },
  };
}

describe('runStackwalk process lifecycle', () => {
  const execFileMock = childProcess.execFile as unknown as jest.Mock;
  const vscodeMock = vscode as any;

  beforeEach(() => {
    jest.clearAllMocks();
    vscodeMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string) => key === 'customMinidumpStackwalkPath' ? process.execPath : undefined),
    });
  });

  it('executes both machine and human-readable passes', async () => {
    const machineChild = createChild();
    const humanChild = createChild();
    execFileMock
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, 'OS|Windows|10\nModule|app.exe||||1000|2000|1', '');
        return machineChild;
      })
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, 'Thread 0 (crashed)\n 0 app.exe + 0x10', '');
        return humanChild;
      });

    const result = await runStackwalk(
      {} as vscode.ExtensionContext,
      'C:\\Crash Dumps\\sample.dmp',
      'C:\\Symbols',
    );

    expect(result).toContain('Thread 0');
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][1]).toEqual(['-m', 'C:\\Crash Dumps\\sample.dmp', 'C:\\Symbols']);
    expect(execFileMock.mock.calls[1][1]).toEqual(['C:\\Crash Dumps\\sample.dmp', 'C:\\Symbols']);
    expect(execFileMock.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 120_000 }));
  });

  it('marks a summary with severe stderr and no frames as invalid', async () => {
    const machineChild = createChild();
    const humanChild = createChild();
    execFileMock
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, '', '');
        return machineChild;
      })
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(
          null,
          'Operating system: Windows\nThread 0 (crashed)\n <no frames>',
          'MinidumpModuleList size mismatch, 690 != 544\nNo stackwalker for sample.dmp',
        );
        return humanChild;
      });

    const result = await runStackwalk(
      {} as vscode.ExtensionContext,
      'sample.dmp',
      'C:\\Symbols',
    );

    expect(result).toContain(INVALID_ANALYSIS_MARKER);
    expect(result).toContain('MinidumpModuleList size mismatch');
    expect(result).not.toContain(PARTIAL_ANALYSIS_MARKER);
  });

  it('marks usable frames with severe stderr as partial', async () => {
    const machineChild = createChild();
    const humanChild = createChild();
    execFileMock
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, '', '');
        return machineChild;
      })
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(
          null,
          'Operating system: Windows\nThread 0 (crashed)\n 0  app.exe + 0x1000',
          'No stackwalker for one non-crashed thread',
        );
        return humanChild;
      });

    const result = await runStackwalk(
      {} as vscode.ExtensionContext,
      'sample.dmp',
      'C:\\Symbols',
    );

    expect(result).toContain(PARTIAL_ANALYSIS_MARKER);
    expect(result).toContain('0  app.exe');
    expect(result).not.toContain(INVALID_ANALYSIS_MARKER);
  });

  it('kills both child processes and rejects with a cancellation error', async () => {
    const machineChild = createChild();
    const humanChild = createChild();
    const token = createCancellationToken();
    execFileMock
      .mockImplementationOnce((_exe: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, '', '');
        return machineChild;
      })
      .mockImplementationOnce(() => humanChild);

    const analysis = runStackwalk(
      {} as vscode.ExtensionContext,
      'C:\\Crash Dumps\\sample.dmp',
      'C:\\Symbols',
      token as unknown as vscode.CancellationToken,
    );
    await Promise.resolve();
    token.cancel();

    await expect(analysis).rejects.toMatchObject({ code: ANALYSIS_CANCELLED_CODE });
    expect(machineChild.kill).toHaveBeenCalled();
    expect(humanChild.kill).toHaveBeenCalled();
  });
});
