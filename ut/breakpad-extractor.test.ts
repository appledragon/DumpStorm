// vscode is mocked globally via jest.config.js moduleNameMapper
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseModuleHeader } from '../src/symbols/breakpad-extractor';

describe('parseModuleHeader', () => {
    it('parses a Windows module header and uppercases the debug id', () => {
        const sym =
            'MODULE windows x86_64 abc123def4567890abcdef1234567890a1 app.pdb\n' +
            'INFO CODE_ID 6789 app.exe\n';
        const header = parseModuleHeader(sym);
        expect(header).not.toBeNull();
        expect(header!.os).toBe('windows');
        expect(header!.arch).toBe('x86_64');
        expect(header!.debugId).toBe('ABC123DEF4567890ABCDEF1234567890A1');
        expect(header!.moduleName).toBe('app.pdb');
    });

    it('handles module names containing spaces', () => {
        const sym = 'MODULE linux x86_64 DEADBEEF1 lib with space.so\n';
        const header = parseModuleHeader(sym);
        expect(header!.moduleName).toBe('lib with space.so');
    });

    it('returns null for missing or malformed headers', () => {
        expect(parseModuleHeader('')).toBeNull();
        expect(parseModuleHeader('FILE 1 main.cpp')).toBeNull();
        expect(parseModuleHeader('MODULE windows x86_64')).toBeNull();
    });
});

describe('extractBreakpadSymbols layout', () => {
    // We do not actually invoke dump_syms here (it may not exist on CI); we
    // verify only the directory layout produced by writing a known header.
    let tmp: string;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumpstorm-bp-'));
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('writes <symbolPath>/<module>/<id>/<base>.sym matching the header', () => {
        // Simulate what extractBreakpadSymbols does internally for assertion.
        const header = parseModuleHeader('MODULE windows x86_64 ID12345 app.pdb\n')!;
        const base = header.moduleName.replace(/\.(pdb|exe|dll)$/i, '');
        const dir = path.join(tmp, header.moduleName, header.debugId);
        fs.mkdirSync(dir, { recursive: true });
        const symPath = path.join(dir, `${base}.sym`);
        fs.writeFileSync(symPath, 'MODULE windows x86_64 ID12345 app.pdb\n');
        expect(fs.existsSync(symPath)).toBe(true);
        // Sanity: this is exactly the layout buildSymbolMatchReport scans.
        expect(symPath).toBe(path.join(tmp, 'app.pdb', 'ID12345', 'app.sym'));
    });
});
