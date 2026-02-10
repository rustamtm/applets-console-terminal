import React, { useCallback, useRef, useState, KeyboardEvent } from "react";
import { Button, Textarea, type TextareaOnChangeData } from "@fluentui/react-components";

interface ComposerProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

export const Composer: React.FC<ComposerProps> = ({ disabled, onSend }) => {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
  }, []);

  const handleSend = useCallback(() => {
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(text);
    setText("");
    resetHeight();
  }, [disabled, onSend, resetHeight, text]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>, data: TextareaOnChangeData) => {
    const target = e.target;
    setText(data.value);
    // Auto-resize textarea (cap to keep iPhone usable).
    target.style.height = "auto";
    target.style.height = Math.min(target.scrollHeight, 160) + "px";
  }, []);

  return (
    <div className="composer" data-testid="composer">
      <Textarea
        textarea={{ ref: textareaRef, className: "composer-input", "data-testid": "composer-input-textarea" }}
        className="composer-textarea"
        placeholder="Type a command..."
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        resize="vertical"
      />
      <Button
        appearance="primary"
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        data-testid="composer-send"
      >
        Send
      </Button>
    </div>
  );
};
