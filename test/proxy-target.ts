import {
  startLocalProxyServer,
  type LocalProxyServer,
} from './function-url-runtime.ts';

export function resolveTarget() {
  const explicit = (process.env.PROXY_TARGET || '').trim().toLowerCase();
  const functionUrl = (
    process.env.LAMBDA_FUNCTION_URL ||
    process.env.PROXY_FUNCTION_URL ||
    ''
  ).trim();

  const target = explicit || 'deployed';

  if (target === 'deployed') {
    if (!functionUrl) {
      throw new Error(
        'Deployed tests require LAMBDA_FUNCTION_URL to be set ' +
          '(e.g. https://<id>.lambda-url.<region>.on.aws/). ' +
          'Set PROXY_TARGET=local only when developing the Lambda handler.'
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
      `Unknown PROXY_TARGET "${target}". Use "deployed" (default) or "local".`
    );
  }
  return { target: 'local' };
}

export interface TargetFixture {
  before: () => Promise<void>;
  after: () => Promise<void>;
  readonly proxyUrl: string;
  readonly region: string | undefined;
}

export function createTargetFixture(): TargetFixture {
  const t = resolveTarget();

  if (t.target === 'deployed') {
    return {
      before: () => Promise.resolve(),
      after: () => Promise.resolve(),
      proxyUrl: t.functionUrl!,
      region: t.region,
    };
  }

  let local: LocalProxyServer | undefined;
  return {
    before: async () => {
      local = await startLocalProxyServer();
    },
    after: async () => {
      await local?.close();
      local = undefined;
    },
    get proxyUrl(): string {
      if (!local) {
        throw new Error(
          'local proxy server not started — call fixture.before() first'
        );
      }
      return local.url;
    },
    region: undefined,
  };
}

export function describeTarget() {
  const t = resolveTarget();
  return t.target === 'deployed'
    ? `deployed Function URL ${t.functionUrl} (signed for lambda in ${t.region})`
    : 'local in-process Function URL emulation';
}

function regionFromFunctionUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const m = /\.lambda-url\.([^.]+)\.on\.aws$/.exec(host);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
