import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IncomingHttpHeaders } from "node:http";

export type AccessUser = {
  userId: string;
  email?: string;
};

export type AccessVerifier = (headers: IncomingHttpHeaders) => Promise<AccessUser>;

function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const key = name.toLowerCase();
  const value = headers[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function getCookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = getHeader(headers, "cookie");
  if (!raw) return undefined;
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export function makeCloudflareAccessVerifier(issuer: string, audience: string): AccessVerifier {
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (headers) => {
    const token =
      getHeader(headers, "cf-access-jwt-assertion") ??
      getCookie(headers, "CF_Authorization") ??
      getCookie(headers, "cf_authorization");
    if (token) {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience
      });

      const userId = typeof payload.sub === "string" ? payload.sub : undefined;
      const email = typeof payload.email === "string" ? payload.email : undefined;

      if (!userId) {
        throw new Error("Access token missing sub");
      }

      return { userId, email };
    }

    const headerUserId = getHeader(headers, "cf-access-authenticated-user-id");
    const headerEmail = getHeader(headers, "cf-access-authenticated-user-email");
    if (headerUserId || headerEmail) {
      return {
        userId: headerUserId || headerEmail || "unknown",
        email: headerEmail
      };
    }

    throw new Error("Missing Cf-Access-Jwt-Assertion");
  };
}

export function makeNoAuthVerifier(): AccessVerifier {
  return async () => ({ userId: "local", email: "local" });
}
