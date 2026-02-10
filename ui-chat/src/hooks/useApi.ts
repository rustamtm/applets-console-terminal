import { useCallback } from "react";
import { useBasePath, buildApiUrl } from "./useBasePath";
import type { SessionInfo, AttachResponse } from "../types/events";

interface SessionsListResponse {
  sessions: SessionInfo[];
}

interface CreateSessionRequest {
  mode: "node" | "shell" | "readonly_tail" | "tmux";
  cwd?: string;
  cols?: number;
  rows?: number;
  resumeKey?: string;
}

interface CreateSessionResponse {
  sessionId: string;
  attachToken: string;
  wsUrl: string;
  tmuxName?: string;
}

export function useApi() {
  const basePath = useBasePath();

  const fetchJson = useCallback(
    async <T>(path: string, options?: RequestInit): Promise<T> => {
      const url = buildApiUrl(basePath, path);
      const res = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers
        }
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json();
    },
    [basePath]
  );

  const listSessions = useCallback(async (): Promise<SessionInfo[]> => {
    const data = await fetchJson<SessionsListResponse>("/api/sessions");
    return data.sessions;
  }, [fetchJson]);

  const createSession = useCallback(
    async (req: CreateSessionRequest): Promise<CreateSessionResponse> => {
      return fetchJson<CreateSessionResponse>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(req)
      });
    },
    [fetchJson]
  );

  const attachSession = useCallback(
    async (sessionId: string, cols?: number, rows?: number): Promise<AttachResponse> => {
      const response = await fetchJson<{ sessionId: string; attachToken: string; wsUrl: string }>(
        `/api/sessions/${sessionId}/attach`,
        {
          method: "POST",
          body: JSON.stringify({ cols, rows })
        }
      );
      // Build chat WebSocket URL from the regular wsUrl
      const chatWsUrl = response.wsUrl.replace("/ws/sessions/", "/ws/chat/sessions/");
      return {
        ...response,
        chatWsUrl
      };
    },
    [fetchJson]
  );

  const attachChatSession = useCallback(
    async (sessionId: string, cols?: number, rows?: number): Promise<AttachResponse> => {
      const response = await fetchJson<AttachResponse>(`/api/sessions/${sessionId}/attach-chat`, {
        method: "POST",
        body: JSON.stringify({ cols, rows })
      });
      return response;
    },
    [fetchJson]
  );

  const closeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      await fetchJson<{ ok: boolean }>(`/api/sessions/${sessionId}/close`, {
        method: "POST"
      });
    },
    [fetchJson]
  );

  return {
    basePath,
    listSessions,
    createSession,
    attachSession,
    attachChatSession,
    closeSession
  };
}
