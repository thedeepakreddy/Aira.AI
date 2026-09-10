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

### 2. Permissions default to allow-everything, and the config did not gate it

Every built-in agent (`build`, `plan`, `explore`, `general`, ...) resolves with
`{"permission": "*", "pattern": "*", "action": "allow"}` as its first rule.
Out of the box opencode edits files and runs shell commands **without asking**.

`opencode.json` accepts a permission policy, per action
(`read`, `edit`, `bash`, `glob`, `grep`, `list`, `task`, `webfetch`,
`websearch`, `external_directory`, `lsp`, ...) with values `ask | allow | deny`,
both globally and per agent. `GET /config` confirms the policy is parsed and
stored.

**But it did not take effect in the one path tested.** With
`agent.build.permission.bash = "deny"`, `POST /session/{id}/shell` still
executed the command and `GET /permission` stayed empty. The most likely reading
is that `/session/{id}/shell` is a direct execution API outside the tool
permission system, which only governs *agent-initiated* tool calls — but that
was not proven, because exercising the agent loop needs model credit the test
account does not have.

**Consequence for Aira:** do not treat opencode's permission config as the
safety boundary until it has been verified against a real agent run. Aira should
gate destructive actions in its own UI and simply not call `/session/{id}/shell`
except from an explicit user action.

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
per-tier limits.

## Reproducing

```sh
npm install opencode-ai
OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 16) \
  ./node_modules/.bin/opencode serve --port 4096
curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/doc > openapi.json
```
