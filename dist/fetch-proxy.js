import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@smithy/core/checksum';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

function regionFromHost(host) {
  const m = /\.lambda-url\.([^.]+)\.on\.aws$/.exec(host);
  return m ? m[1] : "";
}
class ProxyRequestHandler {
  client;
  host;
  port;
  basePath;
  region;
  signer;
  constructor(opts) {
    if (!opts.proxyUrl) {
      throw new Error("ProxyRequestHandler requires a proxyUrl");
    }
    const u = new URL(opts.proxyUrl);
    this.client = u.protocol === "http:" ? http : https;
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
    this.basePath = u.pathname.replace(/\/$/, "");
    const parsedRegion = regionFromHost(this.host);
    this.region = opts.region ?? (parsedRegion === "" ? "us-east-1" : parsedRegion);
    this.signer = new SignatureV4({
      service: "lambda",
      region: this.region,
      credentials: opts.credentials ?? defaultProvider(),
      sha256: Sha256
    });
  }
  async handle(request) {
    const signedPath = request.path + (request.query ? toQuery(request.query) : "");
    const signedBody = await collectBody(request.body);
    const envelope = {
      __proxyEnvelope: true,
      path: signedPath,
      method: request.method,
      headers: { ...request.headers },
      body: signedBody ? Buffer.from(signedBody).toString("base64") : void 0,
      bodyIsBase64: true
    };
    const envelopeBytes = Buffer.from(JSON.stringify(envelope), "utf8");
    const outerPath = `${this.basePath}/`;
    const protocol = this.client === http ? "http:" : "https:";
    const toSign = new HttpRequest({
      method: "POST",
      protocol,
      hostname: this.host,
      port: this.port,
      path: outerPath,
      headers: {
        host: this.host,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(envelopeBytes))
      },
      body: envelopeBytes
    });
    const signed = await this.signer.sign(toSign);
    return new Promise((resolve, reject) => {
      const proxyReq = this.client.request(
        {
          host: this.host,
          port: this.port,
          method: "POST",
          path: outerPath,
          headers: signed.headers
        },
        (proxyRes) => {
          resolve({
            response: new HttpResponse({
              statusCode: proxyRes.statusCode ?? 200,
              headers: reassembleHeaders(flattenHeaders(proxyRes.headers)),
              body: proxyRes
            })
          });
        }
      );
      proxyReq.on("error", reject);
      proxyReq.write(envelopeBytes);
      proxyReq.end();
    });
  }
}
function toQuery(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === void 0) {
      parts.push(encodeURIComponent(k));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
function flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === void 0) ; else if (Array.isArray(v)) {
      out[k] = v.join(", ");
    } else {
      out[k] = v;
    }
  }
  return out;
}
const REMAP_PREFIX = "x-amzn-remapped-";
const PROXY_REMAP_PREFIX = "x-lambda-proxy-remap-";
function reassembleHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith(PROXY_REMAP_PREFIX)) ; else if (lower.startsWith(REMAP_PREFIX)) {
      const canonical = lower.slice(REMAP_PREFIX.length);
      if (!Object.hasOwn(headers, canonical)) {
        out[canonical] = v;
      }
    } else {
      out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith(PROXY_REMAP_PREFIX)) {
      out[lower.slice(PROXY_REMAP_PREFIX.length)] = v;
    }
  }
  return out;
}
async function collectBody(body) {
  if (!body) {
    return void 0;
  }
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return body;
  }
  const chunks = [];
  for await (const c of body) {
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const BUILD_VERSION = "0.0.13";
const NULL_BODY_STATUS = /* @__PURE__ */ new Set([101, 204, 205, 304]);
class FetchProxy {
  handler;
  constructor(opts) {
    if (!opts.proxyUrl) {
      throw new Error("FetchProxy requires a proxyUrl");
    }
    this.handler = new ProxyRequestHandler({
      proxyUrl: opts.proxyUrl,
      region: opts.region,
      credentials: opts.credentials
    });
    this.fetch = this.fetch.bind(this);
  }
  async fetch(input, init) {
    const req = await normalizeRequest(input, init);
    if (req.signal?.aborted) {
      throw abortError(req.signal);
    }
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    const handlePromise = this.handler.handle({
      method: req.method,
      path,
      headers: req.headers,
      body: req.body
    });
    const { response } = await withAbort(handlePromise, req.signal);
    const nodeBody = response.body;
    const bodyless = req.method.toUpperCase() === "HEAD" || NULL_BODY_STATUS.has(response.statusCode) || response.headers["content-length"] === "0";
    if (bodyless) {
      nodeBody.resume();
      return buildResponse(null, response);
    }
    if (req.signal) {
      forwardAbortToStream(req.signal, nodeBody);
    }
    const webStream = Readable.toWeb(nodeBody);
    return buildResponse(webStream, response);
  }
}
async function normalizeRequest(input, init) {
  const src = typeof input === "object" && !(input instanceof URL) && typeof input.url === "string" ? input : void 0;
  let url;
  if (src) {
    url = src.url;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    url = input;
  }
  const method = init?.method ?? src?.method ?? "GET";
  let headers = {};
  if (src) {
    headers = mergeHeaders(headers, src.headers);
  }
  if (init?.headers !== void 0) {
    headers = mergeHeaders(headers, init.headers);
  }
  const body = await readBody(init, src);
  const signal = init?.signal ?? src?.signal ?? void 0;
  if (!hasHeader(headers, "host")) {
    headers = { ...headers, host: new URL(url).host };
  }
  return { method, url, headers, body, signal: signal ?? void 0 };
}
function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
function mergeHeaders(base, headers) {
  const out = { ...base };
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      assignHeader(out, key, value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const pairs = headers;
    for (const [key, value] of pairs) {
      assignHeader(out, key, value);
    }
    return out;
  }
  const record = headers;
  for (const [key, value] of Object.entries(record)) {
    if (value !== void 0) {
      assignHeader(out, key, value);
    }
  }
  return out;
}
function assignHeader(out, key, value) {
  const existing = Object.keys(out).find(
    (k) => k.toLowerCase() === key.toLowerCase()
  );
  if (existing !== void 0 && existing !== key) {
    Reflect.deleteProperty(out, existing);
  }
  out[key] = value;
}
async function readBody(init, src) {
  if (init && "body" in init && init.body !== null && init.body !== void 0) {
    return bodyToBuffer(init.body);
  }
  if (src?.body !== null && src?.body !== void 0) {
    const buf = Buffer.from(await src.arrayBuffer());
    return buf.length > 0 ? buf : void 0;
  }
  return void 0;
}
function bodyToBuffer(body) {
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError(
    "FetchProxy: unsupported request body type; expected string, ArrayBuffer, or a typed-array view"
  );
}
function buildResponse(body, response) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    headers.set(key, value);
  }
  return new Response(body, { status: response.statusCode, headers });
}
async function withAbort(promise, signal) {
  if (!signal) {
    return promise;
  }
  const activeSignal = signal;
  return new Promise((resolve, reject) => {
    function onAbort() {
      reject(abortError(activeSignal));
    }
    activeSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        activeSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        activeSignal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
function forwardAbortToStream(signal, stream) {
  if (signal.aborted) {
    stream.destroy(abortError(signal));
    return;
  }
  signal.addEventListener(
    "abort",
    () => {
      stream.destroy(abortError(signal));
    },
    { once: true }
  );
}
function abortError(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

export { BUILD_VERSION, FetchProxy };
//# sourceMappingURL=fetch-proxy.js.map
