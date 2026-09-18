# Aira

One React workspace for the web and a Tauri desktop shell, with a server-side
model gateway and supervised local coding, task-agent, and Chrome runtimes.

The current implementation and release boundaries are documented in
[the production-readiness report](docs/production-readiness-report.md).
This is the active application. `askdeepakai-front-end/` is an older visual
reference with simulated behavior, not a second production frontend.

## Repository

| Directory | Responsibility |
|---|---|
| `apps/web` | Main UI, chat/voice, model picker, Code/Agents/Browser, account memory |
| `apps/desktop` | Tauri window (macOS), local-runtime lifecycle, restricted native bridge |
| `apps/desktop-windows` | Tauri window (Windows), local-runtime lifecycle, restricted native bridge |
| `services/gateway` | Auth, model routing/adapters, usage events, shared memory, MCP |
| `services/browser` | Dedicated Chrome session, research, local browser MCP |
| `askdeepakai-front-end`| Older visual reference front-end demo with simulated behavior |

## Local setup

Use Node.js 24 LTS. Desktop development also needs Rust and the platform's
native build tools. Install the separate package dependencies:

```sh
npm --prefix apps/web ci
npm --prefix services/gateway ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop-windows ci
```

Create local environment files using `apps/web/.env.example` and
`services/gateway/.env.example`. Keep provider keys and the Supabase service-role
key **only** in the gateway. The web environment contains the public Supabase
project settings and gateway URL, never provider credentials.

Run in separate terminals:

```sh
npm --prefix services/gateway run dev
npm --prefix apps/web run dev
```

Web development uses `http://127.0.0.1:5180`. For the desktop, stop that web dev
server and run `npm --prefix apps/desktop run dev` (or `apps/desktop-windows`); Tauri starts its own copy.
Its port is strict so it cannot silently attach to a different frontend.

Local no-auth gateway testing requires `AIRA_REQUIRE_AUTH=false`; it is
loopback-only and uses one development identity. A production deployment needs
Supabase authentication, HTTPS, allowed web origins, configured model ids, and
both gateway SQL migrations. No deployment or database mutation is automatic.

For Code and Agents, install the supported OpenCode/OpenClaw executables and
use their panels to connect. Code requires an explicit project directory.
For Chrome/Python installation and browser controls, see
[browser setup](services/browser/README.md). Start Browser **before** connecting
Code; reconnect Code after a browser restart to refresh its MCP connection.
These local runtimes are desktop-only; the website cannot execute tools on
someone's computer without a separately authorized companion.

## Verification

```sh
npm --prefix apps/web test
npm --prefix apps/web run build
npm --prefix services/gateway test
npm --prefix services/gateway run typecheck
python3 -m unittest discover -s services/browser -p 'test_*.py'
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

UI tests need Playwright Chromium (`npx playwright install chromium` from
`apps/web`). Start a production preview at port 5192, then run the layout and
chat/memory checks from `apps/web`:

```sh
npm run preview -- --host 127.0.0.1 --port 5192 --strictPort
# In another terminal, also inside apps/web:
AIRA_TEST_URL=http://127.0.0.1:5192 npm run test:ui
```

The native-bridge simulations require a Vite development server at port 5191
because they substitute the auth module with an isolated test account:

```sh
npm run dev -- --port 5191
# In another terminal, inside apps/web:
node tests/agent-ui-smoke.mjs
node tests/browser-ui-smoke.mjs
```

These UI tests mock services and never buy model tokens. Optional actual-client
integration commands are in [gateway documentation](services/gateway/README.md).
`services/browser/smoke.py` exercises real installed Chrome with disposable
profiles and local fixture pages, not vendor calls or the user's browser data.

## Builds and release

```sh
npm --prefix apps/web run build
npm --prefix apps/desktop run build -- --bundles app
npm --prefix apps/desktop-windows run build
```

Frontend environment settings are baked into both builds. Configure the
deployment URL before building. A local `.app` is not a signed/notarized public
release. See [desktop requirements](apps/desktop/README.md) and the
[release checklist](docs/production-readiness-report.md#release-gates).
