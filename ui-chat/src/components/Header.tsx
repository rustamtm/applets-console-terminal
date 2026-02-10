import React, { useMemo } from "react";
import { Badge, Button, Dropdown, Option, Text, ToggleButton } from "@fluentui/react-components";
import type { ConnectionState, ChatSettings, SessionInfo } from "../types/events";

interface HeaderProps {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  connectionState: ConnectionState;
  settings: ChatSettings;
  onSessionChange: (sessionId: string) => void;
  onSettingsChange: (settings: Partial<ChatSettings>) => void;
  onNewSession: () => void;
}

const connectionLabels: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting"
};

const connectionBadgeColor: Record<ConnectionState, React.ComponentProps<typeof Badge>["color"]> = {
  connected: "success",
  connecting: "warning",
  reconnecting: "warning",
  disconnected: "danger"
};

export const Header: React.FC<HeaderProps> = ({
  sessions,
  currentSessionId,
  connectionState,
  settings,
  onSessionChange,
  onSettingsChange,
  onNewSession
}) => {
  const selectedLabel = useMemo(() => {
    const current = sessions.find((s) => s.id === currentSessionId);
    if (!current) return "";
    return `${current.tmuxName || current.id.slice(0, 8)} (${current.mode})`;
  }, [currentSessionId, sessions]);

  return (
    <div className="chat-header" data-testid="chat-header">
      <Text weight="semibold" className="chat-header-title">
        Console Chat
      </Text>

      <div className="session-selector">
        <Dropdown
          size="small"
          placeholder="Select session"
          value={selectedLabel}
          selectedOptions={currentSessionId ? [currentSessionId] : []}
          onOptionSelect={(_ev, data) => {
            const optionValue = String(data.optionValue || "");
            if (!optionValue) return;
            onSessionChange(optionValue);
          }}
          data-testid="session-select"
        >
          {sessions.map((session) => (
            <Option key={session.id} value={session.id}>
              {session.tmuxName || session.id.slice(0, 8)} ({session.mode})
            </Option>
          ))}
        </Dropdown>
        <Button size="small" onClick={onNewSession} data-testid="new-session">
          New
        </Button>
      </div>

      <div className="connection-status" data-testid="connection-status">
        <Badge
          appearance="tint"
          shape="rounded"
          size="small"
          color={connectionBadgeColor[connectionState]}
        >
          {connectionLabels[connectionState]}
        </Badge>
      </div>

      <div className="settings-panel">
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={settings.groupOutput}
          onClick={() => onSettingsChange({ groupOutput: !settings.groupOutput })}
          data-testid="toggle-group"
        >
          Group
        </ToggleButton>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={settings.autoScroll}
          onClick={() => onSettingsChange({ autoScroll: !settings.autoScroll })}
          data-testid="toggle-autoscroll"
        >
          Auto
        </ToggleButton>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={settings.showAnsi}
          onClick={() => onSettingsChange({ showAnsi: !settings.showAnsi })}
          data-testid="toggle-ansi"
        >
          ANSI
        </ToggleButton>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={settings.monospaceOutput}
          onClick={() => onSettingsChange({ monospaceOutput: !settings.monospaceOutput })}
          data-testid="toggle-mono"
        >
          Mono
        </ToggleButton>
        <ToggleButton
          size="small"
          appearance="subtle"
          checked={settings.showTimestamps}
          onClick={() => onSettingsChange({ showTimestamps: !settings.showTimestamps })}
          data-testid="toggle-time"
        >
          Time
        </ToggleButton>
      </div>
    </div>
  );
};
