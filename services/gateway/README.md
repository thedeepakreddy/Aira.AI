# Aira Gateway

Authenticated model gateway and shared-memory service for the web app, Tauri
desktop app, OpenCode, OpenClaw, and browser research. Provider credentials stay
on this server. Browser automation is a separate authenticated local service;
the hosted gateway never receives a user's browser-control token.

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
path on its own. This mode binds only to loopback and has one identity,
`dev-user`; caller-supplied identity headers cannot select another user.
Production requires Supabase bearer sessions, HTTPS, and both SQL migrations in
`migrations/`. Do not put the service-role key in a client environment file.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness and configuration; does not probe paid provider access |
| GET | `/v1/models` | Configured picker catalogue, optional price estimates, routing |
| POST | `/v1/chat` | Streams a reply as SSE |
| GET | `/openai/v1/models` | Authenticated OpenAI-compatible catalogue |
| POST | `/openai/v1/chat/completions` | Coding-agent completions |
| GET | `/openai/task/v1/models` | Same catalogue for task clients |
| POST | `/openai/task/v1/chat/completions` | Task-agent / browser-research completions |
| GET | `/v1/memory?query=&limit=30` | Inspect or search this user's notes |
| POST | `/v1/memory` | Save `{text, surface?}`; returns `{entry}` |
| DELETE | `/v1/memory/:id` | Delete one owned note; 404 if missing or foreign |
| DELETE | `/v1/memory` | Delete this user's stored notes |
| GET, PATCH | `/v1/memory/preferences` | Read or update `{enabled: boolean}` |
| POST | `/mcp` | Authenticated Streamable HTTP MCP, JSON response mode |

`POST /v1/chat` takes `{ messages, surface?, model?, system?, conversationId?, maxTokens? }`
and streams normalised events: `start`, `text`, `thinking`, `done`, `error`.
The event shape is identical across providers. Tool turns use
`{role:"assistant", content:"", toolCalls:[{id,name,arguments}]}`, followed by
`{role:"tool", content:"result", toolCallId:"..."}`. Every outstanding call must
receive exactly one result before another model completion is requested.

OpenAI-compatible requests preserve function definitions, strict schemas,
`tool_choice`, `parallel_tool_calls`, screenshot image parts, text content,
`response_format: json_schema`, common `reasoning_effort` values (low / medium /
high), token limits, sampling options and stop sequences. Provider-specific
limits still apply. Anthropic has no frequency/presence penalties and requires
`json_schema` rather than `json_object`; browser research therefore configures
its default frequency penalty to `None`. Audio, files, legacy function-call
syntax and unsupported options return validation errors instead of being
silently lost. This is a Chat Completions subset, not a Responses API endpoint.

Streaming clients requesting `stream_options.include_usage` receive the
OpenAI-specified final chunk with `choices: []` and usage, followed by `[DONE]`.
Provider errors and prematurely closed streams produce errors, never a false
successful stop. Disconnects cancel provider work. Gateway requests have a
five-minute overall ceiling and provider transports use bounded timeouts.

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

Only providers with server-side credentials enter the catalogue. A compatible
provider key without a model catalogue, an invalid price/context, duplicate
model ids, and unavailable `AIRA_ROUTE_*` overrides fail startup with an error.
Unknown explicitly requested models fail the request; `auto` uses routing.
OpenRouter-only and Gemini-only deployments never advertise unavailable Claude
models. Anthropic's default catalogue can be overridden with `ANTHROPIC_MODELS`.

Compatible catalogue format is
`id|tier|contextWindow|inputPerMTok|outputPerMTok`; prices are optional. Legacy
`id:tier:contextWindow:input:output` remains accepted where its tier delimiter is
unambiguous. Slashes and colon suffixes such as `vendor/model:free` are retained.
Set `AIRA_COMPATIBLE_PROVIDERS` to a JSON array of `{id, baseURL, apiKeyEnv,
models, maxTokensField?}` to add another compatible vendor or local inference
server. Keys are read from the named environment variable. HTTPS is required
except for loopback servers. Defaults use `max_tokens` for compatible vendors
and `max_completion_tokens` for direct OpenAI. All model ids must be unique.
See `.env.example`; its generic vendor/model values are placeholders.

Model metadata means configured, not verified account entitlement. No automatic
discovery, background paid checks or hidden provider failover happens. Operators
choose and verify catalogue ids, prices, account access and evaluation quality.

## Shared memory and MCP

All automatic recall, notes and MCP operations use the authenticated Supabase
user id. Chat, voice, coding, tasks, browser summaries and workspace notes use
the same store. Records are quoted historical context, never system commands.
Automatic excerpts are capped at 400 characters, with a bounded context block;
explicit notes can contain up to 4,000 characters. This is recent working memory
and literal substring search, not a semantic vector index or a complete archive.

With Supabase configured, apply `001_memory.sql` and
`002_memory_preferences.sql`. Both tables use RLS with no direct client policy;
the gateway applies the user filter with its server credential. Missing tables
produce explicit errors on memory endpoints, while chat degrades to no memory.
It does not silently switch stores. Without Supabase, the local store is limited
to 200 notes per user and 1,000 users and is lost on restart. The UI and health
response disclose `storage: ephemeral | supabase | disabled`.

Users can pause recall and recording while still inspecting/deleting saved
notes. `AIRA_MEMORY=false` disables the server's memory feature. Private research
sends `X-Aira-Memory: off` to skip both recall and recording for that request.
Do not save credentials in memory. Recall covers 30 days; configure the documented
database maintenance deletion when physical retention must also be 30 days.

The `/mcp` endpoint implements the 2025-11-25, 2025-06-18 and 2025-03-26
Streamable HTTP protocol family. Clients send the same `Authorization: Bearer
<session>` as model requests and `Accept: application/json, text/event-stream`.
Supported methods are `initialize`, `notifications/initialized`, `ping`,
`tools/list`, and `tools/call`. Tools are `memory_search`, `memory_remember`,
`memory_forget`, and `models_list`. GET/DELETE return 405 because this stateless
server does not offer a background SSE stream or server-managed sessions. It
does not advertise prompts, resources, sampling, or tasks that it cannot serve.
Origin and protocol-version headers are validated. This endpoint accepts a
preconfigured bearer token; it does not implement OAuth discovery or consent.

OpenCode connects directly to this MCP endpoint and the local browser MCP.
OpenClaw receives shared context through its model requests; explicit OpenClaw
MCP configuration depends on the installed OpenClaw runtime. The browser MCP
controls the same local Chrome session displayed by Aira.

## Operational boundaries and checks

`AIRA_REQUESTS_PER_MINUTE` and `AIRA_MAX_CONCURRENT_REQUESTS` apply per user,
per gateway instance. Active streams retain their concurrency slot until the
body ends or is cancelled. Bodies are capped at 2 MiB. Multi-replica deployments
need a shared ingress limiter; these controls are not dollar quotas. Usage is
structured stdout telemetry, not a durable billing ledger. Add an event sink
for the deployment's log or billing storage. Price estimates do not account
for all provider cache discounts or partial usage lost on upstream failure.

`npm run typecheck` and `npm test` run without provider credentials. Regression
coverage includes provider-only routing, legacy configuration, adapters,
multimodal/schema preservation, tool round trips, streaming failures,
cancellation, auth gates, rate limits, body limits, user isolation, privacy
controls and MCP protocol behavior. If OpenCode is installed,
`node --experimental-strip-types tests/opencode.integration.mjs` starts an
isolated local fixture and exercises an actual OpenCode → gateway → MCP memory
tool round trip without using a paid provider.
The browser SDK can also be checked with
`AIRA_BROWSER_PYTHON=/path/to/browser/venv/bin/python node --experimental-strip-types tests/browser-client.integration.mjs`;
it verifies real browser-use screenshot serialization, strict JSON-schema
parsing, usage, and private-memory isolation against a mocked gateway.

The Docker build uses the lockfile and runs as the `node` user. HTTP shutdown
stops accepting new work and allows a short drain period. Production release
still requires deployed migration checks, real provider contract checks using
authorized credentials, load tests, deployment monitoring and platform builds.

Protocol references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat),
[Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[Anthropic model catalogue](https://platform.claude.com/docs/en/models/overview),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Usage events

Every request writes one JSON line to stdout:

```json
{"kind":"model_request","at":"...","userId":"...","surface":"chat",
 "payload":{"model":"configured-model-id","inputTokens":412,"outputTokens":88,
            "cacheReadTokens":0,"costUsd":null,"ok":true}}
```

Tokens are always recorded; `costUsd` is `null` when a model has no verified
price, so an unpriced model still meters correctly rather than logging a wrong
number. The event log is independent of the shared-memory store; it carries
usage metadata, not user conversation text. A durable billing system requires
a persistent event sink and reconciliation with vendor usage.

Add more sinks (Supabase, etc.) via `addEventSink` in `src/usage/events.ts`
without changing any caller.

## Adding a provider

For a compatible API, add a server-side `AIRA_COMPATIBLE_PROVIDERS` declaration.
For a new protocol, implement `ChatProvider` in `src/providers/`, construct the
adapter in `src/index.ts`, and register its configured models through
`src/providers/registry.ts`. Routes depend only on the neutral provider contract.
