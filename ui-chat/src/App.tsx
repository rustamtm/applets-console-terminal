import React, { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { useApi } from "./hooks/useApi";
import { useChatSocket } from "./hooks/useChatSocket";
import type { ChatEvent, ChatMessage, ChatSettings, SessionInfo } from "./types/events";

const DEFAULT_SETTINGS: ChatSettings = {
  groupOutput: true,
  showAnsi: false,
  autoScroll: true,
  monospaceOutput: true,
  showTimestamps: false
};

export const App: React.FC = () => {
  const { listSessions, createSession, attachChatSession, attachSession } = useApi();

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  
  const messageIdCounter = useRef(0);
  const pendingPatchesRef = useRef(new Map<string, { appendText: string; rawAppendText?: string; seqEnd: number }>());
  const patchFlushRafRef = useRef<number | null>(null);
  const settingsRef = useRef<ChatSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Fetch sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        const list = await listSessions();
        setSessions(list);
        // Auto-select first session if available
        if (list.length > 0 && !currentSessionId) {
          setCurrentSessionId(list[0].id);
        }
      } catch (err) {
        console.error("Failed to load sessions:", err);
      }
    };
    loadSessions();
    // Refresh sessions periodically
    const interval = setInterval(loadSessions, 10000);
    return () => clearInterval(interval);
  }, [listSessions, currentSessionId]);

  const handleSessionChange = useCallback(
    async (sessionId: string) => {
      pendingPatchesRef.current.clear();
      setMessages([]);
      setCurrentSessionId(sessionId);
    },
    []
  );

  const handleNewSession = useCallback(async () => {
    try {
      const response = await createSession({ mode: "shell" });
      // Refresh sessions list
      const list = await listSessions();
      setSessions(list);
      // Attach to new session
      handleSessionChange(response.sessionId);
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [createSession, listSessions, handleSessionChange]);

  const attach = useCallback(
    async (sessionId: string) => {
      try {
        return await attachChatSession(sessionId);
      } catch {
        return await attachSession(sessionId);
      }
    },
    [attachChatSession, attachSession]
  );

  const flushPendingPatches = useCallback(() => {
    if (patchFlushRafRef.current !== null) {
      cancelAnimationFrame(patchFlushRafRef.current);
      patchFlushRafRef.current = null;
    }
    const pending = pendingPatchesRef.current;
    if (pending.size === 0) return;
    const batch = new Map(pending);
    pending.clear();

    setMessages((prev) =>
      prev.map((m) => {
        const patch = batch.get(m.messageId);
        if (!patch) return m;
        const rawText = typeof (m.meta as any)?.rawText === "string" ? String((m.meta as any).rawText) : "";
        return {
          ...m,
          text: m.text + patch.appendText,
          seqEnd: Math.max(m.seqEnd, patch.seqEnd),
          isStreaming: true,
          meta: {
            ...(m.meta || {}),
            rawText: rawText + (patch.rawAppendText || "")
          }
        };
      })
    );
  }, []);

  const schedulePatchFlush = useCallback(() => {
    if (patchFlushRafRef.current !== null) return;
    patchFlushRafRef.current = requestAnimationFrame(() => {
      patchFlushRafRef.current = null;
      flushPendingPatches();
    });
  }, [flushPendingPatches]);

  const onEvent = useCallback(
    (evt: ChatEvent) => {
      if (evt.type === "hello" || evt.type === "snapshot_ready" || evt.type === "prompt_ready") return;

      if (evt.type === "message_patch") {
        const patch = pendingPatchesRef.current.get(evt.payload.messageId) || { appendText: "", seqEnd: 0 };
        patch.appendText += String(evt.payload.appendText || "");
        if (typeof (evt.payload as any).rawAppendText === "string") {
          patch.rawAppendText = (patch.rawAppendText || "") + String((evt.payload as any).rawAppendText || "");
        }
        patch.seqEnd = Math.max(patch.seqEnd, evt.seq);
        pendingPatchesRef.current.set(evt.payload.messageId, patch);
        schedulePatchFlush();
        return;
      }

      if (evt.type === "message_commit") {
        pendingPatchesRef.current.delete(evt.payload.messageId);
        flushPendingPatches();
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.messageId === evt.payload.messageId);
          if (idx === -1) return prev;

          const existing = prev[idx]!;
          const rawText =
            typeof (evt.payload as any).rawFinalText === "string"
              ? String((evt.payload as any).rawFinalText)
              : typeof (existing.meta as any)?.rawText === "string"
                ? String((existing.meta as any).rawText)
                : "";
          const updated: ChatMessage = {
            ...existing,
            text: String(evt.payload.finalText || ""),
            seqEnd: Math.max(existing.seqEnd, evt.seq),
            isStreaming: false,
            meta: {
              ...(existing.meta || {}),
              rawText
            }
          };

          const next = [...prev];
          next[idx] = updated;

          const cfg = settingsRef.current;
          if (!cfg.groupOutput) return next;

          const prevMsg = next[idx - 1];
          if (
            prevMsg &&
            prevMsg.role === "system" &&
            prevMsg.channel === updated.channel &&
            !prevMsg.isStreaming &&
            updated.role === "system" &&
            !updated.isStreaming &&
            updated.channel !== "status"
          ) {
            const prevRaw = typeof (prevMsg.meta as any)?.rawText === "string" ? String((prevMsg.meta as any).rawText) : "";
            const merged: ChatMessage = {
              ...prevMsg,
              text: prevMsg.text + updated.text,
              seqEnd: Math.max(prevMsg.seqEnd, updated.seqEnd),
              meta: {
                ...(prevMsg.meta || {}),
                rawText: prevRaw + rawText
              }
            };
            next[idx - 1] = merged;
            next.splice(idx, 1);
          }

          return next;
        });
        return;
      }

      if (evt.type === "stdout_chunk" || evt.type === "stderr_chunk") {
        const channel = evt.type === "stdout_chunk" ? "stdout" : "stderr";
        const rawText = typeof (evt.payload as any).raw === "string" ? String((evt.payload as any).raw) : "";
        setMessages((prev) => [
          ...prev,
          {
            messageId: evt.payload.messageId,
            role: "system",
            channel,
            text: String(evt.payload.text || ""),
            createdAt: evt.ts,
            seqStart: evt.seq,
            seqEnd: evt.seq,
            isStreaming: true,
            meta: { rawText }
          }
        ]);
        return;
      }

      if (evt.type === "user_input") {
        const text = String(evt.payload.text || "").replace(/\n$/, "");
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.messageId === evt.payload.messageId);
          if (idx === -1) {
            return [
              ...prev,
              {
                messageId: evt.payload.messageId,
                role: "user",
                channel: "user",
                text,
                createdAt: evt.ts,
                seqStart: evt.seq,
                seqEnd: evt.seq,
                isStreaming: false
              }
            ];
          }
          const next = [...prev];
          next[idx] = { ...next[idx]!, seqEnd: Math.max(next[idx]!.seqEnd, evt.seq) };
          return next;
        });
        return;
      }

      if (evt.type === "exit") {
        const text = `Session exited (code: ${evt.payload.exitCode ?? "?"}, signal: ${evt.payload.signal ?? ""})`;
        setMessages((prev) => [
          ...prev,
          {
            messageId: `exit-${evt.seq}`,
            role: "system",
            channel: "status",
            text,
            createdAt: evt.ts,
            seqStart: evt.seq,
            seqEnd: evt.seq,
            isStreaming: false
          }
        ]);
        return;
      }
    },
    [flushPendingPatches, schedulePatchFlush]
  );

  const { connectionState, send } = useChatSocket({
    sessionId: currentSessionId,
    attach,
    onEvent
  });

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Add user message immediately (server will ack with the same messageId).
      const messageId = `user-${Date.now()}-${messageIdCounter.current++}`;
      const userMessage: ChatMessage = {
        messageId,
        role: "user",
        channel: "user",
        text: trimmed,
        createdAt: new Date().toISOString(),
        seqStart: 0,
        seqEnd: 0,
        isStreaming: false
      };
      setMessages((prev) => [...prev, userMessage]);
      // Send to server
      send(trimmed, { messageId, enter: true });
    },
    [send]
  );

  const handleSettingsChange = useCallback((update: Partial<ChatSettings>) => {
    setSettings((prev) => ({ ...prev, ...update }));
  }, []);

  return (
    <div className="chat-app">
      <Header
        sessions={sessions}
        currentSessionId={currentSessionId}
        connectionState={connectionState}
        settings={settings}
        onSessionChange={handleSessionChange}
        onSettingsChange={handleSettingsChange}
        onNewSession={handleNewSession}
      />
      <MessageList
        messages={messages}
        autoScroll={settings.autoScroll}
        showTimestamps={settings.showTimestamps}
        monospace={settings.monospaceOutput}
        showAnsi={settings.showAnsi}
      />
      <Composer
        disabled={connectionState !== "connected"}
        onSend={handleSend}
      />
    </div>
  );
};
