import type { Request } from "express";

export function requireAppToken(req: Request, expected?: string) {
  if (!expected) return;
  const token = req.header("x-app-token") || undefined;
  if (!token || token !== expected) {
    const err = new Error("Invalid X-App-Token");
    // @ts-expect-error express error shape
    err.statusCode = 401;
    throw err;
  }
}

