import React, { useCallback, useRef, useState } from "react";
import { Button, Card, Text } from "@fluentui/react-components";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../types/events";

const VirtuosoList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function VirtuosoList(
  props,
  ref
) {
  return <div {...props} ref={ref} className={["message-list", props.className].filter(Boolean).join(" ")} />;
});

interface MessageListProps {
  messages: ChatMessage[];
  autoScroll: boolean;
  showTimestamps: boolean;
  monospace: boolean;
  showAnsi: boolean;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  autoScroll,
  showTimestamps,
  monospace,
  showAnsi
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const handleAtBottomStateChange = useCallback((bottom: boolean) => {
    setShowJumpButton(!bottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: Math.max(0, messages.length - 1),
        behavior: "smooth",
        align: "end"
      });
    }
  }, [messages.length]);

  const renderMessage = useCallback(
    (index: number) => {
      const message = messages[index];
      if (!message) return null;
      return (
        <MessageBubble
          key={message.messageId}
          message={message}
          showTimestamp={showTimestamps}
          monospace={monospace}
          showAnsi={showAnsi}
        />
      );
    },
    [messages, showTimestamps, monospace, showAnsi]
  );

  if (messages.length === 0) {
    return (
      <div className="message-list-container" data-testid="message-list">
        <div className="empty-state" data-testid="empty-state">
          <Card appearance="filled-alternative" size="small" className="empty-state-card">
            <Text weight="semibold" className="empty-state-title">
              No output yet
            </Text>
            <Text className="empty-state-subtitle">
              Pick a session from the dropdown or click <strong>New</strong>, then send a command.
            </Text>
            <div className="empty-state-examples">
              <span className="empty-state-example">
                <code>ls</code>
              </span>
              <span className="empty-state-example">
                <code>pwd</code>
              </span>
              <span className="empty-state-example">
                <code>seq 1 2000</code>
              </span>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list-container" data-testid="message-list">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        itemContent={(index) => renderMessage(index)}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={100}
        followOutput={autoScroll ? "smooth" : false}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        components={{ List: VirtuosoList }}
        style={{ height: "100%" }}
      />
      {showJumpButton && (
        <Button
          className="jump-to-bottom"
          appearance="secondary"
          size="small"
          onClick={jumpToBottom}
          data-testid="jump-to-latest"
        >
          Jump to latest
        </Button>
      )}
    </div>
  );
};
