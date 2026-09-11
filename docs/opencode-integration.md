# OpenCode integration

Current implementation and verification as of 2026-09-12. This document describes
the code checked in this repository; it does not claim that an arbitrary
OpenCode version or a configured paid model account has been tested.

## Connection and execution

The desktop shell supervises `opencode serve --hostname 127.0.0.1 --port <port>`
after the user chooses a specific project folder. Filesystem root and the home
directory are rejected. Each launch gets a random HTTP Basic-auth password.
Aira waits for authenticated `GET /global/health` before treating the runtime as
ready. The process is stopped on explicit shutdown, sign-out, and application
exit. Web users get an explicit desktop requirement for local filesystem work.

The supervisor passes configuration through `OPENCODE_CONFIG_CONTENT`.
The `aira` provider uses `@ai-sdk/openai-compatible`, base URL
`<gateway>/openai/v1`, the current Aira session token as its API key, and the
actual configured model selected from the gateway catalogue. Vendor API keys
remain in the gateway. The process status reports its actual selected model.

## Server endpoints used by the panel

| Purpose | Endpoint |
|---|---|
| Health | `GET /global/health` |
| List/create sessions | `GET /session`, `POST /session?directory=<path>` |
| Start a turn | `POST /session/{id}/prompt_async` |
| Read messages | `GET /session/{id}/message` |
| Stream events | `GET /event`, filtered by session in the client |
| Runtime status | `GET /session/status` |
| Cancel current turn | `POST /session/{id}/abort` |
| Pending permissions/questions | `GET /permission`, `GET /question` |
| Answer permission | `POST /permission/{id}/reply` |
| Answer/reject question | `POST /question/{id}/reply`, `POST /question/{id}/reject` |

The panel attaches the event subscription before sending a prompt. It handles
message deltas, tool progress, permission requests, questions, completion and
failure. It understands both `permission.asked` and
`permission.v2.asked` shapes and uses request ids to clear resolved prompts.
Session history, pending permissions and questions are refreshed when
reconnecting. All local HTTP requests include the per-launch Basic credential.

## Permissions and shared tools

The generated policy permits project reads and discovery. File edits, shell
commands, subagents and Aira MCP tools request approval. External directories
and OpenCode's independent web-fetch/search tools are denied. Aira's permission
UI offers one-time approval or rejection. The direct OpenCode shell endpoint is
not an exposed Aira action and must not be used as a permission bypass.

OpenCode connects to two separate MCP servers:

- `aira_memory`: `<gateway>/mcp`, with the same Aira Bearer session token.
  Provides `memory_search`, `memory_remember`, `memory_forget` and `models_list`.
- `aira_browser`: `http://127.0.0.1:<browser-port>/mcp`, included when the local
  browser service is running, with its separate local Bearer token. Browser
  operations use the Chrome session shown in the Browser panel.

The two tokens have different scopes and are not interchangeable. The gateway
does not receive the browser token. Starting the browser after OpenCode means
the coding runtime must restart to pick up that new local MCP connection.

All coding requests also receive authenticated user-scoped shared context
automatically through the gateway. User memory preferences are enforced there,
so pausing memory takes effect across tools. Explicit MCP operations and
automatic conversation excerpts share the same backing store.

## Authentication and lifecycle limits

Supabase sessions are verified by the gateway on every model and memory request.
An expired access token produces 401; the application coordinates local runtime
shutdown when credentials change. The current architecture does not issue a
long-lived agent token or hot-swap credentials inside a running OpenCode process.
Restart with the renewed session to obtain a new gateway/MCP token.

Loopback binding and Basic auth do not isolate an agent from other code running
as the same operating-system user. Project config and installed runtime/plugins
also remain part of the local trust boundary. A full sandboxed execution worker
is a separate deployment capability, not a promise of this integration.

## Verified without a paid provider

The gateway suite covers function definitions, tool choice, strict schemas,
parallel calls, tool-result sequencing, streaming success/errors, cancellation,
model selection, memory isolation and MCP transport validation.

A real installed OpenCode binary was additionally run in a temporary project
with isolated XDG config/data/cache/state, `--pure`, only the fixture provider
enabled, and no vendor credentials. Its actual client completed:

1. A request through Aira's OpenAI-compatible gateway.
2. An MCP `memory_search` call against Aira's shared memory service.
3. The tool result back through the model proxy.
4. A final completion successfully parsed by OpenCode.

That run made three mocked model requests and one actual memory-tool call.
It verifies client protocol wiring, not model intelligence or vendor access.
The fixture uses a narrowly allowed memory tool to complete without interactive
approval; desktop approval presentation is covered by the frontend tests.

Reproduce from `services/gateway` with:

```sh
npm run typecheck
npm test
node --experimental-strip-types tests/opencode.integration.mjs
```

The integration requires an installed `opencode` command and permission to bind
a loopback port. Temporary fixture directories are reported after the run.
No provider credentials or provider credit are used.

See [the gateway contract](../services/gateway/README.md) for catalogue setup,
MCP wire headers, persistent-memory migrations and production boundaries.
