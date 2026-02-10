import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const key = name.toLowerCase();
  const value = headers[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function isBasicAuthConfigured(user?: string, pass?: string) {
  return Boolean(user && pass);
}

export function verifyBasicAuth(headers: IncomingHttpHeaders, user: string, pass: string) {
  const auth = getHeader(headers, "authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    throw new Error("Missing basic auth");
  }
  const encoded = auth.slice("Basic ".length).trim();
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx === -1) throw new Error("Invalid basic auth");
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);
  if (!timingSafeEqual(u, user) || !timingSafeEqual(p, pass)) {
    throw new Error("Invalid basic auth");
  }
}

