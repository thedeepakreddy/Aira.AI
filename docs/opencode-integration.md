# OpenCode integration surface

Findings from running opencode standalone (v1.18.30) and reading its live
OpenAPI spec, not from documentation alone. Verified 2026-09-11.

## License

MIT, confirmed at both the npm package (`opencode-ai@1.18.30`) and the
repository (`anomalyco/opencode`, ~206k stars, not archived). Note the project
also publishes under `opencode-ai/opencode`; `opencode.ai` points at the
`anomalyco` repo, which is the one checked here.

Aira brings its own model credentials, so opencode's provider integrations are
not a licensing concern for us.

## The interface is far better than a TUI

The brief anticipated possibly having to scrape a human-facing TUI. That is not
necessary. opencode ships a headless server:

```sh
opencode serve --port <n> --hostname 127.0.0.1
```

- HTTP REST + Server-Sent Events
- **162 endpoints**, described by a live OpenAPI 3.1 spec at `GET /doc`
- `GET /global/health` -> `{"healthy":true,"version":"1.18.30"}`

There is also `opencode run --format json` (raw JSON events on stdout) for
one-shot use, and `opencode acp` (Agent Client Protocol). The server is the
right surface for Aira: it keeps sessions, streams events, and exposes the
permission system.

## Endpoints Aira needs

| Purpose | Endpoint |
|---|---|
| Create session | `POST /session` |
| Send message | `POST /session/{id}/message` |
| Stream everything | `GET /event` (SSE) |
| Stream one session | `GET /api/session/{id}/event` |
| Cancel | `POST /session/{id}/abort` |
| History | `GET /session/{id}/message` |
| Pending permissions | `GET /permission` |
| Answer a permission | `POST /permission/{requestID}/reply` |
| See what changed | `GET /vcs/diff`, `GET /session/{id}/diff` |
| Undo | `POST /session/{id}/revert` |

Events arrive as `data: {"id":"evt_...","type":"...","properties":{...}}`.
94 event types are declared. The ones a panel needs:

- `message.part.delta` -> `{sessionID, messageID, partID, field, delta}`
  Token-level streaming, addressable per part.
- `permission.v2.asked` -> `{id, sessionID, action, resources[], save[], source}`
  Names the action *and* the affected files, so the UI can say what is about to
  happen before it happens.
- `file.edited`, `command.executed`, `message.updated`, `session.*`

Permission replies are `{"reply": "once" | "always" | "reject"}`.

## Two things that must be handled before wiring this in

### 1. The server is unauthenticated by default

On startup without a password it prints:

> Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.

**`POST /session/{id}/shell` executes arbitrary shell commands.** Verified: it
ran `echo` and returned the output. So an unsecured server is local arbitrary
code execution for anything that can reach the port.

Mitigation, verified working: set `OPENCODE_SERVER_PASSWORD` to a random
per-launch secret. Every route then returns 401 without HTTP Basic auth,
including `/session/{id}/shell`. Aira must generate this secret per launch,
keep it in memory, bind to `127.0.0.1`, and never pass `--cors`.

### 2. Permissions default to allow-everything, but the policy does work

Every built-in agent (`build`, `plan`, `explore`, `general`, ...) resolves with
`{"permission": "*", "pattern": "*", "action": "allow"}` as its first rule.
**Out of the box opencode edits files and runs shell commands without asking.**
A policy must be set explicitly.

`opencode.json` accepts one per action (`read`, `edit`, `bash`, `glob`, `grep`,
`list`, `task`, `webfetch`, `websearch`, `external_directory`, `lsp`, ...) with
values `ask | allow | deny`, globally or per agent.

**Verified working, both directions**, against a real agent run:

With `edit: "ask"`, asked to create a file:

```
! permission requested: edit (…/hello.txt); auto-rejecting
✗ Write hello.txt failed
Error: The user rejected permission to use this specific tool call.
```

The request names the exact file, and `run` auto-rejects when there is no UI to
ask — a safe default. With `edit: "allow"`, the same task wrote the file.

An earlier note here said the policy did not take effect. That was wrong, and
the reason is worth keeping: the only path testable without model credit was
`POST /session/{id}/shell`, which is a **direct execution API sitting outside
the tool permission system**. Agent-initiated tool calls *are* gated; that one
endpoint is not.

So for Aira:

- set `edit` and `bash` to `ask`
- subscribe to `permission.v2.asked` on the event stream and render Allow/Deny
- answer with `POST /permission/{requestID}/reply` -> `once | always | reject`
- **never call `/session/{id}/shell` except from an explicit user action**, since
  nothing gates it

## Credentials: opencode does not use Aira's gateway

`GET /config/providers` on a clean install returns exactly one provider,
`opencode`, with 7 models, default `big-pickle` — opencode's own hosted service.
Anthropic and OpenAI are not configured.

This matters for the business model: **agent work would bill through whatever
provider opencode is configured with, not through Aira's gateway**, so it would
not appear in Aira's usage events and would not be covered by Aira's caps.

Three ways to resolve it:

1. **Point opencode at Aira's gateway** as an OpenAI-compatible provider. Keeps
   one metering path and one set of caps. Requires the gateway to expose an
   OpenAI-compatible `/v1/chat/completions`, which it does not yet.
2. **Give opencode the provider keys directly.** Simplest, but agent spend
   becomes invisible to metering and uncapped — dangerous when Aira pays.
3. **Users authenticate opencode themselves.** No cost to Aira, but it breaks
   the single-subscription story.

Option 1 is the only one consistent with Aira paying for tokens and enforcing
per-tier limits, and it is the one implemented.

## Routing opencode through the gateway (implemented, verified)

The gateway exposes an OpenAI-compatible surface at `/openai/v1`, kept off
`/v1` so it cannot collide with Aira's own catalogue shape:

- `GET  /openai/v1/models`
- `POST /openai/v1/chat/completions` (streaming and non-streaming)

opencode is configured to use it as a custom provider:

```json
{
  "provider": {
    "aira": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Aira Gateway",
      "options": { "baseURL": "<gateway>/openai/v1", "apiKey": "<token>" },
      "models": { "claude-sonnet-5": { "name": "Sonnet 5" } }
    }
  },
  "model": "aira/claude-sonnet-5"
}
```

Verified end to end:

- `opencode models` lists `aira/claude-opus-5`, `aira/claude-sonnet-5`,
  `aira/claude-haiku-4-5`
- `opencode run` reaches the gateway — the error it surfaced was Aira's own
  humanised message coming back through opencode
- the gateway emitted usage events tagged `surface=code` with the user id and
  model, which is the point: **agent spend is metered like every other surface**

The real OpenAI SDK was also pointed at the endpoint and parsed the model list,
the non-streaming reply and the streaming reply, so the wire format is right.
Seven protocol tests cover the success paths offline with a stub provider,
including the `[DONE]` sentinel that OpenAI clients hang without.

### The tools bug this surfaced

The first real agent run failed in a way worth recording: opencode replied with
a bash command as markdown instead of running it. The model was capable of tool
calling — the gateway was **silently dropping `tools` from the request**, so the
model never saw any. A gateway that loses tool definitions turns an agent into
something that can only describe actions it cannot take.

The fix extended the neutral contract with tool definitions, tool calls and tool
results, and taught both adapters to translate: OpenAI nests the schema under
`function.parameters`, Anthropic calls it `input_schema` and has no `tool` role
at all — results come back as `tool_result` blocks inside a *user* message, and
all results answering one turn must share a single message or the model learns
to stop making parallel calls.

Proven by the same A/B that exposed it: identical request, direct to the
provider and through the gateway, now both return
`write_file({"path":"hello.txt","content":"hi"})`.

### Verified end to end

`opencode run "Create a file named hello.txt containing exactly: hi from aira"`
routed through the gateway to OpenRouter, made a real tool call, and wrote the
file. The gateway metered it as `surface=code`.

Still open: opencode holds the gateway token for its process lifetime, but a
Supabase access token expires in an hour. The desktop shell will need either a
longer-lived, revocable agent token or a local refresh proxy — decided when the
process manager is built.

## Reproducing

```sh
npm install opencode-ai
OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 16) \
  ./node_modules/.bin/opencode serve --port 4096
curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/doc > openapi.json
```
