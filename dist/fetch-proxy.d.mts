import { AwsCredentialIdentity, Provider } from '@smithy/types';

declare const BUILD_VERSION: string;
interface FetchProxyOptions {
    proxyUrl: string;
    region?: string;
    credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
}
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
declare class FetchProxy {
    private readonly handler;
    constructor(opts: FetchProxyOptions);
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export { BUILD_VERSION, FetchProxy };
export type { Fetch, FetchProxyOptions };
