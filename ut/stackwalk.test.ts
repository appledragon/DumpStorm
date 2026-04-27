// vscode is mocked globally via jest.config.js moduleNameMapper
import { cleanStackwalkOutput, buildSymbolMatchReport } from '../src/analysis/stackwalk';
import { parseMachineFormat } from '../src/analysis/machine-format';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('cleanStackwalkOutput', () => {

  describe('basic filtering', () => {
    it('should remove INFO/DEBUG lines when enough clean lines remain', () => {
      const stdout = `INFO: Loading symbols
DEBUG: symbol lookup
Operating system: Windows NT
CPU: amd64
Process uptime: 42 seconds
Thread 0 (crashed)
 0  module.dll + 0x1234
 1  ntdll.dll + 0x5678
 2  kernel32.dll + 0x9abc`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).not.toContain('INFO:');
      expect(result).not.toContain('DEBUG:');
      expect(result).toContain('Operating system:');
      expect(result).toContain('Thread 0');
    });

    it('should remove Loading/Loaded lines when enough clean lines remain', () => {
      const stdout = `Loading module symbols
Loaded symbols for ntdll.dll
Operating system: Windows NT
CPU: x86
Process uptime: 10 seconds
Thread 0 (crashed)
 0  app.exe + 0x5678
 1  ntdll.dll + 0x1234
 2  kernel32.dll + 0xabcd`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).not.toContain('Loading module');
      expect(result).not.toContain('Loaded symbols');
    });

    it('should remove symbol file and debug info lines when enough clean lines remain', () => {
      const stdout = `Found debug info for module.dll
symbol file related info
Operating system: Linux
CPU: amd64
Process uptime: 5 seconds
Thread 0 (crashed)
 0  libtest.so + 0xABCD
 1  libc.so + 0x1234
 2  ld-linux.so + 0x5678`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).not.toContain('Found debug info');
      expect(result).not.toContain('symbol file');
    });
  });

  describe('keeping crash data', () => {
    it('should keep crash-related lines', () => {
      const stdout = `Crash reason: SIGSEGV
Crash address: 0x0
Operating system: Linux 5.4.0
CPU: amd64 family
Process uptime: 1234 seconds
Thread 0 (crashed)
 0  libtest.so + 0x1234
 1  libtest.so + 0x5678`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('Crash reason');
      expect(result).toContain('Crash address');
      expect(result).toContain('Operating system');
      expect(result).toContain('CPU');
      expect(result).toContain('Process uptime');
      expect(result).toContain('Thread 0 (crashed)');
    });

    it('should keep stack frame lines', () => {
      const stdout = `Thread 0 (crashed)
 0  libtest.so!_ZN4test3fooEv + 0x10
 1  libtest.so + 0x5678
 2  libc.so + 0x1000`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('0  libtest.so');
      expect(result).toContain('1  libtest.so');
      expect(result).toContain('2  libc.so');
    });

    it('should keep lines with addresses (0x prefix)', () => {
      const stdout = `Thread 0 (crashed)
 0  0x00007fff12345678
 1  module.dll + 0x1234`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('0x00007fff12345678');
    });

    it('should keep module and library info in crash section', () => {
      const stdout = `Thread 0 (crashed)
 0  module.dll + 0x1234
Module info: test.dll
 1  library.so + 0x5678
  librt.so.1
  test.dylib loaded`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('.dll');
      expect(result).toContain('.so');
    });
  });

  describe('fallback to original output', () => {
    it('should return original output if fewer than 5 clean lines', () => {
      const stdout = `Some random text
that does not match
any crash patterns`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toBe(stdout);
    });
  });

  describe('stderr handling', () => {
    it('should append useful stderr messages', () => {
      const stdout = `Operating system: Windows
CPU: amd64
Thread 0 (crashed)
 0  app.exe + 0x1000
 1  ntdll.dll + 0x2000
 2  kernel32.dll + 0x3000`;
      const stderr = 'Some warning message';
      const result = cleanStackwalkOutput(stdout, stderr);
      expect(result).toContain('=== Additional Information ===');
      expect(result).toContain('Some warning message');
    });

    it('should filter out INFO/DEBUG from stderr', () => {
      const stdout = `Operating system: Windows
CPU: amd64
Thread 0 (crashed)
 0  app.exe + 0x1000
 1  ntdll.dll + 0x2000
 2  kernel32.dll + 0x3000`;
      const stderr = 'INFO: This should be filtered\nDEBUG: This too\nsymbol file info\nActual warning';
      const result = cleanStackwalkOutput(stdout, stderr);
      expect(result).not.toContain('INFO: This should be filtered');
      expect(result).not.toContain('DEBUG: This too');
      expect(result).toContain('Actual warning');
    });

    it('should not add stderr section if all stderr lines are filtered', () => {
      const stdout = `Operating system: Windows
CPU: amd64
Thread 0 (crashed)
 0  app.exe + 0x1000
 1  ntdll.dll + 0x2000
 2  kernel32.dll + 0x3000`;
      const stderr = 'INFO: filtered\nDEBUG: also filtered';
      const result = cleanStackwalkOutput(stdout, stderr);
      expect(result).not.toContain('=== Additional Information ===');
    });

    it('should handle empty stderr gracefully', () => {
      const stdout = `Operating system: Linux
CPU: amd64
Thread 0 (crashed)
 0  app + 0x1000
 1  libc.so + 0x2000
 2  ld-linux.so + 0x3000`;
      const result = cleanStackwalkOutput(stdout, '');
      expect(result).not.toContain('=== Additional Information ===');
    });
  });

  describe('complex crash output', () => {
    it('should handle a full realistic crash output', () => {
      const stdout = `INFO: Loading symbols from /symbols
DEBUG: Looking up module foo.dll
Loading debug symbols for bar.dll
Operating system: Windows NT 10.0.19041
CPU: amd64
     family 6 model 142 stepping 12
     8 CPUs

Crash reason:  EXCEPTION_ACCESS_VIOLATION_READ
Crash address: 0x0000000000000000
Process uptime: 42 seconds

Thread 0 (crashed)
 0  app.exe!CrashFunction + 0x15
 1  app.exe!main + 0x120
 2  kernel32.dll!BaseThreadInitThunk + 0x14
 3  ntdll.dll!RtlUserThreadStart + 0x21

Thread 1
 0  ntdll.dll!NtWaitForSingleObject + 0x14
 1  KERNELBASE.dll!WaitForSingleObjectEx + 0x9f`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('Operating system');
      expect(result).toContain('Crash reason');
      expect(result).toContain('Thread 0 (crashed)');
      expect(result).toContain('CrashFunction');
      expect(result).not.toContain('INFO:');
      expect(result).not.toContain('DEBUG:');
      expect(result).not.toContain('Loading debug symbols');
    });

    it('should keep CPU detail continuation lines', () => {
      const stdout = `Operating system: Windows NT 10.0.19041
CPU: amd64
     family 6 model 142 stepping 12
     8 CPUs

Crash reason:  EXCEPTION_ACCESS_VIOLATION_READ
Crash address: 0x0000000000000000
Process uptime: 42 seconds

Thread 0 (crashed)
 0  app.exe!CrashFunction + 0x15
 1  app.exe!main + 0x120`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('family 6 model 142 stepping 12');
      expect(result).toContain('CPU: amd64');
    });
  });

  describe('loaded modules preservation', () => {
    it('should keep Loaded modules section', () => {
      const stdout = `Operating system: Linux
CPU: amd64
Process uptime: 5 seconds

Loaded modules:
0x616c306000 - 0x616c307fff  app_process64  ???
0x7f8a100000 - 0x7f8a1fffff  libtest.so  ???

Thread 0 (crashed)
 0  app_process64 + 0x1234
 1  libtest.so + 0x5678`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('Loaded modules:');
      expect(result).toContain('0x616c306000');
      expect(result).toContain('app_process64');
    });

    it('should filter Loaded symbols lines but keep Loaded modules', () => {
      const stdout = `Loaded symbols for ntdll.dll
Loaded modules:
0x400000 - 0x4fffff  app  ???

Thread 0 (crashed)
 0  app + 0x1234
 1  ntdll.dll + 0x5678
 2  kernel32.dll + 0x9abc`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).not.toContain('Loaded symbols for ntdll.dll');
      expect(result).toContain('Loaded modules:');
    });
  });

  describe('source file and register preservation', () => {
    it('should keep source file references', () => {
      const stdout = `Thread 0 (crashed)
 0  app.exe!CrashFunction + 0x15
    main.cpp:42
 1  app.exe!main + 0x120
    app.cpp:100`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('main.cpp:42');
      expect(result).toContain('app.cpp:100');
    });

    it('should keep Found by lines', () => {
      const stdout = `Thread 0 (crashed)
 0  app.exe!CrashFunction + 0x15
    Found by: given as instruction pointer in context
 1  app.exe!main + 0x120
    Found by: stack scanning`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('Found by: given as instruction pointer in context');
      // The trailing "Found by: stack scanning" line is consumed by the
      // low-confidence fold in the crashing thread; verify the fold summary
      // takes its place so users still see the frame was discarded.
      expect(result).toMatch(/low-confidence frame.* hidden/);
    });

    it('should keep register value lines', () => {
      const stdout = `Thread 0 (crashed)
 0  app.exe!CrashFunction + 0x15
    eax = 0x00000000  ebx = 0x12345678
    ecx = 0xdeadbeef  edx = 0x00000001`;

      const result = cleanStackwalkOutput(stdout, '');
      expect(result).toContain('eax = 0x00000000');
      expect(result).toContain('ecx = 0xdeadbeef');
    });
  });

  describe('low-confidence frame folding', () => {
    it('should fold contiguous stack-scanning frames in the crashing thread', () => {
      const stdout = `Crash reason: SIGSEGV
Crash address: 0x0
Operating system: Linux
CPU: amd64
Process uptime: 1 second
Thread 0 (crashed)
 0  app + 0x100
    Found by: given as instruction pointer in context
 1  app + 0x200
    Found by: stack scanning
 2  app + 0x300
    Found by: stack scanning
 3  app + 0x400
    Found by: stack scanning
 4  app + 0x500
    Found by: call frame info`;
      const result = cleanStackwalkOutput(stdout, '');
      // Folded summary line replaces three contiguous low-confidence frames
      expect(result).toMatch(/3 low-confidence frames hidden/);
      // High-confidence frames around the run remain visible
      expect(result).toContain('0  app + 0x100');
      expect(result).toContain('4  app + 0x500');
    });

    it('should not fold low-confidence frames in non-crashed threads', () => {
      const stdout = `Crash reason: SIGSEGV
Crash address: 0x0
Operating system: Linux
CPU: amd64
Process uptime: 1 second
Thread 0 (crashed)
 0  app + 0x100
    Found by: given as instruction pointer in context
Thread 1
 0  worker + 0x100
    Found by: stack scanning
 1  worker + 0x200
    Found by: stack scanning`;
      const result = cleanStackwalkOutput(stdout, '');
      // Non-crashed thread frames should pass through untouched
      expect(result).not.toMatch(/low-confidence frames hidden/);
      expect(result).toContain('0  worker + 0x100');
      expect(result).toContain('1  worker + 0x200');
    });
  });
});

describe('buildSymbolMatchReport', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dumpstorm-symmatch-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSym(moduleName: string, debugId: string): void {
    const dir = path.join(tmpRoot, moduleName, debugId);
    fs.mkdirSync(dir, { recursive: true });
    const baseName = moduleName.replace(/\.(pdb|exe|dll)$/i, '');
    fs.writeFileSync(path.join(dir, `${baseName}.sym`), 'MODULE windows x86_64 ' + debugId + ' ' + moduleName + '\n');
  }

  it('should report matched, missing, and version-mismatched modules', () => {
    writeSym('app.exe', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1');
    writeSym('libfoo.dll', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1'); // wrong id stored

    const machineDump = parseMachineFormat(`Module|app.exe|1.0|app.pdb|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1|0x400000|0x500000|1
Module|libfoo.dll|1.0|libfoo.pdb|CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC1|0x600000|0x700000|0
Module|missing.dll|1.0|missing.pdb|DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD1|0x800000|0x900000|0
`);

    const report = buildSymbolMatchReport(machineDump, tmpRoot, 'app.exe');
    expect(report.matched).toBe(1);
    expect(report.totalModules).toBe(3);
    expect(report.crashingModuleHasSymbols).toBe(true);
    expect(report.mismatched.map(m => m.name)).toEqual(['libfoo.dll']);
    expect(report.mismatched[0].foundIds).toEqual(['BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1']);
    expect(report.mismatched[0].expected).toBe('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC1');
    expect(report.missing).toEqual(['missing.dll']);
  });

  it('should flag the crashing module when its symbols are missing', () => {
    const machineDump = parseMachineFormat(`Module|app.exe|1.0|app.pdb|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1|0x400000|0x500000|1
`);
    const report = buildSymbolMatchReport(machineDump, tmpRoot, 'app.exe');
    expect(report.matched).toBe(0);
    expect(report.crashingModuleHasSymbols).toBe(false);
    expect(report.missing).toEqual(['app.exe']);
  });

  it('should render Symbol Match line in cleaned output when context is provided', () => {
    writeSym('app.exe', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1');
    const machineDump = parseMachineFormat(`Module|app.exe|1.0|app.pdb|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1|0x400000|0x500000|1
Module|libfoo.dll|1.0|libfoo.pdb|CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC1|0x600000|0x700000|0
`);
    const stdout = `Operating system: Windows NT
CPU: amd64
Crash reason: EXCEPTION_ACCESS_VIOLATION_READ
Crash address: 0x0
Process uptime: 1 second
Thread 0 (crashed)
 0  app.exe + 0x100
    Found by: given as instruction pointer in context`;
    const cleaned = cleanStackwalkOutput(stdout, '', { machineDump, symbolPath: tmpRoot });
    expect(cleaned).toMatch(/Symbol Match\s*:\s*1\/2 modules have matching \.sym/);
    expect(cleaned).toContain('1 missing');
  });
});
