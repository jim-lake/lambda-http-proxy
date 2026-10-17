import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';

const BUILD_VERSION = "0.0.14";
const PRELUDE_DELIMITER = Buffer.alloc(8);
const EMPTY_FLUSH = Buffer.alloc(0);
const HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const LAMBDA_INJECTED_PREFIXES = ["x-forwarded-", "cloudfront-"];
const LAMBDA_INJECTED_EXACT = /* @__PURE__ */ new Set([
  "x-amzn-trace-id",
  "x-amz-cf-id",
  "via"
]);
function resolveTarget(headers) {
  const signedHost = headers.host;
  if (!signedHost) {
    throw new Error(
      "No Host header on the signed request; cannot determine upstream target"
    );
  }
  const scheme = (process.env.PROXY_TARGET_SCHEME ?? "https").toLowerCase();
  return { targetHost: signedHost, signedHost, scheme };
}
function parseEvent(event) {
  const method = event.requestContext?.http?.method ?? "GET";
  const eventHeaders = { ...event.headers ?? {} };
  if (Array.isArray(event.cookies) && event.cookies.length > 0) {
    eventHeaders.cookie = event.cookies.join("; ");
  }
  let rawBody;
  if (event.body !== void 0) {
    rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
  }
  const envelope = tryParseEnvelope(rawBody);
  if (envelope) {
    const body = envelope.body === void 0 ? void 0 : envelope.bodyIsBase64 ? Buffer.from(envelope.body, "base64") : Buffer.from(envelope.body, "utf8");
    return {
      method: envelope.method ?? method,
      path: envelope.path,
      headers: { ...envelope.headers ?? {} },
      body
    };
  }
  const rawPath = event.rawPath ?? "/";
  const rawQuery = event.rawQueryString ? `?${event.rawQueryString}` : "";
  return {
    method,
    path: `${rawPath}${rawQuery}`,
    headers: eventHeaders,
    body: rawBody
  };
}
function tryParseEnvelope(rawBody) {
  if (!rawBody || rawBody.length === 0) {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return void 0;
  }
  if (parsed && typeof parsed === "object" && parsed.__proxyEnvelope === true && typeof parsed.path === "string") {
    return parsed;
  }
  return void 0;
}
function isStrippableRequestHeader(lower) {
  return HOP_BY_HOP.has(lower) || LAMBDA_INJECTED_EXACT.has(lower) || LAMBDA_INJECTED_PREFIXES.some((p) => lower.startsWith(p));
}
function buildUpstreamHeaders(headers, { signedHost }) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isStrippableRequestHeader(name.toLowerCase())) {
      out[name] = value;
    }
  }
  out.host = signedHost;
  return out;
}
function filterResponseHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      out[name] = value;
    }
  }
  return out;
}
const REMAP_PREFIX = "x-lambda-proxy-remap-";
const EDGE_MANGLED_HEADERS = /* @__PURE__ */ new Set([
  "content-length",
  "content-type",
  "content-encoding",
  "content-range",
  "content-disposition",
  "content-language",
  "www-authenticate"
]);
function smuggleMangledHeaders(headers) {
  const out = {
    ...headers
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== void 0 && EDGE_MANGLED_HEADERS.has(name.toLowerCase())) {
      out[`${REMAP_PREFIX}${name.toLowerCase()}`] = value;
    }
  }
  return out;
}
function applyResponseMetadata(responseStream, meta) {
  if (globalThis.awslambda?.HttpResponseStream.from) {
    return globalThis.awslambda.HttpResponseStream.from(responseStream, meta);
  }
  responseStream.__meta = meta;
  if (typeof responseStream.setResponseMeta === "function") {
    responseStream.setResponseMeta(meta);
  }
  if (responseStream.__preludeWritten !== true) {
    responseStream.__preludeWritten = true;
    responseStream.write(Buffer.from(JSON.stringify(meta), "utf8"));
    responseStream.write(PRELUDE_DELIMITER);
  }
  return responseStream;
}
async function forwardAndStream(args, responseStream) {
  const { method, path, upstreamHeaders, body, targetHost, scheme } = args;
  return new Promise((resolve, reject) => {
    const client = scheme === "http" ? http : https;
    const [hostname, portStr] = targetHost.split(":");
    const port = portStr ? Number(portStr) : scheme === "http" ? 80 : 443;
    const req = client.request(
      {
        hostname,
        port,
        method,
        path,
        headers: upstreamHeaders,
        servername: hostname
      },
      (upstream) => {
        const statusCode = upstream.statusCode ?? 502;
        const contentLength = upstream.headers["content-length"];
        const bodyless = method.toUpperCase() === "HEAD" || statusCode === 204 || statusCode === 304 || contentLength === "0";
        const headers = smuggleMangledHeaders(
          filterResponseHeaders(upstream.headers)
        );
        const stream = applyResponseMetadata(responseStream, {
          statusCode,
          headers
        });
        upstream.on("error", reject);
        stream.on("error", reject);
        if (bodyless) {
          upstream.resume();
          stream.write(EMPTY_FLUSH);
          stream.end();
          resolve();
          return;
        }
        upstream.on("end", resolve);
        upstream.pipe(stream);
      }
    );
    req.on("error", reject);
    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}
async function proxy(event, responseStream) {
  const { method, path, headers, body } = parseEvent(event);
  const target = resolveTarget(headers);
  const upstreamHeaders = buildUpstreamHeaders(headers, target);
  await forwardAndStream(
    {
      method,
      path,
      upstreamHeaders,
      body,
      targetHost: target.targetHost,
      scheme: target.scheme
    },
    responseStream
  );
}
function streamify(fn) {
  const runtime = globalThis.awslambda;
  if (typeof runtime?.streamifyResponse === "function") {
    return runtime.streamifyResponse(fn);
  }
  return fn;
}
const handler = streamify(
  async (event, responseStream, _context) => {
    try {
      await proxy(event, responseStream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const stream = applyResponseMetadata(responseStream, {
          statusCode: 502,
          headers: { "content-type": "text/plain" }
        });
        if (!stream.writableEnded) {
          stream.write(`proxy error: ${message}`);
        }
      } catch {
      } finally {
        if (!responseStream.writableEnded) {
          responseStream.end();
        }
      }
      return;
    }
    if (!responseStream.writableEnded) {
      responseStream.end();
    }
  }
);

export { BUILD_VERSION, REMAP_PREFIX, handler, proxy };
//# sourceMappingURL=lambda-outbound-proxy.mjs.map
