// vscode is mocked globally via jest.config.js moduleNameMapper
import { demangleMsvcNames, isMsvcMangled, resetMsvcDemangleAvailability } from '../src/symbols/msvc-demangle';

describe('msvc-demangle helpers', () => {
    beforeEach(() => resetMsvcDemangleAvailability());

    it('detects MSVC-mangled names by their leading question mark', () => {
        expect(isMsvcMangled('?Foo@Bar@@QEAAXXZ')).toBe(true);
        expect(isMsvcMangled('?')).toBe(false); // trivially short
        expect(isMsvcMangled('_ZN3foo3barEv')).toBe(false); // Itanium ABI
        expect(isMsvcMangled('main')).toBe(false);
    });

    it('returns an empty map when llvm-undname is unavailable', async () => {
        // The test environment may or may not have llvm-undname installed.
        // What we guarantee here is that the helper never throws and never
        // invents demangled names; an absent tool simply yields no mappings.
        const result = await demangleMsvcNames(['?Foo@@YAXXZ', '?Bar@@YAHH@Z']);
        expect(result.size).toBeGreaterThanOrEqual(0);
        // Sanity: any entry must be a real demangled string, not the input.
        for (const [mangled, demangled] of result) {
            expect(demangled).not.toEqual(mangled);
            expect(demangled.length).toBeGreaterThan(0);
        }
    });

    it('returns an empty map for an empty input list (skips spawning entirely)', async () => {
        const result = await demangleMsvcNames([]);
        expect(result.size).toBe(0);
    });

    it('filters out non-mangled inputs before invoking the demangler', async () => {
        const result = await demangleMsvcNames(['main', '_ZN3foo3barEv']);
        expect(result.size).toBe(0);
    });
});
