import type WebSocket from "ws";
import { StreamShaper, createStreamShaper, type ChatEvent } from "./streamShaper.js";
import type { Session, SessionManager } from "../sessions/sessionManager.js";

/**
 * Chat connection state for a single WebSocket
 */
interface ChatConnection {
  ws: WebSocket;
  userId: string;
  lastSeq: number;
}

/**
 * Chat session state for managing stream shapers
 */
interface ChatSession {
  shaper: StreamShaper;
  connections: Set<ChatConnection>;
  unsubscribe: () => void;
}

/**
 * ChatSessionManager - Manages chat WebSocket connections and stream shapers
 */
export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Get or create a chat session for a PTY session
   */
  private getOrCreateChatSession(sessionId: string): ChatSession {
    let chatSession = this.sessions.get(sessionId);
    if (chatSession) {
      return chatSession;
    }

    // Create a new shaper for this session
    const shaper = createStreamShaper(sessionId, { debugMode: true });

    // Subscribe to PTY output via the onOutput callback
    // We'll set this up in attachWithShaper

    chatSession = {
      shaper,
      connections: new Set(),
      unsubscribe: () => {}
    };

    this.sessions.set(sessionId, chatSession);
    return chatSession;
  }

  /**
   * Attach a chat WebSocket to a session with stream shaping
   */
  attachWithShaper(
    sessionId: string,
    ws: WebSocket,
    userId: string,
    session: Session,
    afterSeq?: number
  ): void {
    const chatSession = this.getOrCreateChatSession(sessionId);

    // Create connection record
    const connection: ChatConnection = {
      ws,
      userId,
      lastSeq: 0
    };

    const pending: ChatEvent[] = [];
    let replayDone = false;
    let replayNewestSeq = Number.isFinite(afterSeq) && (afterSeq as number) > 0 ? (afterSeq as number) : 0;

    const sendEvent = (event: ChatEvent) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(event));
        if (event.seq > 0) connection.lastSeq = event.seq;
      } catch (err) {
        console.error("[chat] Failed to send event:", err);
      }
    };

    // Subscribe early to avoid dropping output emitted during replay.
    const unsubscribe = chatSession.shaper.subscribe((event: ChatEvent) => {
      if (ws.readyState !== ws.OPEN) return;
      if (!replayDone) {
        pending.push(event);
        return;
      }
      if (event.seq <= replayNewestSeq) return; // already covered by replay
      sendEvent(event);
    });

    // Send hello + replay (in-order), then switch to live stream.
    sendEvent(chatSession.shaper.createHelloEvent());

    const replayEvents = chatSession.shaper.createReplayEvents(replayNewestSeq);
    if (replayEvents.length > 0) replayNewestSeq = replayEvents[replayEvents.length - 1]!.seq;
    for (const event of replayEvents) sendEvent(event);

    const range = chatSession.shaper.getSeqRange();
    sendEvent(
      chatSession.shaper.createSnapshotReadyEvent({
        replayEventCount: replayEvents.length,
        oldestSeq: range.oldest,
        newestSeq: range.newest
      })
    );

    replayDone = true;
    for (const event of pending) {
      if (event.seq <= replayNewestSeq) continue;
      sendEvent(event);
    }

    // Add to connections
    chatSession.connections.add(connection);

    // Handle WebSocket close
    const handleClose = () => {
      unsubscribe();
      chatSession.connections.delete(connection);

      // Clean up chat session if no more connections
      if (chatSession.connections.size === 0) {
        // Keep the shaper alive for a while for reconnection
        setTimeout(() => {
          const current = this.sessions.get(sessionId);
          if (current && current.connections.size === 0) {
            current.shaper.destroy();
            current.unsubscribe();
            this.sessions.delete(sessionId);
          }
        }, 60000); // 1 minute grace period
      }
    };

    ws.on("close", handleClose);
    ws.on("error", handleClose);
  }

  /**
   * Process PTY output for a session
   */
  processOutput(sessionId: string, data: string): void {
    // Always shape output so history is available even if the chat UI
    // attaches after the session has already produced output.
    const chatSession = this.getOrCreateChatSession(sessionId);
    chatSession.shaper.processOutput(data, "stdout");
  }

  /**
   * Process user input for a session
   */
  processUserInput(sessionId: string, text: string, messageId?: string): void {
    const chatSession = this.getOrCreateChatSession(sessionId);
    chatSession.shaper.processUserInput(text, messageId);
  }

  /**
   * Process session exit
   */
  processExit(sessionId: string, exitCode: number | null, signal: number | null): void {
    const chatSession = this.sessions.get(sessionId);
    if (chatSession) chatSession.shaper.processExit(exitCode, signal);
  }

  /**
   * Drop chat history for a closed session (best-effort).
   */
  closeSession(sessionId: string): void {
    const chatSession = this.sessions.get(sessionId);
    if (!chatSession) return;
    try {
      chatSession.shaper.destroy();
    } catch {
      // ignore
    }
    try {
      chatSession.unsubscribe();
    } catch {
      // ignore
    }
    for (const conn of chatSession.connections) {
      try {
        conn.ws.close();
      } catch {
        // ignore
      }
    }
    chatSession.connections.clear();
    this.sessions.delete(sessionId);
  }

  /**
   * Clean up all resources
   */
  shutdown(): void {
    for (const [sessionId, chatSession] of this.sessions) {
      chatSession.shaper.destroy();
      chatSession.unsubscribe();
      for (const conn of chatSession.connections) {
        try {
          conn.ws.close();
        } catch {
          // Ignore close errors
        }
      }
    }
    this.sessions.clear();
  }
}
