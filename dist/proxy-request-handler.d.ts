import { HttpResponse } from '@smithy/protocol-http';
import { AwsCredentialIdentity, Provider } from '@smithy/types';

declare const BUILD_VERSION: string;
interface SignedRequest {
    method: string;
    path: string;
    query?: Record<string, string | string[] | null | undefined>;
    headers: Record<string, string>;
    body?: unknown;
}
interface ProxyRequestHandlerOptions {
    /**
     * The Function URL of the deployed proxy. Required. For local testing this
     * can be a plain-http URL (e.g. `http://127.0.0.1:3000/`); the outer POST is
     * SigV4-signed either way.
     */
    proxyUrl: string;
    /**
     * Region used to SigV4-sign the OUTER POST for the `lambda` service.
     * Defaults to the region parsed from the Function URL host. When the host is
     * not a Function URL (e.g. localhost) it falls back to `us-east-1` — the
     * value is irrelevant for a local proxy that does not verify the signature.
     */
    region?: string;
    /**
     * Credentials used to sign the OUTER POST. Defaults to the AWS default
     * credential provider chain.
     */
    credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
}
/**
 * A service-agnostic AWS SDK requestHandler that routes an already-signed
 * request through the Lambda HTTP proxy instead of directly to the signed host.
 *
 * It wraps the entire signed request (path, method, headers, body) in a JSON
 * envelope and POSTs it to the proxy. The OUTER POST is ALWAYS SigV4-signed for
 * the `lambda` service so it authenticates against the Function URL's
 * `AuthType: AWS_IAM`. The proxy unwraps the envelope and forwards the signed
 * request verbatim to the real host, so SigV4 verification at the upstream
 * passes unchanged. Works for any SigV4 service — S3, Bedrock, DynamoDB, etc. —
 * because it never interprets the payload.
 *
 * Two independent SigV4 signatures are in play, and they must not be confused:
 *   - INNER: the SDK already signed the request for its target service. That
 *     signature rides inside the envelope untouched.
 *   - OUTER: this handler signs the POST to the Function URL for service
 *     `lambda` in the URL's region, so the Function URL's IAM auth accepts it.
 *
 * Construct with just the URL:
 *   new ProxyRequestHandler({ proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/' })
 */
declare class ProxyRequestHandler {
    private readonly client;
    private readonly host;
    private readonly port;
    private readonly basePath;
    private readonly region;
    private readonly signer;
    constructor(opts: ProxyRequestHandlerOptions);
    handle(request: SignedRequest): Promise<{
        response: HttpResponse;
    }>;
}
declare function reassembleHeaders(headers: Record<string, string>): Record<string, string>;

export { BUILD_VERSION, ProxyRequestHandler, reassembleHeaders };
export type { ProxyRequestHandlerOptions };
