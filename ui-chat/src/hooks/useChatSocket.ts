import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachResponse, ChatEvent, ConnectionState } from "../types/events";

interface UseChatSocketOptions {
  sessionId: string | null;
  attach: (sessionId: string) => Promise<AttachResponse>;
  onEvent?: (event: ChatEvent) => void;
}

export interface SendOptions {
  messageId?: string;
  enter?: boolean;
}

interface UseChatSocketResult {
  connectionState: ConnectionState;
  lastSeq: number;
  send: (text: string, options?: SendOptions) => void;
  disconnect: () => void;
}

export function useChatSocket(options: UseChatSocketOptions): UseChatSocketResult {
  const { sessionId, attach, onEvent } = options;

  const wsBase = useMemo(() => (window.location.protocol === "https:" ? "wss:" : "ws:"), []);

  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [lastSeq, setLastSeq] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectEpochRef = useRef(0);
  const lastSeqRef = useRef(0);
  const manualDisconnectRef = useRef(false);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    clearReconnectTimeout();
    reconnectAttemptsRef.current = 0;
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    setConnectionState("disconnected");
  }, [clearReconnectTimeout]);

  const scheduleReconnect = useCallback(
    (connectFn: () => void) => {
      if (manualDisconnectRef.current) return;
      if (reconnectAttemptsRef.current >= 8) {
        setConnectionState("disconnected");
        return;
      }
      setConnectionState("reconnecting");
      const delay = Math.min(500 * Math.pow(2, reconnectAttemptsRef.current), 30_000);
      reconnectAttemptsRef.current += 1;
      clearReconnectTimeout();
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connectFn();
      }, delay);
    },
    [clearReconnectTimeout]
  );

  const connect = useCallback(() => {
    if (!sessionId) return;

    manualDisconnectRef.current = false;
    clearReconnectTimeout();
    setConnectionState("connecting");

    const epoch = ++connectEpochRef.current;
    const afterSeq = lastSeqRef.current;

    void (async () => {
      let resp: AttachResponse;
      try {
        resp = await attach(sessionId);
      } catch {
        if (connectEpochRef.current !== epoch) return;
        scheduleReconnect(connect);
        return;
      }
      if (connectEpochRef.current !== epoch) return;

      const url = new URL(resp.chatWsUrl, window.location.href);
      url.protocol = wsBase;
      url.searchParams.set("attachToken", resp.attachToken);
      if (afterSeq > 0) url.searchParams.set("afterSeq", String(afterSeq));

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        if (connectEpochRef.current !== epoch) return;
        reconnectAttemptsRef.current = 0;
        setConnectionState("connected");
      };

      ws.onclose = () => {
        if (connectEpochRef.current !== epoch) return;
        wsRef.current = null;
        scheduleReconnect(connect);
      };

      ws.onerror = () => {
        // Error will trigger onclose
      };

      ws.onmessage = (event) => {
        try {
          const data = event.data;
          if (typeof data !== "string") return;
          const parsed = JSON.parse(data) as ChatEvent;

          const seq = Number(parsed.seq ?? 0);
          if (Number.isFinite(seq) && seq > 0) {
            if (seq <= lastSeqRef.current) return; // dedupe replay / reconnect duplicates
            lastSeqRef.current = seq;
            setLastSeq(seq);
          }

          onEvent?.(parsed);
        } catch (err) {
          // Keep the socket alive; just surface parse issues in the console.
          console.error("[chat] Failed to parse message:", err);
        }
      };
    })();
  }, [attach, clearReconnectTimeout, onEvent, scheduleReconnect, sessionId, wsBase]);

  const send = useCallback((text: string, sendOptions?: SendOptions) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = {
      type: "user_input",
      text,
      enter: sendOptions?.enter !== false
    };
    if (sendOptions?.messageId) payload.messageId = sendOptions.messageId;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore send failures (onclose will handle reconnect)
    }
  }, []);

  // Reset sequence tracking whenever switching sessions.
  useEffect(() => {
    lastSeqRef.current = 0;
    setLastSeq(0);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      disconnect();
      return;
    }
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect, sessionId]);

  return {
    connectionState,
    lastSeq,
    send,
    disconnect
  };
}

