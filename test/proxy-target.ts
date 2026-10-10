/*
 * Shared test target selector.
 *
 * The smoke tests (test/smoke-*.test.mjs) are written ONCE and run against
 * either of two targets, chosen entirely by environment:
 *
 *   - local  (default): the proxy runs IN-PROCESS via the plain-node Function
 *     URL RESPONSE_STREAM emulation in function-url-runtime.mjs. No network to
 *     a deployed function; the proxy still forwards verbatim to real AWS.
 *
 *   - deployed: the proxy is a LIVE deployed Function URL. The outer POST that
 *     carries the envelope is SigV4-signed for the `lambda` service (the URL is
 *     AuthType: AWS_IAM) and sent over real HTTPS. The function then forwards
 *     the inner signed request verbatim to real AWS and streams the response
 *     back.
 *
 * Both targets expose the identical SDK `requestHandler` contract, so the test
 * files never change — they just call makeProxyRequestHandler().
 *
 * Selection:
 *   PROXY_TARGET=local                       -> in-process emulation (default)
 *   PROXY_TARGET=deployed                    -> live Function URL
 *   PROXY_FUNCTION_URL=https://...on.aws/    -> required when deployed
 *   PROXY_URL_REGION=us-west-2               -> region to sign the outer POST
 *                                               (defaults to the region parsed
 *                                               from the Function URL host)
 *
 * Setting PROXY_FUNCTION_URL alone implies the deployed target.
 */
import {
  ProxyFunctionUrlRequestHandler,
  ProxyFunctionUrlHttpsRequestHandler,
} from './function-url-runtime.ts';

export function resolveTarget() {
  const explicit = (process.env.PROXY_TARGET || '').trim().toLowerCase();
  const functionUrl = (
    process.env.LAMBDA_FUNCTION_URL ||
    process.env.PROXY_FUNCTION_URL ||
    ''
  ).trim();

  // PROXY_FUNCTION_URL alone implies deployed; PROXY_TARGET wins if set.
  const target = explicit || (functionUrl ? 'deployed' : 'local');

  if (target === 'deployed') {
    if (!functionUrl) {
      throw new Error(
        'PROXY_TARGET=deployed requires LAMBDA_FUNCTION_URL to be set ' +
          '(e.g. https://<id>.lambda-url.<region>.on.aws/).'
      );
    }
    const region =
      (process.env.PROXY_URL_REGION || '').trim() ||
      regionFromFunctionUrl(functionUrl);
    if (!region) {
      throw new Error(
        'Could not determine the Function URL region. Set PROXY_URL_REGION.'
      );
    }
    return { target, functionUrl, region };
  }

  if (target !== 'local') {
    throw new Error(
      `Unknown PROXY_TARGET "${target}". Use "local" or "deployed".`
    );
  }
  return { target: 'local' };
}

/*
 * Build the SDK requestHandler for the resolved target. Shared by every smoke
 * test so one *.test.mjs runs against local OR deployed unchanged.
 */
export function makeProxyRequestHandler() {
  const t = resolveTarget();
  if (t.target === 'deployed') {
    return new ProxyFunctionUrlHttpsRequestHandler({
      functionUrl: t.functionUrl,
      region: t.region,
    });
  }
  return new ProxyFunctionUrlRequestHandler();
}

/* Human-readable description of where the tests are pointed (for logs). */
export function describeTarget() {
  const t = resolveTarget();
  return t.target === 'deployed'
    ? `deployed Function URL ${t.functionUrl} (signed for lambda in ${t.region})`
    : 'local in-process Function URL emulation';
}

/* Parse "<id>.lambda-url.<region>.on.aws" -> region. */
function regionFromFunctionUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const m = /\.lambda-url\.([^.]+)\.on\.aws$/.exec(host);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
