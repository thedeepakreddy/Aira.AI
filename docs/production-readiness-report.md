# Aira — implementation and production-readiness report

Reviewed and updated: 12 September 2026. Baseline: `0985083`.

## Executive result

A substantial repair and integration pass is implemented in the working tree.
The main page's warm visual language is preserved; Code, Agents, Browser and
Workspace now use coherent, responsive workbenches with real state and errors.
The active frontend, native supervisors, gateway and browser-service paths were
reviewed together, including their authentication and tool contracts.

This is **not a claim of a finished, zero-defect public release**. Local tests,
real Chrome and real client integrations establish the behavior described
below. They do not establish paid-provider entitlement, deployed database
correctness, native voice support, scale, or distribution readiness. Specific
remaining gates are listed rather than hidden behind successful build output.
No live deployment, production migration, paid model request, or installation
over an existing Aira application was performed.

## Audit scope

- Active React entry, every Aira feature panel, shared utilities and UI controls,
  routing, styles, account state, attachments, SSE and gateway/native clients.
- All active Rust supervisors and native command wiring, capabilities, CSP,
  packaged resources, platform metadata and shutdown behavior.
- Gateway configuration, authentication, provider catalogue/routing/adapters,
  both completion protocols, tool validation, memory, MCP, limits, usage, SQL
  migrations and deployment configuration.
- Python Chrome service, tabs, input, research, cancellation, private profiles,
  local HTTP/MCP security, runtime dependency and smoke-test scripts.
- Existing tests and newly added regression/integration checks.
- The legacy `askdeepakai-front-end` application flow was inspected. It is an
  unused visual reference with simulated auth, responses and terminal behavior;
  it was left intact. Generated dependencies, build output and its unused stock
  UI component library are not a claimed line-by-line application audit.

## Architecture and actual connection map

```text
Web / Tauri React workspace
  ├─ Chat + Voice + Workspace ── bearer session ── Aira gateway
  │                                              ├─ configured model providers
  │                                              ├─ per-user shared memory
  │                                              └─ memory/catalogue MCP
  └─ Tauri native supervisors (desktop only)
       ├─ OpenCode ── compatible completions ───── Aira gateway
       │           ├─ memory MCP ──────────────── Aira gateway
       │           └─ browser MCP ─┐
       ├─ Browser interactive view ├─ one authenticated local Chrome session
       │           Research runner ┘              └─ task completions → gateway
       └─ OpenClaw ── task completions ─────────── Aira gateway
                      (shared context, but no direct browser MCP bridge yet)
```

The gateway owns provider credentials. Supabase sessions identify users; native
services receive scoped-to-process authentication material and bind to loopback.
The frontend never contains a provider key. Authenticated account tokens remain
sensitive and must still be protected against client-side compromise.

## Fixes delivered

| Area | Important problems addressed | Result |
|---|---|---|
| Chat | Early idle state, unreliable cancellation, errors entering history, filename-only attachments | Streaming remains busy to completion, reliable Stop/retry, actual validated text content in requests |
| Accounts | Shared local history key, auth callback handling, failures leaving forms pending | History keyed per account; account changes remount tool panels; sign-in/out errors surfaced |
| Navigation | Incomplete route mapping, lost panel state, inaccessible mobile navigation | All surfaces round-trip through URLs/Back/Forward; visited local panels retain work across navigation |
| UI | Crowded terminal/canvas layouts, clipped output, overlap-prone headings | Responsive setup/transcript/composer layouts, full Markdown, bounded scrolling and useful empty states |
| Code | Wrong async request assumptions, mixed-session events, lost approvals/questions, unsafe default project | Verified OpenCode API, session filtering, recovery, acknowledgement before resolution, explicit project, ask-by-default tools |
| Agents | Decorative cards, truncated results, ineffective cancellation | Real installed agents, selected-agent dispatch, complete results, runtime-backed Stop and reconnect |
| Browser | Displayed WebKit and agent Chrome were different browsers; fake tabs; weak cancellation | One shared Chrome session, real tabs/history/input, authenticated local MCP, serialized research and cancellation |
| Browser privacy | Temporary profile could leak into shared context; persistent profile behavior unreliable | Private research bypasses memory; private tabs unavailable to MCP; real profile persistence tested |
| Models | Unavailable providers advertised, fragile catalogue delimiters, unknown models silently routed | Configured-provider-only catalogue, validated legacy/new syntax, explicit-model errors, generic compatible-provider support |
| Compatibility | Dropped tool controls, schema/images, incomplete SSE appearing successful | Preserved tool calls/results, screenshot ordering, structured output, options and proper completion/error/usage framing |
| Memory | No user-facing management or explicit cross-tool MCP controls | Shared REST/MCP store, add/search/delete/clear/pause UI, user isolation, honest persistence status |
| Runtime safety | Arbitrary loopback bridge use, weak readiness/cleanup, redundant native browser layer | Owned-process credentials, bounded/validated routes and inputs, authenticated readiness, process-group termination; old WebKit layer removed |
| Operations | Weak request bounds, deployment/CORS drift, vulnerable web dev dependency | Body/rate/concurrency limits, timeout/cancel propagation, fixed origins/CSP, Vite security update, repeatable checks |

A real UI regression found during this pass was React reusing a Stop button as
a submit button within the same click. Stopping a response could then submit
the empty form and unexpectedly open Voice or start another task. Distinct
button identities plus `preventDefault` fix this across the affected composers.

## UI and functional behavior

The main page retains its original orb, typography, warm dark background and
composer hierarchy. Browser/Code/Agents now share that language rather than
using an unrelated terminal or draggable canvas. Navigation has a reserved
header band; mobile users can reach every surface through the workspace sheet.
Feature screens load separately instead of blocking the main entry bundle.

The final production build splits React, authentication, controls and feature
panels. The largest JavaScript chunk is approximately 215 kB uncompressed; the
application entry is approximately 68 kB. This removes the previous large-chunk
warning, but is not a claim that total transferred JavaScript fell to 68 kB.

Attachments in the chat UI deliberately support validated UTF-8 text/code files
up to 48 KiB. Unsupported images/PDFs/binary files are rejected explicitly.
The gateway supports image content for browser-agent screenshots; general chat
image/PDF upload and indexing are still separate features.

Voice uses the browser's speech recognition and synthesis capabilities. Pause
now cancels listening, model work and speech; stale completions cannot restart
it. Speech support and quality vary by browser/platform, and recognition may
use a browser vendor's online service. Native macOS microphone/voice acceptance
testing was not performed.

## Browser: what is real and what is not

The Browser panel displays an interactive screenshot preview from **real local
Chrome**, with forwarded mouse, text, key and scroll input. Its research agent
and OpenCode browser MCP act on the same session, tabs and cookies. It supports
normal browsing without any model token, plus authenticated research on demand.

It is not a native embedded Chromium engine. For full accessibility, complex
selection/shortcuts, media, downloads and browser fidelity, the “Open browser
window” action opens that same Chrome session. A first-class native Chromium
embedding and complete download/permission manager remain product work, not a
completed feature disguised by the preview.

Browser MCP provides nine tools: tabs, snapshot, screenshot, open/select/close
tab, navigation, history and input. No arbitrary JavaScript or filesystem URL
tool is exposed. Untrusted page content is labelled. While research controls
Chrome, concurrent user/MCP mutations are rejected to prevent conflicting
actions. This lock does not provide a full human approval queue for every
website-side effect.

Start Browser before connecting Code. Reconnect Code after a browser restart
to obtain the refreshed MCP endpoint/credential. OpenClaw receives gateway
memory context but has no verified direct shared-browser MCP bridge yet.

## Shared memory and MCP

Chat, voice, coding, task requests, browser summaries and explicit workspace
notes share the authenticated user's store. Automatic excerpts are short and
bounded; explicit notes are limited to 4,000 characters. Context is labelled
historical material, not trusted instructions. Users can pause recall/recording
and inspect or delete notes; private browser research skips both recall and
recording and cannot explicitly save its result.

Supabase persistence requires both SQL migrations. The local fallback is
ephemeral, limited to 200 entries per user and 1,000 users, and clearly labelled
in the UI. Recall covers 30 days; database retention needs a scheduled physical
deletion policy. This is recent context with substring search, not semantic
long-term knowledge, a full transcript archive or project-scoped memory.

Gateway MCP implements stateless Streamable HTTP with preconfigured bearer
authentication, protocol negotiation and strict validation. Tools are
`memory_search`, `memory_remember`, `memory_forget`, and `models_list`. It does
not claim OAuth discovery, consent, sampling, resources or server task support.

## Verification evidence

| Check | Result and boundary |
|---|---|
| Web unit/regression suite | 34 passed |
| Gateway unit/protocol suite | 51 passed |
| Browser service boundary tests | 9 passed |
| Native Rust tests | 3 passed |
| TypeScript and production web build | Passed; no oversized-chunk warning |
| macOS application bundle | Local release `.app` built successfully; not installed or notarized |
| Production web UI | 53 checks: 49 layout cases plus four workflow groups; no uncaught page errors |
| Code/Agents native-bridge UI simulation | Four workflow groups passed, including permission/question retries and cancellation |
| Browser native-bridge UI simulation | Eight flow/layout groups passed, including research, private mode and saved context |
| Real installed OpenCode | Real local process → gateway → MCP memory tool → final answer; model was an offline fixture |
| Real browser-use client | Real client preserved screenshot/schema/token-limit contracts through the gateway; provider was a fixture |
| Real installed Chrome | Tabs, state-preserving selection, input, history, reload, screenshots, MCP, private isolation and profile persistence passed using local pages |
| Dependency advisories | Web full npm audit and gateway production npm audit: zero reported vulnerabilities at check time |
| Continuous integration | Five-job workflow added and syntax-validated; hosted execution requires pushing the changes |

Layouts cover `/`, `/chat`, `/cli`, `/tasks`, `/browse`, `/connections` and
`/login` at 1440×1000, 1280×860, 1000×700, 768×700, 390×844, 360×640 and 844×390.
Tests wait for the actual lazy-loaded surface before measuring. Layout checks
cover horizontal overflow and header/heading collisions; screenshots were also
visually inspected. They are not exhaustive proof of every content length,
device, keyboard/screen-reader flow or website interaction.

Screenshots and machine-readable results are generated under
`apps/web/artifacts/{ui-qa,agent-ui-qa,browser-ui-qa}` and intentionally ignored
by Git. Run commands are in the root README. No test in this pass needed live
provider billing or production database access.

## Release gates

1. **Live credentials and deployment:** verify each selected provider/model
   with authorized paid contract tests; deploy HTTPS; apply both SQL migrations;
   test real login, refresh, tenant isolation, deletion and outage handling.
   Health currently reports configuration, not paid account entitlement.
2. **Distribution:** sign/notarize macOS artifacts; verify Intel/universal and
   any other intended platforms; define runtime installers/upgrades for Chrome,
   Python, OpenCode and OpenClaw. The current local app does not bundle them.
3. **Agent containment and approvals:** Code asks before consequential tools,
   but selected project scope is not OS sandboxing. Browser research and task
   tools need a consistent human-approval/audit policy before untrusted general
   autonomous use. Task Stop shuts down the whole OpenClaw runtime; task results
   survive navigation, not app restarts.
4. **Complete the shared-browser vision:** add a verified task-runtime MCP
   bridge and a renewable local tool credential proxy, eliminating manual Code
   reconnects; decide whether a true Chromium embed is required. Hosted web
   currently has no remote execution/browser companion.
5. **Operational safety:** durable usage ledger and hard dollar budgets,
   distributed limits, traces/alerts, load/soak tests, incident runbooks, backups
   and restore drills. Current limits are per-instance, not spend guarantees.
6. **Long-running credentials:** tokens refresh before new local work;
   expiration during a long run can still fail the next provider/MCP request.
   Use a revocable, short-lived agent credential/refresh proxy before unattended
   work across long sessions.
7. **Product acceptance:** live voice testing, keyboard/screen-reader audit,
   large-content/zoom tests, arbitrary-site browser testing and extended native
   lifecycle tests. Confirm commercial rights to the supplied orb assets before
   public distribution; the existing desktop README flags this as unresolved.
8. **Security hardening:** narrow the desktop HTTPS/WSS CSP to deployment
   origins, redact sensitive error telemetry, review memory ingestion against
   prompt injection, and commission an independent security review. The current
   browser preview keeps remote pages out of desktop IPC capabilities.

Account switches close active local runtimes before allowing the next account
to mount its panels. The persistent Chrome profile and installed runtime data
still belong to the operating-system user, not separate Aira account vaults.
Do not treat switching Aira accounts on the same OS login as browser-cookie or
local-project isolation; separate encrypted account profiles are further work.

## Recommended additions, in priority order

These are recommendations, not features silently marked implemented.

1. **Model capability registry and evaluation harness.** Track tool calling,
   image/schema support, context, latency, cost and account entitlement. Select
   chat/coding/research defaults by measured task quality rather than a single
   “best” model. OpenRouter publishes a catalogue with supported parameters;
   ingest and review it instead of hardcoding marketing rankings.
   [OpenRouter model catalogue](https://openrouter.ai/docs/guides/overview/models)
2. **Grok and broader provider coverage.** The generic compatible adapter can
   accept an operator-configured xAI endpoint/key/catalogue; Gemini is already
   wired through its documented compatibility endpoint. Native vendor research
   tools/Responses APIs need dedicated adapters, not an assumption that Chat
   Completions exposes every feature. No unconfigured provider is activated.
   [xAI API reference](https://docs.x.ai/developers/rest-api-reference/inference),
   [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai)
3. **Project knowledge with sources.** Add document/PDF ingestion, embeddings,
   project-level access controls, provenance, retention and citations. Supabase
   pgvector can store embeddings and support vector similarity while retaining
   the existing relational store. Do not replace explicit user controls with
   indiscriminate automatic memory.
   [Supabase pgvector](https://supabase.com/docs/guides/database/extensions/pgvector)
4. **A durable agent job system.** Persist tasks, checkpoints, approvals,
   cancellation, retries and outputs; resume only with idempotency guards.
   Include per-run budgets and a visible action timeline before adding more
   autonomous agents.
5. **A permissioned connector catalogue.** Add GitHub/repository, calendar,
   document and issue-tracker tools through audited MCP connectors with OAuth,
   least privilege, revocation and per-action approval. Tool availability must
   reflect a tested connection, never a decorative “connected” badge.
6. **Unified observability and spend controls.** Correlate UI, gateway and local
   runtime failures with one trace/run id; collect metrics, logs and traces in a
   monitored backend. OpenTelemetry supplies instrumentation and collection,
   not the storage/dashboard by itself.
   [OpenTelemetry](https://opentelemetry.io/docs/what-is-opentelemetry/)
7. **Native-quality browser and voice.** Complete browser download/permissions,
   accessibility and embedding; add a consistent authenticated speech pipeline
   with clear privacy/cost controls and measurable latency.

The strongest next investment is finishing the release gates and durable task
control, then adding providers/connectors behind verified capability contracts.
More models alone will not make an unreliable workflow production-ready.
