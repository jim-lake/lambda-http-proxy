import { Writable } from 'node:stream';

interface FunctionUrlEvent {
    version: '2.0';
    rawPath?: string;
    rawQueryString?: string;
    cookies?: string[];
    headers?: Record<string, string>;
    body?: string;
    isBase64Encoded?: boolean;
    requestContext?: {
        http?: {
            method?: string;
            path?: string;
            protocol?: string;
            sourceIp?: string;
            userAgent?: string;
        };
    };
}
interface LambdaContext {
    awsRequestId: string;
    getRemainingTimeInMillis(): number;
}
interface ResponseMetadata {
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
}
interface ResponseStream extends Writable {
    __meta?: ResponseMetadata;
    __preludeWritten?: boolean;
    setResponseMeta?(meta: ResponseMetadata): void;
}
interface AwsLambdaGlobal {
    streamifyResponse(handler: (event: FunctionUrlEvent, responseStream: ResponseStream, context: LambdaContext) => Promise<void>): (event: FunctionUrlEvent, responseStream: ResponseStream, context: LambdaContext) => Promise<void>;
    HttpResponseStream: {
        from(stream: ResponseStream, metadata: ResponseMetadata): ResponseStream;
    };
}
declare global {
    var awslambda: AwsLambdaGlobal | undefined;
}
declare function proxy(event: FunctionUrlEvent, responseStream: ResponseStream): Promise<void>;
type ProxyFn = (event: FunctionUrlEvent, responseStream: ResponseStream, context: LambdaContext) => Promise<void>;
declare const handler: ProxyFn;

export { handler, proxy };
export type { AwsLambdaGlobal, FunctionUrlEvent, LambdaContext, ResponseMetadata, ResponseStream };
