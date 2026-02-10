import http from "node:http";
import express from "express";
import { createConsoleApp } from "./consoleApp.js";

const rawLog = console.log.bind(console);
const rawWarn = console.warn.bind(console);
const rawError = console.error.bind(console);

const stamp = () => `[${new Date().toISOString()} pid=${process.pid}]`;

// Prefix all server logs with timestamp + pid.
console.log = (...args: unknown[]) => rawLog(stamp(), ...args);
console.warn = (...args: unknown[]) => rawWarn(stamp(), ...args);
console.error = (...args: unknown[]) => rawError(stamp(), ...args);

function logExit(event: string, detail?: unknown) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    detail
  };
  try {
    // eslint-disable-next-line no-console
    console.error("[server-exit]", JSON.stringify(payload));
  } catch {
    // eslint-disable-next-line no-console
    console.error("[server-exit]", event, payload?.detail);
  }
}

process.on("uncaughtException", (err) => {
  logExit("uncaughtException", { message: err?.message, stack: err?.stack });
});

process.on("unhandledRejection", (reason: any) => {
  logExit("unhandledRejection", {
    reason: typeof reason === "object" ? { message: reason?.message, stack: reason?.stack } : String(reason)
  });
});

let shuttingDown = false;
const handleSignal = (signal: "SIGTERM" | "SIGINT") => {
  if (shuttingDown) return;
  shuttingDown = true;
  logExit(signal);
  try {
    shutdown();
  } catch {
    // ignore
  }
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  // If we still have open handles (e.g. WS clients), force-exit.
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("exit", (code) => logExit("exit", { code }));
process.on("beforeExit", (code) => logExit("beforeExit", { code }));

const app = express();
app.disable("x-powered-by");

const uiDist = process.env.CONSOLE_UI_DIST;
const { router, handleUpgrade, shutdown, config } = createConsoleApp(uiDist ? { uiDist } : undefined);
app.use(router);

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!handleUpgrade(req, socket, head)) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
});

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log("console-terminal listening", {
    pid: process.pid,
    host: config.host,
    port: config.port
  });
});
