import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/** Maximum time allowed for one download request, including its response body. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Maximum number of redirects followed for a download. */
export const MAX_DOWNLOAD_REDIRECTS = 10;

export interface DownloadCancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export interface DownloadOptions {
    timeoutMs?: number;
    maxRedirects?: number;
    token?: DownloadCancellationToken;
}

export class DownloadError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'DownloadError';
    }
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatusCode(statusCode: number | undefined): boolean {
    return statusCode !== undefined && REDIRECT_STATUS_CODES.has(statusCode);
}

/**
 * Resolve a redirect target and reject unsupported protocols instead of
 * silently following a redirect to an unexpected resource type.
 */
export function resolveDownloadUrl(currentUrl: string, location: string): string {
    const resolved = new URL(location, currentUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        throw new DownloadError(`Unsupported redirect protocol: ${resolved.protocol}`, 'INVALID_REDIRECT');
    }
    return resolved.toString();
}

/**
 * Download a file with timeout, cancellation, and bounded redirect support.
 *
 * The destination is only created after the final 2xx response is received.
 * A partially written destination is removed when the download fails or is
 * cancelled.
 */
export function downloadFile(
    downloadUrl: string,
    destination: string,
    options: DownloadOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const maxRedirects = options.maxRedirects ?? MAX_DOWNLOAD_REDIRECTS;
    const token = options.token;

    return new Promise<void>((resolve, reject) => {
        let activeRequest: http.ClientRequest | undefined;
        let activeResponse: http.IncomingMessage | undefined;
        let output: fs.WriteStream | undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let cancellationDisposable: { dispose(): void } | undefined;
        let redirectCount = 0;
        let destinationCreated = false;
        let settled = false;

        const clearResources = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            cancellationDisposable?.dispose();
            cancellationDisposable = undefined;
        };

        const removePartialDestination = () => {
            if (!destinationCreated) {
                return;
            }
            try {
                if (fs.existsSync(destination)) {
                    fs.unlinkSync(destination);
                }
            } catch {
                // The original download error is more useful than cleanup
                // errors, so cleanup failures are intentionally ignored.
            }
        };

        const fail = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            clearResources();
            activeRequest?.destroy();
            activeResponse?.destroy();
            output?.destroy();
            removePartialDestination();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const complete = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearResources();
            resolve();
        };

        const startRequest = (currentUrl: string) => {
            if (settled) {
                return;
            }

            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }

            if (token?.isCancellationRequested) {
                fail(new DownloadError('Download cancelled by user', 'DOWNLOAD_CANCELLED'));
                return;
            }

            let parsedUrl: URL;
            try {
                parsedUrl = new URL(currentUrl);
            } catch (error) {
                fail(new DownloadError(`Invalid download URL: ${String(error)}`, 'INVALID_URL'));
                return;
            }

            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                fail(new DownloadError(`Unsupported download protocol: ${parsedUrl.protocol}`, 'INVALID_URL'));
                return;
            }

            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const request = transport.get(parsedUrl, response => {
                activeResponse = response;

                response.once('error', fail);

                if (isRedirectStatusCode(response.statusCode)) {
                    const location = response.headers.location;
                    response.resume();

                    if (!location) {
                        fail(new DownloadError(
                            `Redirect response ${response.statusCode} did not include a Location header`,
                            'INVALID_REDIRECT',
                        ));
                        return;
                    }

                    if (redirectCount >= maxRedirects) {
                        fail(new DownloadError(
                            `Too many redirects while downloading (maximum: ${maxRedirects})`,
                            'TOO_MANY_REDIRECTS',
                        ));
                        return;
                    }

                    try {
                        const nextUrl = resolveDownloadUrl(currentUrl, location);
                        redirectCount++;
                        startRequest(nextUrl);
                    } catch (error) {
                        fail(error);
                    }
                    return;
                }

                const statusCode = response.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    response.resume();
                    fail(new DownloadError(
                        `Download failed with HTTP ${statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}`,
                        'HTTP_ERROR',
                    ));
                    return;
                }

                try {
                    output = fs.createWriteStream(destination);
                    destinationCreated = true;
                } catch (error) {
                    fail(error);
                    return;
                }

                output.once('error', fail);
                output.once('finish', complete);
                response.pipe(output);
            });

            activeRequest = request;
            timeoutHandle = setTimeout(() => {
                fail(new DownloadError(
                    `Download timed out after ${timeoutMs} ms`,
                    'DOWNLOAD_TIMEOUT',
                ));
            }, timeoutMs);
            request.setTimeout(timeoutMs, () => {
                fail(new DownloadError(
                    `Download timed out after ${timeoutMs} ms`,
                    'DOWNLOAD_TIMEOUT',
                ));
            });
            request.once('error', fail);
        };

        if (token) {
            if (token.isCancellationRequested) {
                fail(new DownloadError('Download cancelled by user', 'DOWNLOAD_CANCELLED'));
                return;
            }
            if (token.onCancellationRequested) {
                cancellationDisposable = token.onCancellationRequested(() => {
                    fail(new DownloadError('Download cancelled by user', 'DOWNLOAD_CANCELLED'));
                });
            }
        }

        startRequest(downloadUrl);
    });
}

