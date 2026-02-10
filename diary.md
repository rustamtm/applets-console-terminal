# Journey

## 2026-02-05
- Added terminal font size controls in Settings (slider + A-/A+).
- Exposed terminal font size get/set/step hooks so Settings can drive xterm resizing.
- Added Settings panel spacing for the new Terminal section.
- Removed the compose overlay (multi-line command helper) from the terminal UI.

## 2026-02-04
- Removed the topbar folder context chip.
- Replaced connection status text with a colored status dot, keeping non-connection messages visible.
- Fixed mobile terminal scrolling to prevent page scroll/pull-to-refresh by capturing touch move and tightening overscroll behavior.
- Hardened mobile scroll lock by disabling native touch actions inside the terminal container, capturing touch events, and keeping the mobile bar interactive.
- Expanded Codex CLI activity detection so session dots light up for common banners/prompts (e.g., OpenAI Codex, /permissions, /model).
- Re-enabled mobile autocorrect/suggestions for terminal typing (autocorrect, autocapitalize, spellcheck).
- Added tap/click cursor move in the terminal (maps touch/mouse position to cell and moves within the current wrapped line).
- Moved audio toggles into a dedicated Settings popup (added Settings button in topbar/mobile).
- Moved Codex exec and client logs into the Settings popup.
- Added client-side TTS console logs for codex enqueue and terminal output.
- Added client-side codex-running terminal background toggle via `codexRunning` class and CSS variable.
- Added best-effort last-known `cwd` persistence and reuse for new sessions (OSC 7/title parsing) with `~` expansion on the server.
- Added terminal codex activity tracking (OSC + output heuristics) to drive session dot responsiveness and per-session codex state.
- Added a lighter "root console" vanilla UI served from `console-terminal/ui-vanilla` and mounted by `server.js` (separate from the fancy console app).
- Disabled TTS/STT for root console by default and added env overrides plus separate audit/prefs paths and tmux prefix.
- Added tabbed multi-session navigation in the vanilla UI (new tab, close tab, per-tab resume key/mode/cwd persistence).
- Extended `createConsoleApp` to accept a custom `uiDist` so root console can serve a different UI bundle.
- Added a dedicated root console server entrypoint and start script so it runs independently of applets/console.
- Created Cloudflare tunnel config + DNS routing for `root.caravanflow.com` (root console).
