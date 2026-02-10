# Session Task Names (Console Terminal UI)

The Console Terminal web UI lets you set a per-session **Task name** (a custom label) so it is easier to identify sessions on mobile.

## Where It Shows Up

- Mobile top bar title: uses the custom Task name if set, otherwise falls back to `tmuxName` or the session id.
- Session tab strip (colored pills): shows a tiny label inside the pill when a custom Task name is set.
- Current session strip: a thin black strip above the session tabs that shows:
  - `<name>` when a custom Task name is set, otherwise
  - `AUTO <suggestion>` when an AI suggestion exists.
- Sessions list: keeps the system session name as the main line (tmux name or id) and shows the custom Task name as a secondary line.

## Character Limit

- Hard limit: **96 characters** (enforced in the input).
- Recommended:
  - 20-24 chars for best readability on mobile.
  - Use short prefixes like `SN:`, `DOCX:`, `GPU:`, `DL:` etc.

## Storage / Behavior

- Stored locally in the browser in `localStorage` under `console.sessionMeta.v1` as `SessionMeta.name`.
- When a name is set, we also track `SessionMeta.nameSource`:
  - `user` when you type in the input.
  - `ai` when AI naming writes the manual name (bulk or “use suggestion”).
- Clearing the input (empty string) removes the custom name for that session.

## AI Bulk Rename On Reconnect

- Preference stored under `console.aiAutoBulkNameOnReconnect.v1` (checkbox in Settings).
- When enabled, after a disconnect/reconnect (e.g. server restart) the UI will bulk-refresh:
  - unnamed sessions, and
  - sessions with `nameSource=ai`
  - while never overwriting `nameSource=user`.

## Implementation Pointers

- Console UI: `console-terminal/ui/src/App.tsx`, `console-terminal/ui/src/styles.css`
- Root UI: `console-terminal/ui-root/src/App.tsx`, `console-terminal/ui-root/src/styles.css`
