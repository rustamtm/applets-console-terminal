# Console Terminal Chat UI

This is a parallel frontend for `console-terminal` that renders a PTY session as a chat timeline (Fluent UI v9 + React Virtuoso).

It is served by the console server at:

- `GET /chat` (SPA entry)
- `GET /chat/assets/*` (static assets)

It reuses the existing session model + attach token flow, but connects to a dedicated WebSocket endpoint:

- `WS /ws/chat/sessions/:id?attachToken=...`

## Dev

1. Start the console server:

```sh
npm run dev:console:server
```

2. Start the chat UI dev server:

```sh
npm run dev:console:chat
```

Open:

- `http://127.0.0.1:5176/chat/`

The Vite dev server proxies `/api/*` and `/ws/*` to the console server.

## Build

```sh
npm run build:console:chat
```

Build output:

- `console-terminal/ui-chat/dist`

## Attach Flow (Important)

The server mints one-time attach tokens via:

- `POST /api/sessions/:id/attach-chat` -> `{ attachToken, chatWsUrl, ... }`

The chat WebSocket validates and consumes the token on upgrade. Reconnect requires minting a new token.

For the full chat event protocol, see:

- `docs/console-terminal-chat-protocol.md`

