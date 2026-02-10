/**
 * Get the base path for API/WebSocket requests.
 * Injected by the server via window.__CONSOLE_BASE_PATH__
 */
export function useBasePath(): string {
  const win = window as unknown as { __CONSOLE_BASE_PATH__?: string };
  return win.__CONSOLE_BASE_PATH__ ?? "";
}

/**
 * Build a full API URL with base path
 */
export function buildApiUrl(basePath: string, path: string): string {
  return basePath ? `${basePath}${path}` : path;
}

/**
 * Build a WebSocket URL with base path
 */
export function buildWsUrl(basePath: string, path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const fullPath = basePath ? `${basePath}${path}` : path;
  return `${protocol}//${host}${fullPath}`;
}
