import type WebSocket from "ws";
import type { SttEngine } from "./sttEngine.js";
import type { AccessUser } from "../auth/access.js";
import { AudioChunker } from "./chunker.js";
import { pcmRms16 } from "./audioGate.js";
import type { AuditEvent } from "../logging/audit.js";

type SttClientMessage =
  | {
      type: "start";
      engine?: "cpp" | "openai";
      model?: string;
      lang?: string;
      liveTyping?: boolean;
      inject?: "server" | "none";
    }
  | { type: "stop" }
  | {
      type: "config";
      engine?: "cpp" | "openai";
      model?: string;
      lang?: string;
      liveTyping?: boolean;
      inject?: "server" | "none";
    };

type SttConnectionState = {
  sessionId: string;
  userId: string;
  enabled: boolean;
  engineName: "cpp" | "openai";
  model: string;
  lang: string;
  liveTyping: boolean;
  injectMode: "server" | "none";
  transcribing: boolean;
  pending: Buffer[];
  chunker: AudioChunker;
  liveText: string;
  liveChars: number;
  lastAudioAt: number;
  lastPartialAt: number;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
};

type SttAuditEvent = Extract<
  AuditEvent,
  {
    type:
      | "stt_attach"
      | "stt_detach"
      | "stt_start"
      | "stt_stop"
      | "stt_config"
      | "stt_error"
      | "stt_transcript";
  }
>;

export type SttManagerConfig = {
  enabled: boolean;
  defaultEngine: "cpp" | "openai";
  model: string;
  lang: string;
  minAudioBytes: number;
  energyThreshold: number;
  windowBytes: number;
  overlapBytes: number;
  sampleRate: number;
  finalizeMs: number;
  debug: boolean;
};

export class SttManager {
  private readonly cfg: SttManagerConfig;
  private readonly engines: Record<string, SttEngine>;
  private readonly writeToSession: (sessionId: string, text: string) => void;
  private readonly audit?: (event: AuditEvent) => void;

  constructor(
    cfg: SttManagerConfig,
    engines: Record<string, SttEngine>,
    writeToSession: (sessionId: string, text: string) => void,
    audit?: (event: AuditEvent) => void
  ) {
    this.cfg = cfg;
    this.engines = engines;
    this.writeToSession = writeToSession;
    this.audit = audit;
  }

  attach(sessionId: string, ws: WebSocket, user: AccessUser) {
    if (!this.cfg.enabled) {
      this.audit?.({
        type: "stt_error",
        at: new Date().toISOString(),
        userId: user.userId,
        sessionId,
        message: "STT is disabled on this server."
      });
      this.sendError(ws, "STT is disabled on this server.");
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    const state: SttConnectionState = {
      sessionId,
      userId: user.userId,
      enabled: false,
      engineName: this.cfg.defaultEngine,
      model: this.cfg.model,
      lang: this.cfg.lang,
      liveTyping: true,
      injectMode: "server",
      transcribing: false,
      pending: [],
      chunker: new AudioChunker(this.cfg.windowBytes, this.cfg.overlapBytes),
      liveText: "",
      liveChars: 0,
      lastAudioAt: 0,
      lastPartialAt: 0,
      finalizeTimer: null
    };

    this.logEvent(state, {
      type: "stt_attach",
      engine: state.engineName,
      model: state.model,
      lang: state.lang
    });
    this.sendInfo(
      ws,
      `STT ready (engine=${state.engineName}, model=${state.model}, liveTyping=${state.liveTyping ? "on" : "off"}).`
    );

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!state.enabled) return;
        const chunk = Buffer.from(data as Buffer);
        this.handleAudio(state, chunk, ws);
        return;
      }
      const text = data.toString();
      try {
        const msg = JSON.parse(text) as SttClientMessage;
        this.handleClientMessage(state, msg, ws);
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      this.clearFinalizeTimer(state);
      state.enabled = false;
      state.pending = [];
      state.chunker.clear();
      state.liveText = "";
      state.liveChars = 0;
      this.logEvent(state, { type: "stt_detach" });
    });
  }

  private handleClientMessage(state: SttConnectionState, msg: SttClientMessage, ws: WebSocket) {
    if (msg.type === "start") {
      if (msg.engine) this.setEngine(state, msg.engine, ws);
      if (msg.model) state.model = msg.model;
      if (msg.lang) state.lang = msg.lang;
      this.applyClientOptions(state, msg);
      state.enabled = true;
      state.pending = [];
      state.chunker.clear();
      this.resetLiveState(state);
      this.logEvent(state, {
        type: "stt_start",
        engine: state.engineName,
        model: state.model,
        lang: state.lang
      });
      this.sendInfo(
        ws,
        `STT enabled (engine=${state.engineName}, model=${state.model}, liveTyping=${state.liveTyping ? "on" : "off"}).`
      );
      return;
    }
    if (msg.type === "stop") {
      state.enabled = false;
      state.pending = [];
      state.chunker.clear();
      this.resetLiveState(state);
      this.logEvent(state, {
        type: "stt_stop",
        engine: state.engineName,
        model: state.model,
        lang: state.lang
      });
      this.sendInfo(ws, "STT disabled.");
      return;
    }
    if (msg.type === "config") {
      if (msg.engine) this.setEngine(state, msg.engine, ws);
      if (msg.model) state.model = msg.model;
      if (msg.lang) state.lang = msg.lang;
      this.applyClientOptions(state, msg);
      if (msg.liveTyping !== undefined || msg.inject !== undefined) {
        this.resetLiveState(state);
      }
      this.logEvent(state, {
        type: "stt_config",
        engine: state.engineName,
        model: state.model,
        lang: state.lang
      });
      this.sendInfo(
        ws,
        `STT config updated (engine=${state.engineName}, model=${state.model}, liveTyping=${state.liveTyping ? "on" : "off"}).`
      );
    }
  }

  private setEngine(state: SttConnectionState, engineName: "cpp" | "openai", ws: WebSocket) {
    if (state.engineName === engineName) return;
    if (!this.engines[engineName]) {
      this.logEvent(state, {
        type: "stt_error",
        engine: engineName,
        model: state.model,
        lang: state.lang,
        message: `STT engine '${engineName}' is not configured.`
      });
      this.sendError(ws, `STT engine '${engineName}' is not configured.`);
      return;
    }
    state.engineName = engineName;
  }

  private handleAudio(state: SttConnectionState, chunk: Buffer, ws: WebSocket) {
    state.lastAudioAt = Date.now();
    if (state.liveTyping) {
      this.scheduleFinalize(state, ws);
    }
    const newChunks = state.chunker.push(chunk);
    if (newChunks.length) state.pending.push(...newChunks);
    if (this.cfg.windowBytes <= 0 && state.chunker.size() >= this.cfg.minAudioBytes) {
      state.pending.push(state.chunker.takeAll());
    }
    this.logDebug(
      state,
      `audio bytes=${chunk.length} pending=${state.pending.length} buffer=${state.chunker.size()}`
    );
    if (state.transcribing) return;
    this.maybeTranscribe(state, ws);
  }

  private maybeTranscribe(state: SttConnectionState, ws: WebSocket) {
    if (state.transcribing) return;
    const next = state.pending.shift();
    if (!next) {
      this.maybeFinalize(state, ws, "no_pending");
      return;
    }
    if (next.length < this.cfg.minAudioBytes) {
      this.logDebug(state, `skip chunk len=${next.length} < min=${this.cfg.minAudioBytes}`);
      this.maybeTranscribe(state, ws);
      return;
    }
    const rms = pcmRms16(next);
    if (rms < this.cfg.energyThreshold) {
      this.logDebug(
        state,
        `skip chunk rms=${rms.toFixed(1)} < threshold=${this.cfg.energyThreshold}`
      );
      this.maybeTranscribe(state, ws);
      return;
    }
    const engine = this.engines[state.engineName];
    if (!engine) {
      this.logEvent(state, {
        type: "stt_error",
        engine: state.engineName,
        model: state.model,
        lang: state.lang,
        message: `STT engine '${state.engineName}' is not configured.`
      });
      this.sendError(ws, `STT engine '${state.engineName}' is not configured.`);
      return;
    }
    state.transcribing = true;
    const startedAt = Date.now();
    this.logDebug(state, `transcribe_start bytes=${next.length} rms=${rms.toFixed(1)}`);
    engine
      .transcribe(next, {
        model: state.model,
        language: state.lang,
        sampleRate: this.cfg.sampleRate
      })
      .then((text) => {
        const normalized = this.normalizeText(text);
        if (!normalized) {
          this.logDebug(state, `transcribe_empty ms=${Date.now() - startedAt}`);
          return;
        }
        this.logDebug(
          state,
          `transcribe_done ms=${Date.now() - startedAt} chars=${this.countChars(normalized)}`
        );
        if (state.liveTyping) {
          this.applyPartial(state, normalized, ws);
          return;
        }
        try {
          if (state.injectMode === "server") {
            this.injectText(state, normalized);
          }
          this.sendJson(ws, { type: "final", text: normalized });
          this.logEvent(state, {
            type: "stt_transcript",
            engine: state.engineName,
            model: state.model,
            lang: state.lang,
            text: normalized
          });
        } catch (err: any) {
          this.logEvent(state, {
            type: "stt_error",
            engine: state.engineName,
            model: state.model,
            lang: state.lang,
            message: err?.message || "Failed to inject transcript."
          });
          this.sendError(ws, err?.message || "Failed to inject transcript.");
        }
      })
      .catch((err: any) => {
        this.logEvent(state, {
          type: "stt_error",
          engine: state.engineName,
          model: state.model,
          lang: state.lang,
          message: err?.message || "transcribe failed"
        });
        this.sendError(ws, err?.message || "transcribe failed");
      })
      .finally(() => {
        state.transcribing = false;
        this.maybeTranscribe(state, ws);
        this.maybeFinalize(state, ws, "post_transcribe");
      });
  }

  private applyClientOptions(state: SttConnectionState, msg: SttClientMessage) {
    if ("liveTyping" in msg && typeof msg.liveTyping === "boolean") state.liveTyping = msg.liveTyping;
    if ("inject" in msg && (msg.inject === "server" || msg.inject === "none")) {
      state.injectMode = msg.inject;
    }
  }

  private resetLiveState(state: SttConnectionState) {
    this.clearFinalizeTimer(state);
    state.liveText = "";
    state.liveChars = 0;
    state.lastAudioAt = 0;
    state.lastPartialAt = 0;
  }

  private clearFinalizeTimer(state: SttConnectionState) {
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = null;
    }
  }

  private scheduleFinalize(state: SttConnectionState, ws: WebSocket) {
    if (!state.liveTyping) return;
    this.clearFinalizeTimer(state);
    state.finalizeTimer = setTimeout(() => {
      this.maybeFinalize(state, ws, "idle_timer");
    }, this.cfg.finalizeMs);
    state.finalizeTimer.unref?.();
  }

  private maybeFinalize(state: SttConnectionState, ws: WebSocket, reason: string) {
    if (!state.liveTyping) return;
    if (!state.lastAudioAt) return;
    const idleFor = Date.now() - state.lastAudioAt;
    if (idleFor < this.cfg.finalizeMs) return;
    if (state.pending.length > 0) {
      if (!state.transcribing) {
        this.maybeTranscribe(state, ws);
      }
      return;
    }
    if (state.transcribing) {
      this.logDebug(state, `finalize_wait reason=${reason} transcribing`);
      return;
    }
    if (state.chunker.size() >= this.cfg.minAudioBytes) {
      this.logDebug(state, `finalize_flush_tail bytes=${state.chunker.size()}`);
      state.pending.push(state.chunker.takeAll());
      this.maybeTranscribe(state, ws);
      return;
    }
    if (!state.liveText) return;
    this.clearFinalizeTimer(state);
    this.sendJson(ws, { type: "final", text: state.liveText });
    this.logEvent(state, {
      type: "stt_transcript",
      engine: state.engineName,
      model: state.model,
      lang: state.lang,
      text: state.liveText
    });
    this.logDebug(state, `finalize reason=${reason} text_len=${state.liveChars} idle_ms=${idleFor}`);
    state.liveText = "";
    state.liveChars = 0;
    state.lastAudioAt = 0;
    state.pending = [];
    state.chunker.clear();
  }

  private applyPartial(state: SttConnectionState, text: string, ws: WebSocket) {
    const next = this.normalizeText(text);
    if (next === state.liveText) return;
    const prevChars = state.liveChars;
    try {
      if (state.injectMode === "server") {
        if (prevChars > 0) {
          this.injectText(state, "\x7f".repeat(prevChars));
        }
        if (next) {
          this.injectText(state, next);
        }
      }
    } catch (err: any) {
      this.logEvent(state, {
        type: "stt_error",
        engine: state.engineName,
        model: state.model,
        lang: state.lang,
        message: err?.message || "Failed to inject transcript."
      });
      this.sendError(ws, err?.message || "Failed to inject transcript.");
      return;
    }
    state.liveText = next;
    state.liveChars = this.countChars(next);
    state.lastPartialAt = Date.now();
    this.sendJson(ws, { type: "partial", text: next });
    this.logDebug(
      state,
      `partial chars=${prevChars}->${state.liveChars} text="${this.truncate(next)}"`
    );
  }

  private injectText(state: SttConnectionState, text: string) {
    if (!text) return;
    this.writeToSession(state.sessionId, text);
  }

  private normalizeText(text: string): string {
    if (!text) return "";
    return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }

  private countChars(text: string): number {
    return Array.from(text).length;
  }

  private truncate(text: string, max = 120): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
  }

  private logDebug(state: SttConnectionState, message: string) {
    if (!this.cfg.debug) return;
    console.log(`[stt:${state.sessionId}] ${message}`);
  }

  private sendJson(ws: WebSocket, payload: any) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  private sendInfo(ws: WebSocket, message: string) {
    this.sendJson(ws, { type: "info", message });
  }

  private sendError(ws: WebSocket, message: string) {
    this.sendJson(ws, { type: "error", message });
  }

  private logEvent(state: SttConnectionState, event: Omit<SttAuditEvent, "at" | "userId" | "sessionId">) {
    if (!this.audit) return;
    this.audit({
      ...event,
      at: new Date().toISOString(),
      userId: state.userId,
      sessionId: state.sessionId
    });
  }
}
