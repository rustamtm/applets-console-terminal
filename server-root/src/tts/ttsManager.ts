import type WebSocket from "ws";
import { TextChunker } from "./textChunker.js";
import { isSpeakable, sanitizeConsoleText } from "./textUtils.js";
import { DEFAULT_TTS_SAMPLE_RATE, type TtsSynthesisConfig } from "./ttsEngine.js";
import { TtsQueue } from "./ttsQueue.js";
import type { TtsEngine } from "./ttsEngine.js";
import type { AuditEvent } from "../logging/audit.js";

type TtsClientMessage =
  | { type: "start"; voice?: string; engine?: TtsEngineName; source?: TtsSource }
  | { type: "stop" }
  | { type: "config"; voice?: string; engine?: TtsEngineName; source?: TtsSource }
  | { type: "say"; text: string };

type TtsEngineName = "openai" | "piper";
type TtsSource = "terminal" | "codex";

type TtsAuditEvent = Extract<
  AuditEvent,
  {
    type:
      | "tts_attach"
      | "tts_detach"
      | "tts_start"
      | "tts_stop"
      | "tts_config"
      | "tts_error"
      | "tts_drop";
  }
>;

type TtsSessionState = {
  sessionId: string;
  userId?: string;
  enabled: boolean;
  engineName: TtsEngineName;
  source: TtsSource;
  voice: string;
  model: string;
  sampleRate: number;
  connections: Set<WebSocket>;
  chunker: TextChunker;
  queue: TtsQueue;
  lastDropNoticeAt: number;
};

export type TtsManagerConfig = {
  enabled: boolean;
  defaultEngine: TtsEngineName;
  model: string;
  voice: string;
  maxChunkChars: number;
  maxQueueDepth: number;
};

export class TtsManager {
  private readonly cfg: TtsManagerConfig;
  private readonly engines: Record<string, TtsEngine>;
  private readonly sessions = new Map<string, TtsSessionState>();
  private readonly audit?: (event: AuditEvent) => void;

  constructor(cfg: TtsManagerConfig, engines: Record<string, TtsEngine>, audit?: (event: AuditEvent) => void) {
    this.cfg = cfg;
    this.engines = engines;
    this.audit = audit;
  }

  attach(sessionId: string, ws: WebSocket, userId: string) {
    if (!this.cfg.enabled) {
      this.audit?.({
        type: "tts_error",
        at: new Date().toISOString(),
        userId,
        sessionId,
        message: "TTS is disabled on this server."
      });
      this.sendError(ws, "TTS is disabled on this server.");
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    let state: TtsSessionState;
    try {
      state = this.getOrCreate(sessionId);
    } catch (err: any) {
      this.audit?.({
        type: "tts_error",
        at: new Date().toISOString(),
        userId,
        sessionId,
        message: err?.message || "TTS engine not available."
      });
      this.sendError(ws, err?.message || "TTS engine not available.");
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }
    if (!state.userId) state.userId = userId;
    state.connections.add(ws);
    this.logEvent(state, {
      type: "tts_attach",
      engine: state.engineName,
      voice: state.voice,
      model: state.model
    });
    this.sendInfo(ws, `TTS ready (voice=${state.voice}, model=${state.model}).`);
    this.sendFormat(ws, state.sampleRate);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      try {
        const msg = JSON.parse(text) as TtsClientMessage;
        this.handleClientMessage(state, msg);
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      state.connections.delete(ws);
      this.logEvent(state, { type: "tts_detach" });
      if (state.connections.size === 0) {
        state.enabled = false;
        state.queue.clear();
      }
    });
  }

  handleOutput(sessionId: string, raw: string) {
    if (!this.cfg.enabled) return;
    const state = this.sessions.get(sessionId);
    if (!state || !state.enabled) return;
    if (state.source !== "terminal") return;
    const cleaned = sanitizeConsoleText(raw);
    const chunks = state.chunker.push(cleaned);
    if (!chunks.length) return;
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      if (!isSpeakable(trimmed)) continue;
      const ok = state.queue.enqueue(trimmed, this.makeSynthesisConfig(state));
      this.broadcastDebug(state, trimmed, ok);
      if (!ok) {
        const now = Date.now();
        if (now - state.lastDropNoticeAt > 2_000) {
          this.broadcastInfo(state, "TTS backlog: dropping output.");
          this.logEvent(state, {
            type: "tts_drop",
            message: "TTS backlog: dropping output.",
            engine: state.engineName,
            voice: state.voice,
            model: state.model
          });
          state.lastDropNoticeAt = now;
        }
      }
    }
  }

  closeSession(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.queue.clear();
    for (const ws of state.connections) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): TtsSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const chunker = new TextChunker(this.cfg.maxChunkChars);
    const resolved = this.resolveEngine(this.cfg.defaultEngine);
    const engineName = resolved.name;
    const engine = resolved.engine;
    const sampleRate = this.getSampleRate(engine, {
      model: this.cfg.model,
      voice: this.cfg.voice,
      format: "pcm"
    });
    const state: TtsSessionState = {
      sessionId,
      enabled: false,
      engineName,
      source: "terminal",
      voice: this.cfg.voice,
      model: this.cfg.model,
      sampleRate,
      connections: new Set(),
      chunker,
      queue: undefined as any,
      lastDropNoticeAt: 0
    };
    state.queue = new TtsQueue(
      engine,
      (chunk) => this.broadcastAudio(sessionId, chunk),
      {
        maxDepth: this.cfg.maxQueueDepth,
        onError: (err) => this.broadcastError(state, err.message)
      }
    );
    this.sessions.set(sessionId, state);
    return state;
  }

  private handleClientMessage(state: TtsSessionState, msg: TtsClientMessage) {
    if (msg.type === "start") {
      if (msg.voice) state.voice = msg.voice;
      if (msg.engine) this.setEngine(state, msg.engine);
      if (msg.source) this.setSource(state, msg.source);
      state.enabled = true;
      state.queue.clear();
      state.chunker = new TextChunker(this.cfg.maxChunkChars);
      this.logEvent(state, {
        type: "tts_start",
        engine: state.engineName,
        voice: state.voice,
        model: state.model
      });
      this.broadcastInfo(
        state,
        `TTS enabled (voice=${state.voice}, engine=${state.engineName}).`
      );
      this.broadcastFormat(state);
      return;
    }
    if (msg.type === "stop") {
      state.enabled = false;
      state.queue.clear();
      this.logEvent(state, {
        type: "tts_stop",
        engine: state.engineName,
        voice: state.voice,
        model: state.model
      });
      this.broadcastInfo(state, "TTS disabled.");
      return;
    }
    if (msg.type === "config") {
      if (msg.voice) state.voice = msg.voice;
      if (msg.engine) this.setEngine(state, msg.engine);
      if (msg.source) this.setSource(state, msg.source);
      this.logEvent(state, {
        type: "tts_config",
        engine: state.engineName,
        voice: state.voice,
        model: state.model
      });
      this.broadcastInfo(
        state,
        `TTS config updated (voice=${state.voice}, engine=${state.engineName}).`
      );
      this.broadcastFormat(state);
      return;
    }
    if (msg.type === "say") {
      if (!msg.text) return;
      this.handleInjectedText(state, msg.text);
    }
  }

  private makeSynthesisConfig(state: TtsSessionState): TtsSynthesisConfig {
    return {
      model: state.model,
      voice: state.voice,
      format: "pcm"
    };
  }

  private handleInjectedText(state: TtsSessionState, raw: string) {
    if (!state.enabled) return;
    if (state.source !== "codex") return;
    const cleaned = sanitizeConsoleText(raw);
    const chunks = state.chunker.push(cleaned);
    if (!chunks.length) return;
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      if (!isSpeakable(trimmed)) continue;
      const ok = state.queue.enqueue(trimmed, this.makeSynthesisConfig(state));
      this.broadcastDebug(state, trimmed, ok);
      if (!ok) {
        const now = Date.now();
        if (now - state.lastDropNoticeAt > 2_000) {
          this.broadcastInfo(state, "TTS backlog: dropping output.");
          this.logEvent(state, {
            type: "tts_drop",
            message: "TTS backlog: dropping output.",
            engine: state.engineName,
            voice: state.voice,
            model: state.model
          });
          state.lastDropNoticeAt = now;
        }
      }
    }
  }

  private sendFormat(ws: WebSocket, sampleRate = DEFAULT_TTS_SAMPLE_RATE) {
    this.sendJson(ws, {
      type: "format",
      format: "pcm16",
      sampleRate,
      channels: 1
    });
  }

  private broadcastFormat(state: TtsSessionState) {
    for (const ws of state.connections) this.sendFormat(ws, state.sampleRate);
  }

  private broadcastAudio(sessionId: string, chunk: Buffer) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const ws of state.connections) {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    }
  }

  private broadcastInfo(state: TtsSessionState, message: string) {
    for (const ws of state.connections) {
      this.sendInfo(ws, message);
    }
  }

  private broadcastError(state: TtsSessionState, message: string) {
    for (const ws of state.connections) {
      this.sendError(ws, message);
    }
    this.logEvent(state, {
      type: "tts_error",
      message,
      engine: state.engineName,
      voice: state.voice,
      model: state.model
    });
  }

  private broadcastDebug(state: TtsSessionState, text: string, queued: boolean) {
    for (const ws of state.connections) {
      this.sendJson(ws, {
        type: "debug",
        source: state.source,
        engine: state.engineName,
        voice: state.voice,
        model: state.model,
        queued,
        text
      });
    }
  }

  private sendInfo(ws: WebSocket, message: string) {
    this.sendJson(ws, { type: "info", message });
  }

  private sendError(ws: WebSocket, message: string) {
    this.sendJson(ws, { type: "error", message });
  }

  private resolveEngine(name: TtsEngineName) {
    const engine = this.engines[name];
    if (engine) return { name, engine };
    const fallbackName = Object.keys(this.engines)[0] as TtsEngineName | undefined;
    if (fallbackName) return { name: fallbackName, engine: this.engines[fallbackName] };
    throw new Error(`TTS engine '${name}' is not configured`);
  }

  private getSampleRate(engine: TtsEngine, cfg: TtsSynthesisConfig) {
    try {
      return engine.getSampleRate?.(cfg) ?? DEFAULT_TTS_SAMPLE_RATE;
    } catch {
      return DEFAULT_TTS_SAMPLE_RATE;
    }
  }

  private setEngine(state: TtsSessionState, engineName: TtsEngineName) {
    if (state.engineName === engineName) return;
    let resolved: { name: TtsEngineName; engine: TtsEngine };
    try {
      resolved = this.resolveEngine(engineName);
    } catch (err: any) {
      this.broadcastError(state, err?.message || "Unknown TTS engine");
      return;
    }
    state.engineName = resolved.name;
    state.sampleRate = this.getSampleRate(resolved.engine, this.makeSynthesisConfig(state));
    state.queue = new TtsQueue(resolved.engine, (chunk) => this.broadcastAudio(state.sessionId, chunk), {
      maxDepth: this.cfg.maxQueueDepth,
      onError: (err) => this.broadcastError(state, err.message)
    });
  }

  private setSource(state: TtsSessionState, source: TtsSource) {
    if (state.source === source) return;
    state.source = source;
    state.queue.clear();
    state.chunker = new TextChunker(this.cfg.maxChunkChars);
  }

  private sendJson(ws: WebSocket, payload: unknown) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  private logEvent(state: TtsSessionState, event: Omit<TtsAuditEvent, "at" | "userId" | "sessionId">) {
    if (!this.audit || !state.userId) return;
    this.audit({
      ...event,
      at: new Date().toISOString(),
      userId: state.userId,
      sessionId: state.sessionId
    });
  }
}
