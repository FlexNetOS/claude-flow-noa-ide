# @claude-flow/visualizer

Realtime backend and typed contracts for the Ruflo Swarm Visualizer MVP.

## Features

- Typed normalized swarm events
- File-backed append-only session store
- Session snapshot projection builder
- Express query API
- WebSocket live stream and replay endpoint
- Synthetic demo session seeding for local UI work

## Local Development

```bash
cd v3/@claude-flow/visualizer
npm install
npm run dev
```

Endpoints:

- `GET /api/health`
- `GET /api/sessions`
- `GET /api/sessions/:sessionId/snapshot`
- `GET /api/sessions/:sessionId/events`
- `POST /api/dev/seed-session`
- `POST /api/ingest/runtime-event`
- `ws://localhost:8787/ws/visualizer`
