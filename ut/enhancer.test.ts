import {
  enhanceStackTraceWithSymbols,
  parseModuleBaseAddresses,
  findNearestSymbol,
  loadSymbolTable,
  clearSymbolCache,
  getCacheStats,
  testHelpers,
} from '../src/symbols/enhancer';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vscode is mocked globally via jest.config.js moduleNameMapper

describe('Symbol Enhancer', () => {

  describe('parseModuleBaseAddresses', () => {
    it('should parse module base addresses from loaded modules section', () => {
      const output = `Operating system: Linux
CPU: amd64

Loaded modules:
0x616c306000 - 0x616c307fff  app_process64  ???  (WARNING: No symbols)
0x7f8a100000 - 0x7f8a1fffff  libtest.so  ???

Thread 0 (crashed)
 0  app_process64 + 0x1234`;

      const result = parseModuleBaseAddresses(output);
      expect(result.get('app_process64')).toBe(0x616c306000);
      expect(result.get('libtest.so')).toBe(0x7f8a100000);
      // Base name should also be set
      expect(result.get('libtest')).toBe(0x7f8a100000);
    });

    it('should return empty map when no loaded modules section', () => {
      const output = `Thread 0 (crashed)
 0  module.dll + 0x1234`;
      const result = parseModuleBaseAddresses(output);
      expect(result.size).toBe(0);
    });

    it('should stop parsing at Thread section', () => {
      const output = `Loaded modules:
0x400000 - 0x4fffff  app  ???

Thread 0 (crashed)
0x500000 - 0x5fffff  this_should_not_be_parsed  ???`;

      const result = parseModuleBaseAddresses(output);
      expect(result.has('app')).toBe(true);
      expect(result.has('this_should_not_be_parsed')).toBe(false);
    });
  });

  describe('getLibraryBaseName', () => {
    const getLibraryBaseName = testHelpers.getLibraryBaseName;

    it('should strip .so extension', () => {
      expect(getLibraryBaseName('libtest.so')).toBe('libtest');
    });

    it('should strip .dylib extension', () => {
      expect(getLibraryBaseName('libfoo.dylib')).toBe('libfoo');
    });

    it('should strip .dll extension', () => {
      expect(getLibraryBaseName('module.dll')).toBe('module');
    });

    it('should return basename for paths', () => {
      expect(getLibraryBaseName('/usr/lib/libtest.so')).toBe('libtest');
    });

    it('should handle names without extension', () => {
      expect(getLibraryBaseName('dyld')).toBe('dyld');
    });

    it('should handle versioned .so files', () => {
      expect(getLibraryBaseName('libfoo.so.1')).toBe('libfoo');
      expect(getLibraryBaseName('libfoo.so.1.2.3')).toBe('libfoo');
      expect(getLibraryBaseName('/usr/lib/libssl.so.1.1')).toBe('libssl');
    });
  });

  describe('loadSymbolTable', () => {
    const fs = require('fs');
    const originalReadFileSync = fs.readFileSync;

    afterEach(() => {
      fs.readFileSync = originalReadFileSync;
    });

    it('should parse nm format output and keep only code symbols', () => {
      fs.readFileSync = jest.fn().mockReturnValue(
        `=== SYMBOLS FOR test ===
Generated: 2025-01-01T00:00:00Z
nm command output:

0000000000001000 T main
0000000000002000 T helper_function
0000000000003000 D global_var
0000000000004000 B uninit_var
0000000000005000 U external_ref`
      );

      const table = loadSymbolTable('/fake/path.txt');
      expect(table.get(0x1000)).toBe('main');
      expect(table.get(0x2000)).toBe('helper_function');
      // Data, BSS, and undefined symbols are filtered out (cannot back a code address)
      expect(table.has(0x3000)).toBe(false);
      expect(table.has(0x4000)).toBe(false);
      expect(table.has(0x5000)).toBe(false);
    });

    it('should accept weak symbols (W/w) as code symbols', () => {
      fs.readFileSync = jest.fn().mockReturnValue(
        `0000000000006000 W weak_func
0000000000007000 w weak_local`
      );

      const table = loadSymbolTable('/fake/path.txt');
      expect(table.get(0x6000)).toBe('weak_func');
      expect(table.get(0x7000)).toBe('weak_local');
    });

    it('should parse the nm -S size column when present', () => {
      fs.readFileSync = jest.fn().mockReturnValue(
        // addr  size  type  name
        `0000000000001000 0000000000000040 T short_func
0000000000002000 0000000000000200 T longer_func`
      );

      // Standalone loadSymbolTable returns Map<addr, name>; size is recorded
      // separately by the cache-backed path. Just verify the addresses and
      // names parse cleanly when the size column is present.
      const table = loadSymbolTable('/fake/path.txt');
      expect(table.get(0x1000)).toBe('short_func');
      expect(table.get(0x2000)).toBe('longer_func');
    });

    it('should handle 0x prefixed addresses', () => {
      fs.readFileSync = jest.fn().mockReturnValue(
        `0x0000000000001000 T prefixed_function`
      );

      const table = loadSymbolTable('/fake/path.txt');
      expect(table.get(0x1000)).toBe('prefixed_function');
    });

    it('should skip header and empty lines', () => {
      fs.readFileSync = jest.fn().mockReturnValue(
        `=== SYMBOLS FOR test ===
Generated: 2025-01-01
nm command output:

0000000000001000 T only_function`
      );

      const table = loadSymbolTable('/fake/path.txt');
      expect(table.size).toBe(1);
      expect(table.get(0x1000)).toBe('only_function');
    });

    it('should return empty map for invalid file', () => {
      fs.readFileSync = jest.fn().mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const table = loadSymbolTable('/nonexistent/path.txt');
      expect(table.size).toBe(0);
    });
  });

  it('recognizes collision-safe batch symbol filenames by module name', async () => {
    const symbolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumpstorm-enhancer-'));
    const symbolFile = path.join(symbolDir, 'foo_0123456789ab_nm.txt');
    fs.writeFileSync(symbolFile, [
      '=== SYMBOLS FOR foo ===',
      '0000000000000010 T fooFunction',
    ].join('\n'));

    try {
      const enhanced = await enhanceStackTraceWithSymbols(
        'Thread 0 (crashed)\n 0 foo.dll + 0x10',
        symbolDir,
      );
      expect(enhanced).toContain('fooFunction');
    } finally {
      fs.rmSync(symbolDir, { recursive: true, force: true });
    }
  });

  describe('findNearestSymbol', () => {
    let symbolTable: Map<number, string>;

    beforeEach(() => {
      symbolTable = new Map([
        [0x1000, 'func_a'],
        [0x2000, 'func_b'],
        [0x3000, 'func_c'],
        [0x5000, 'func_d'],
      ]);
    });

    it('should find exact match', () => {
      const result = findNearestSymbol(symbolTable, 0x2000, undefined, true);
      expect(result).toBe('func_b');
    });

    it('should find nearest symbol with offset', () => {
      const result = findNearestSymbol(symbolTable, 0x2100, undefined, true);
      expect(result).toBe('func_b+0x100');
    });

    it('should return null for address before all symbols', () => {
      const result = findNearestSymbol(symbolTable, 0x500, undefined, true);
      expect(result).toBeNull();
    });

    it('should return null for symbols too far away (> 0x10000)', () => {
      const result = findNearestSymbol(symbolTable, 0x5000 + 0x50001, undefined, true);
      expect(result).toBeNull();
    });

    it('should return [far] tag for symbols with relaxed threshold', () => {
      // Between 0x10000 and 0x50000
      const result = findNearestSymbol(symbolTable, 0x5000 + 0x20000, undefined, true);
      expect(result).toContain('[far]');
      expect(result).toContain('func_d');
    });

    it('should handle empty symbol table', () => {
      const emptyTable = new Map<number, string>();
      const result = findNearestSymbol(emptyTable, 0x1000, undefined, true);
      expect(result).toBeNull();
    });

    it('should handle offset mode correctly', () => {
      const result = findNearestSymbol(symbolTable, 0x3050, undefined, true);
      expect(result).toBe('func_c+0x50');
    });

    it('should subtract base address in non-offset mode', () => {
      const baseAddress = 0x100000;
      // Target runtime address: 0x101000, base: 0x100000 -> relative: 0x1000 -> func_a
      const result = findNearestSymbol(symbolTable, 0x101000, baseAddress, false);
      expect(result).toBe('func_a');
    });

    it('should handle non-offset mode without base address', () => {
      const result = findNearestSymbol(symbolTable, 0x2000, undefined, false);
      expect(result).toBe('func_b');
    });
  });

  describe('clearSymbolCache & getCacheStats', () => {
    it('should report initial cache size', () => {
      clearSymbolCache();
      const stats = getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(50);
    });
  });
});
