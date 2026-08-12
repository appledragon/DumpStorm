import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { extractZipWithPowerShell } from '../src/tools/base-installer';

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('extractZipWithPowerShell', () => {
    it('extracts a zip whose parent directory contains spaces', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds extract '));
        const payloadDir = path.join(root, 'payload');
        const dest = path.join(root, 'out dir');
        fs.mkdirSync(payloadDir, { recursive: true });
        fs.writeFileSync(path.join(payloadDir, 'hello.txt'), 'hi');
        const zip = path.join(root, 'breakpad-temp.zip');

        execFileSync('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Compress-Archive -LiteralPath $env:DS_SRC -DestinationPath $env:DS_ZIP -Force',
        ], {
            env: { ...process.env, DS_SRC: path.join(payloadDir, 'hello.txt'), DS_ZIP: zip },
            windowsHide: true,
        });

        extractZipWithPowerShell(zip, dest);

        expect(fs.existsSync(path.join(dest, 'hello.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('hi');

        fs.rmSync(root, { recursive: true, force: true });
    });
});
