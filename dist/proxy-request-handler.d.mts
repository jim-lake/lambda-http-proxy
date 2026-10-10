import { HttpResponse } from '@smithy/protocol-http';

declare const BUILD_VERSION: string;
interface SignedRequest {
    method: string;
    path: string;
    query?: Record<string, string | string[] | null | undefined>;
    headers: Record<string, string>;
    body?: unknown;
}
interface ProxyRequestHandlerOptions {
    /** Production: the HTTPS Function URL of the deployed proxy. */
    proxyUrl?: string;
    /** Local testing: proxy host over plain HTTP (default 127.0.0.1). */
    proxyHost?: string;
    /** Local testing: proxy port over plain HTTP (default 3000). */
    proxyPort?: number;
}
/**
 * A service-agnostic AWS SDK requestHandler that routes an already-signed
 * request through the Lambda HTTP proxy instead of directly to the signed host.
 *
 * It wraps the entire signed request (path, method, headers, body) in a JSON
 * envelope and POSTs it to the proxy. The proxy unwraps it and forwards the
 * signed request verbatim to the real host, so SigV4 verification at the
 * upstream passes unchanged. Works for any SigV4 service — S3, Bedrock,
 * DynamoDB, etc. — because it never interprets the payload.
 *
 * Construct with either:
 *   { proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/' }   (production)
 *   { proxyHost: '127.0.0.1', proxyPort: 3000 }                 (local http)
 */
declare class ProxyRequestHandler {
    private readonly client;
    private readonly host;
    private readonly port;
    private readonly basePath;
    constructor(opts?: ProxyRequestHandlerOptions);
    handle(request: SignedRequest): Promise<{
        response: HttpResponse;
    }>;
}
declare function reassembleHeaders(headers: Record<string, string>): Record<string, string>;

export { BUILD_VERSION, ProxyRequestHandler, reassembleHeaders };
export type { ProxyRequestHandlerOptions };
