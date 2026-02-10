import crypto from "node:crypto";

/**
 * Chat event types for the streaming protocol
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

export interface ChatEvent {
  type: ChatEventType;
  ts: string;
  sessionId: string;
  seq: number;
  payload: Record<string, unknown>;
}

/**
 * StreamShaper configuration
 */
export interface StreamShaperConfig {
  sessionId: string;
  /** Strip ANSI escape sequences (default: true) */
  stripAnsi?: boolean;
  /** Include raw output in debug mode (default: false) */
  debugMode?: boolean;
  /** Quiet timer flush interval in ms (default: 200) */
  quietFlushMs?: number;
  /** Max lines before forced flush (default: 80) */
  maxLinesFlush?: number;
  /** Ring buffer size for replay (default: 1000) */
  ringBufferSize?: number;
  /** Prompt detection patterns */
  promptPatterns?: RegExp[];
}

// ANSI escape sequence regex
const ANSI_REGEX = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

// Common shell prompt patterns
const DEFAULT_PROMPT_PATTERNS = [
  /\n?\$\s*$/,           // $ prompt
  /\n?%\s*$/,            // % prompt (zsh)
  /\n?>\s*$/,            // > prompt
  /\n?#\s*$/,            // # prompt (root)
  /\n?➜\s*.*$/,          // oh-my-zsh arrow
  /\n?\[.*@.*\].*\$\s*$/ // [user@host dir]$ format
];

/**
 * Strip ANSI escape sequences from text
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

/**
 * Normalize carriage returns and handle progress bar patterns
 */
export function normalizeOutput(input: string): string {
  // Handle \r\n as just \n
  let normalized = input.replace(/\r\n/g, "\n");
  
  // Handle progress bar patterns: lines with \r followed by content
  // Replace "content\rcontent" with just the second content
  normalized = normalized.replace(/[^\n]*\r(?!\n)/g, "");
  
  return normalized;
}

/**
 * StreamShaper - Converts raw PTY output into structured chat events
 */
export class StreamShaper {
  private readonly config: Required<StreamShaperConfig>;
  private seq = 0;
  private currentMessageId: string | null = null;
  private currentChannel: "stdout" | "stderr" = "stdout";
  private currentText = "";
  private currentRawText = "";
  private currentLineCount = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private ringBuffer: ChatEvent[] = [];
  private listeners = new Set<(event: ChatEvent) => void>();

  constructor(config: StreamShaperConfig) {
    this.config = {
      sessionId: config.sessionId,
      stripAnsi: config.stripAnsi ?? true,
      debugMode: config.debugMode ?? false,
      quietFlushMs: config.quietFlushMs ?? 200,
      maxLinesFlush: config.maxLinesFlush ?? 80,
      ringBufferSize: config.ringBufferSize ?? 1000,
      promptPatterns: config.promptPatterns ?? DEFAULT_PROMPT_PATTERNS
    };
  }

  /**
   * Subscribe to chat events
   */
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get events from ring buffer for replay
   */
  getReplayEvents(afterSeq?: number): ChatEvent[] {
    if (afterSeq === undefined) {
      return [...this.ringBuffer];
    }
    return this.ringBuffer.filter((e) => e.seq > afterSeq);
  }

  /**
   * Get the oldest and newest sequence numbers in the buffer
   */
  getSeqRange(): { oldest: number; newest: number } {
    if (this.ringBuffer.length === 0) {
      return { oldest: 0, newest: 0 };
    }
    return {
      oldest: this.ringBuffer[0].seq,
      newest: this.ringBuffer[this.ringBuffer.length - 1].seq
    };
  }

  /**
   * Process raw PTY output
   */
  processOutput(raw: string, channel: "stdout" | "stderr" = "stdout"): void {
    // Normalize the output
    const rawText = normalizeOutput(raw);
    let text = rawText;
    
    // Strip ANSI if configured
    if (this.config.stripAnsi) {
      text = stripAnsi(text);
    }
    
    if (!text) return;

    // Start a new message if needed
    if (!this.currentMessageId || this.currentChannel !== channel) {
      this.commitCurrentMessage();
      this.startNewMessage(channel);
    }

    // Append to current message
    this.currentText += text;
    this.currentRawText += rawText;
    this.currentLineCount += (text.match(/\n/g) || []).length;

    // Emit patch event
    const patchPayload: Record<string, unknown> = {
      messageId: this.currentMessageId,
      appendText: text,
      channel
    };
    if (this.config.debugMode) patchPayload.rawAppendText = rawText;
    const patchEvent = this.createEvent("message_patch", patchPayload);
    this.emit(patchEvent);

    // Check for prompt detection
    if (this.detectPrompt(this.currentText)) {
      this.commitCurrentMessage();
      this.emitPromptReady();
      return;
    }

    // Check for max lines flush
    if (this.currentLineCount >= this.config.maxLinesFlush) {
      this.commitCurrentMessage();
      return;
    }

    // Reset quiet timer
    this.resetFlushTimer();
  }

  /**
   * Process user input (for display in chat)
   */
  processUserInput(text: string, messageId?: string): void {
    // Commit any pending output
    this.commitCurrentMessage();

    const resolvedMessageId = messageId || this.generateMessageId();
    const event = this.createEvent("user_input", {
      text,
      messageId: resolvedMessageId
    });
    this.emit(event);
  }

  /**
   * Handle session exit
   */
  processExit(exitCode: number | null, signal: number | null): void {
    this.commitCurrentMessage();
    
    const event = this.createEvent("exit", {
      exitCode,
      signal
    });
    this.emit(event);
  }

  /**
   * Force commit current message
   */
  commitCurrentMessage(): void {
    this.clearFlushTimer();

    if (!this.currentMessageId || !this.currentText) {
      this.currentMessageId = null;
      this.currentText = "";
      this.currentRawText = "";
      this.currentLineCount = 0;
      return;
    }

    const commitPayload: Record<string, unknown> = {
      messageId: this.currentMessageId,
      finalText: this.currentText,
      channel: this.currentChannel,
      lineCount: this.currentLineCount
    };
    if (this.config.debugMode) commitPayload.rawFinalText = this.currentRawText;
    const event = this.createEvent("message_commit", commitPayload);
    this.emit(event);

    this.currentMessageId = null;
    this.currentText = "";
    this.currentRawText = "";
    this.currentLineCount = 0;
  }

  /**
   * Create hello event for new connections
   */
  createHelloEvent(): ChatEvent {
    return this.createMetaEvent("hello", {
      version: "1.0",
      capabilities: ["streaming", "replay"]
    });
  }

  /**
   * Create snapshot_ready event (history / replay is done and live streaming begins)
   */
  createSnapshotReadyEvent(payload: Record<string, unknown>): ChatEvent {
    return this.createMetaEvent("snapshot_ready", payload);
  }

  /**
   * Create replay events for reconnection (seq-preserving; no wrapper events).
   */
  createReplayEvents(afterSeq?: number): ChatEvent[] {
    return this.getReplayEvents(afterSeq);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clearFlushTimer();
    this.listeners.clear();
    this.ringBuffer = [];
  }

  private startNewMessage(channel: "stdout" | "stderr"): void {
    this.currentMessageId = this.generateMessageId();
    this.currentChannel = channel;
    this.currentText = "";
    this.currentRawText = "";
    this.currentLineCount = 0;

    const chunkType = channel === "stdout" ? "stdout_chunk" : "stderr_chunk";
    const event = this.createEvent(chunkType, {
      text: "",
      messageId: this.currentMessageId,
      ...(this.config.debugMode ? { raw: "" } : {})
    });
    this.emit(event);
  }

  private detectPrompt(text: string): boolean {
    for (const pattern of this.config.promptPatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }

  private emitPromptReady(): void {
    const event = this.createEvent("prompt_ready", {});
    this.emit(event);
  }

  private resetFlushTimer(): void {
    this.clearFlushTimer();
    this.flushTimer = setTimeout(() => {
      this.commitCurrentMessage();
    }, this.config.quietFlushMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private generateMessageId(): string {
    return `msg-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }

  private createEvent(type: ChatEventType, payload: Record<string, unknown>): ChatEvent {
    this.seq += 1;
    return {
      type,
      ts: new Date().toISOString(),
      sessionId: this.config.sessionId,
      seq: this.seq,
      payload
    };
  }

  private createMetaEvent(type: ChatEventType, payload: Record<string, unknown>): ChatEvent {
    return {
      type,
      ts: new Date().toISOString(),
      sessionId: this.config.sessionId,
      seq: 0,
      payload
    };
  }

  private emit(event: ChatEvent): void {
    // Add to ring buffer
    this.ringBuffer.push(event);
    while (this.ringBuffer.length > this.config.ringBufferSize) {
      this.ringBuffer.shift();
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[StreamShaper] Listener error:", err);
      }
    }
  }
}

/**
 * Create a StreamShaper instance for a session
 */
export function createStreamShaper(sessionId: string, config?: Partial<StreamShaperConfig>): StreamShaper {
  return new StreamShaper({
    sessionId,
    ...config
  });
}
