import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import { HttpResponse } from '@smithy/protocol-http';

const BUILD_VERSION = "0.0.11";
class ProxyRequestHandler {
  client;
  host;
  port;
  basePath;
  constructor(opts = {}) {
    if (opts.proxyUrl) {
      const u = new URL(opts.proxyUrl);
      this.client = u.protocol === "http:" ? http : https;
      this.host = u.hostname;
      this.port = u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
      this.basePath = u.pathname.replace(/\/$/, "");
    } else {
      this.client = http;
      this.host = opts.proxyHost ?? "127.0.0.1";
      this.port = opts.proxyPort ?? 3e3;
      this.basePath = "";
    }
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
    return new Promise((resolve, reject) => {
      const proxyReq = this.client.request(
        {
          host: this.host,
          port: this.port,
          method: "POST",
          path: `${this.basePath}/`,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(envelopeBytes)
          }
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

export { BUILD_VERSION, ProxyRequestHandler, reassembleHeaders };
//# sourceMappingURL=proxy-request-handler.mjs.map
