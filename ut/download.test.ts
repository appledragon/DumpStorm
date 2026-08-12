import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
    downloadFile,
    isRedirectStatusCode,
    resolveDownloadUrl,
} from '../src/tools/download';

describe('Download helpers', () => {
    let server: http.Server;
    let baseUrl: string;
    let tempDir: string;

    beforeAll(async () => {
        server = http.createServer((request, response) => {
            const requestPath = request.url ?? '';

            if (requestPath.startsWith('/redirect/')) {
                const statusCode = Number(requestPath.split('/')[2]);
                response.writeHead(statusCode, { Location: '/payload' });
                response.end();
                return;
            }

            if (requestPath === '/payload') {
                response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                response.end('downloaded content');
                return;
            }

            if (requestPath === '/slow') {
                // Keep the request open so timeout and cancellation can be tested.
                return;
            }

            response.writeHead(404);
            response.end();
        });

        await new Promise<void>(resolve => {
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumpstorm-download-'));
    });

    afterAll(async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it.each([301, 302, 303, 307, 308])('follows HTTP %i redirects', async statusCode => {
        const destination = path.join(tempDir, `redirect-${statusCode}.bin`);

        await downloadFile(`${baseUrl}/redirect/${statusCode}`, destination);

        expect(fs.readFileSync(destination, 'utf8')).toBe('downloaded content');
    });

    it('recognizes every supported redirect status', () => {
        expect([301, 302, 303, 307, 308].every(isRedirectStatusCode)).toBe(true);
        expect(isRedirectStatusCode(300)).toBe(false);
        expect(isRedirectStatusCode(200)).toBe(false);
    });

    it('resolves relative and absolute redirect URLs', () => {
        expect(resolveDownloadUrl('https://example.com/a/file', '../b')).toBe('https://example.com/b');
        expect(resolveDownloadUrl('https://example.com/a', 'https://cdn.example.com/file'))
            .toBe('https://cdn.example.com/file');
    });

    it('rejects when the request exceeds the timeout', async () => {
        const destination = path.join(tempDir, 'timeout.bin');

        await expect(downloadFile(`${baseUrl}/slow`, destination, { timeoutMs: 50 }))
            .rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
        expect(fs.existsSync(destination)).toBe(false);
    });

    it('aborts an in-flight request when cancelled', async () => {
        const listeners = new Set<() => void>();
        const token = {
            isCancellationRequested: false,
            onCancellationRequested(listener: () => void) {
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
            },
        };
        const destination = path.join(tempDir, 'cancelled.bin');

        const download = downloadFile(`${baseUrl}/slow`, destination, { token });
        token.isCancellationRequested = true;
        listeners.forEach(listener => listener());

        await expect(download).rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
        expect(fs.existsSync(destination)).toBe(false);
    });
});

