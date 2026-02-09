// vscode is mocked globally via jest.config.js moduleNameMapper
import { cleanStackwalkOutput } from '../src/analysis/stackwalk';

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
  });
});
