/**
 * Chat WebSocket Event Types
 * 
 * Protocol for the chat WebSocket endpoint (/ws/chat/sessions/:id)
 */

export type ChatEventType =
  | "hello"
  | "snapshot_ready"
  | "user_input"
  | "stdout_chunk"
  | "stderr_chunk"
  | "message_commit"
  | "message_patch"
  | "prompt_ready"
  | "exit"
  | "replay_start"
  | "replay_end";

export interface BaseChatEvent {
  type: ChatEventType;
  ts: string; // ISO string
  sessionId: string;
  seq: number; // Monotonically increasing per session
}

export interface HelloEvent extends BaseChatEvent {
  type: "hello";
  payload: {
    version: string;
    capabilities: string[];
  };
}

export interface SnapshotReadyEvent extends BaseChatEvent {
  type: "snapshot_ready";
  payload: {
    replayEventCount?: number;
    oldestSeq?: number;
    newestSeq?: number;
  };
}

export interface UserInputEvent extends BaseChatEvent {
  type: "user_input";
  payload: {
    text: string;
    messageId: string;
  };
}

export interface StdoutChunkEvent extends BaseChatEvent {
  type: "stdout_chunk";
  payload: {
    text: string;
    messageId: string;
    raw?: string; // Optional raw output with ANSI (debug mode)
  };
}

export interface StderrChunkEvent extends BaseChatEvent {
  type: "stderr_chunk";
  payload: {
    text: string;
    messageId: string;
    raw?: string;
  };
}

export interface MessagePatchEvent extends BaseChatEvent {
  type: "message_patch";
  payload: {
    messageId: string;
    appendText: string;
    channel: "stdout" | "stderr";
    rawAppendText?: string;
  };
}

export interface MessageCommitEvent extends BaseChatEvent {
  type: "message_commit";
  payload: {
    messageId: string;
    finalText: string;
    channel: "stdout" | "stderr";
    lineCount: number;
    rawFinalText?: string;
  };
}

export interface PromptReadyEvent extends BaseChatEvent {
  type: "prompt_ready";
  payload: {
    promptText?: string;
  };
}

export interface ExitEvent extends BaseChatEvent {
  type: "exit";
  payload: {
    exitCode: number | null;
    signal: number | null;
  };
}

export interface ReplayStartEvent extends BaseChatEvent {
  type: "replay_start";
  payload: {
    eventCount: number;
    oldestSeq: number;
    newestSeq: number;
  };
}

export interface ReplayEndEvent extends BaseChatEvent {
  type: "replay_end";
  payload: Record<string, never>;
}

export type ChatEvent =
  | HelloEvent
  | SnapshotReadyEvent
  | UserInputEvent
  | StdoutChunkEvent
  | StderrChunkEvent
  | MessagePatchEvent
  | MessageCommitEvent
  | PromptReadyEvent
  | ExitEvent
  | ReplayStartEvent
  | ReplayEndEvent;

/**
 * Message model for the chat UI
 */
export interface ChatMessage {
  messageId: string;
  role: "user" | "system";
  channel: "user" | "stdout" | "stderr" | "status";
  text: string;
  createdAt: string; // ISO string
  seqStart: number;
  seqEnd: number;
  isStreaming: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Connection state for the chat WebSocket
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Chat UI settings
 */
export interface ChatSettings {
  groupOutput: boolean;
  showAnsi: boolean;
  autoScroll: boolean;
  monospaceOutput: boolean;
  showTimestamps: boolean;
}

/**
 * Session info returned from REST API
 */
export interface SessionInfo {
  id: string;
  mode: "node" | "shell" | "readonly_tail" | "tmux";
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  tmuxName?: string;
  codexState?: "running" | "idle" | "done";
}

/**
 * Attach response from REST API
 */
export interface AttachResponse {
  sessionId: string;
  attachToken: string;
  wsUrl: string;
  chatWsUrl: string;
}
