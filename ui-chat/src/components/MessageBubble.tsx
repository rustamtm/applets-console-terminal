import React, { useMemo } from "react";
import AnsiToHtml from "ansi-to-html";
import { Card } from "@fluentui/react-components";
import type { ChatMessage } from "../types/events";

interface MessageBubbleProps {
  message: ChatMessage;
  showTimestamp: boolean;
  monospace: boolean;
  showAnsi: boolean;
}

function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "";
  }
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  showTimestamp,
  monospace,
  showAnsi
}) => {
  const isUser = message.role === "user";
  const channelClass = message.channel;
  const rawText = typeof (message.meta as any)?.rawText === "string" ? String((message.meta as any).rawText) : "";

  const ansiHtml = useMemo(() => {
    if (!showAnsi || isUser) return null;
    if (!rawText) return null;
    const converter = new AnsiToHtml({ escapeXML: true, newline: true });
    return converter.toHtml(rawText);
  }, [isUser, rawText, showAnsi]);

  return (
    <div
      className={`message-bubble ${message.role} ${channelClass}`}
      data-testid={`message-bubble-${message.role}`}
    >
      <Card
        appearance={isUser ? "filled" : "filled-alternative"}
        size="small"
        className={`message-card ${isUser ? "user" : "system"}`}
      >
        <div className={`message-content ${monospace && !isUser ? "monospace" : ""}`}>
          {ansiHtml ? (
            <span className="ansi" dangerouslySetInnerHTML={{ __html: ansiHtml }} />
          ) : (
            message.text
          )}
          {message.isStreaming && <span className="message-streaming-indicator" />}
        </div>
        {showTimestamp && <div className="message-timestamp">{formatTimestamp(message.createdAt)}</div>}
      </Card>
    </div>
  );
};
