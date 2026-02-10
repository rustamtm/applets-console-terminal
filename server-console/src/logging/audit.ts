import fs from "node:fs";
import path from "node:path";

export type AuditEvent =
  | {
      type: "auth_ok" | "auth_fail";
      at: string;
      userId?: string;
      email?: string;
      reason?: string;
    }
  | {
      type: "session_create" | "session_close" | "session_kill";
      at: string;
      userId: string;
      sessionId: string;
      mode: string;
      reason?: string;
      pid?: number;
      exitCode?: number;
      signal?: number;
    }
  | {
      type: "session_attach" | "session_detach" | "session_resize";
      at: string;
      userId: string;
      sessionId: string;
      cols?: number;
      rows?: number;
    }
  | {
      type: "chat_attach" | "chat_detach";
      at: string;
      userId: string;
      sessionId: string;
    }
  | {
      type:
        | "tts_attach"
        | "tts_detach"
        | "tts_start"
        | "tts_stop"
        | "tts_config"
        | "tts_error"
        | "tts_drop";
      at: string;
      userId: string;
      sessionId: string;
      engine?: string;
      voice?: string;
      model?: string;
      message?: string;
    }
  | {
      type:
        | "stt_attach"
        | "stt_detach"
        | "stt_start"
        | "stt_stop"
        | "stt_config"
        | "stt_error"
        | "stt_transcript";
      at: string;
      userId: string;
      sessionId: string;
      engine?: string;
      model?: string;
      lang?: string;
      message?: string;
      text?: string;
    }
  | {
      type: "applets_restart";
      at: string;
      userId: string;
      email?: string;
      method: "spawn" | "tmux";
      tmuxSession?: string;
      pid?: number;
      logPath?: string;
    };

export function createAuditLogger(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: "a" });

  return {
    log(event: AuditEvent) {
      stream.write(`${JSON.stringify(event)}\n`);
    },
    close() {
      stream.end();
    }
  };
}
