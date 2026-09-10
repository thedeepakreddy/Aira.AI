# Aira Gateway

Model gateway for Aira. Everything that talks to a model provider goes through
here — the web app, the Tauri desktop app, and later the OpenCode and OpenClaw
panels.

## Why it exists

Aira pays for its own tokens, so provider API keys must live server-side. A web
bundle cannot hold them, and a packaged desktop app cannot either — anyone can
open a `.app` and read its contents. This service is the only place the keys
exist.

## Running locally

```bash
cp .env.example .env      # then fill in your keys
npm install
npm run dev
```

Without Supabase configured, set `AIRA_REQUIRE_AUTH=false` to test the model
path on its own. Do not deploy with it off — an unauthenticated request is an
unattributed bill.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, configured providers, model count |
| GET | `/v1/models` | Catalogue for the model picker, with pricing |
| POST | `/v1/chat` | Streams a reply as SSE |

`POST /v1/chat` takes `{ messages, surface?, model?, system?, conversationId?, maxTokens? }`
and streams normalised events: `start`, `text`, `thinking`, `done`, `error`.
The event shape is identical across providers.

## Routing

Routing keys off `surface`, never off message content, and never per turn:

| Surface | Tier | Why |
|---|---|---|
| `code` | frontier | Coding errors are expensive |
| `voice` | fast | Latency-bound, not intelligence-bound |
| `chat`, `task` | balanced | Default |

Prompt caches are scoped to a model, so switching models inside a conversation
discards the cached prefix and re-bills the whole history at full price. Route
per surface; to trade cost against quality *within* a surface, vary effort on
one model instead. Override any surface with `AIRA_ROUTE_*`, or per request with
an explicit `model` — an explicit choice always wins.

## Usage events

Every request writes one JSON line to stdout:

```json
{"kind":"model_request","at":"...","userId":"...","surface":"chat",
 "payload":{"model":"claude-sonnet-5","inputTokens":412,"outputTokens":88,
            "cacheReadTokens":0,"costUsd":0.00170,"ok":true}}
```

Tokens are always recorded; `costUsd` is `null` when a model has no verified
price, so an unpriced model still meters correctly rather than logging a wrong
number. Billing later becomes a query over these rows, and the shared memory
layer becomes a reader over the same log — neither has to be retrofitted.

Add more sinks (Supabase, etc.) via `addEventSink` in `src/usage/events.ts`
without changing any caller.

## Adding a provider

Implement `ChatProvider` in `src/providers/`, register it in `src/index.ts`.
Nothing above the interface changes.
