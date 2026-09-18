# Aira AI

Aira is a full-stack AI workspace integrating web, desktop (macOS & Windows), server-side gateway, and automated local runtimes (Chrome & Coding Agents).

It features a unified React workspace for the web and Tauri desktop shells, connecting to a server-side model gateway and supervising local coding, task-agent, and Chrome browser automation runtimes.

The current implementation and release boundaries are documented in
[the production-readiness report](docs/production-readiness-report.md).
This is the active application. `askdeepakai-front-end/` is an older visual
reference with simulated behavior, not a second production frontend.

## Architecture & Workspaces

| Directory | Responsibility |
|---|---|
| `apps/web` | Main UI, chat/voice, model picker, Code/Agents/Browser, account memory |
| `apps/desktop` | Tauri window (macOS), local-runtime lifecycle, restricted native bridge |
| `apps/desktop-windows` | Tauri window (Windows), local-runtime lifecycle, restricted native bridge |
| `services/gateway` | Auth, model routing/adapters, usage events, shared memory, MCP |
| `services/browser` | Dedicated Chrome session, research, local browser MCP |
| `askdeepakai-front-end`| Older visual reference front-end demo with simulated behavior |

## Features

- **Unified React Frontend**: A single, responsive React 19 + TypeScript frontend handling Chat, Voice, Model selection, Code, Agents, Browser, and Account memory.
- **Cross-Platform Native Shells**: Tauri-based shells for macOS (`apps/desktop`) and Windows (`apps/desktop-windows`), which run the exact same web view with restricted native capabilities, supervising local tools and runtime processes.
- **Secure Server-side Gateway**: A robust gateway (`services/gateway`) owning provider API keys (OpenAI, Anthropic, Gemini, etc.), routing traffic by tier (frontier, fast, balanced), and providing shared memory powered by Supabase.
- **Shared Memory & MCP**: Automatic and explicit cross-tool memory shared via the authenticated Model Context Protocol (MCP). Notes, context, and configurations are securely stored per user.
- **Supervised Browser Automation**: Real Chrome orchestration via a Python-based browser service (`services/browser`), supporting localized agents and research runtimes.
- **Agent Integration**: Direct connections with OpenCode (coding workflows) and OpenClaw (task management) executing safely as native desktop supervisors.

## Getting Started

### Local Development Requirements

- **Node.js 24 LTS**
- **Rust** (for desktop builds) and native platform build tools (Xcode CLI or Visual Studio Build Tools).
- For local browser agents: **Python 3.11+** and **Chrome/Chromium**.

### Installation

Install dependencies across the monorepo workspaces:

```sh
npm --prefix apps/web ci
npm --prefix services/gateway ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop-windows ci
```

### Environment Configuration

Create local environment files:
- `apps/web/.env.example` -> `apps/web/.env`
- `services/gateway/.env.example` -> `services/gateway/.env`

> **Security Note:** Provider keys and the Supabase service-role key must remain **only** in the gateway. The web environment only holds public project settings.

### Running the Services

Run the web frontend and gateway in separate terminals:

```sh
npm --prefix services/gateway run dev
npm --prefix apps/web run dev
```

Web development is served at `http://127.0.0.1:5180`. 

**For Desktop Apps:** 
Stop the web dev server and run the Tauri dev environment for your OS (it starts its own web copy):
```sh
npm --prefix apps/desktop run dev
# OR for Windows:
npm --prefix apps/desktop-windows run dev
```

### Local Agents & Browser Runtime
To enable the Coding and Browser automation features, follow the [Browser Service Setup](services/browser/README.md). Start the Browser service **before** connecting Code to ensure it receives its local MCP connection.

## Verification & Testing

The repository maintains an extensive test suite across services:

```sh
# Web
npm --prefix apps/web test
npm --prefix apps/web run build
# (Run in another terminal alongside preview server at 5192)
AIRA_TEST_URL=http://127.0.0.1:5192 npm --prefix apps/web run test:ui

# Gateway
npm --prefix services/gateway test
npm --prefix services/gateway run typecheck

# Browser service
python3 -m unittest discover -s services/browser -p 'test_*.py'

# Desktop (macOS)
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

*(See `services/gateway/README.md` and `services/browser/README.md` for specific integration tests.)*

## Builds & Release

Build the frontend and packaged native desktop binaries:

```sh
npm --prefix apps/web run build
npm --prefix apps/desktop run build -- --bundles app
npm --prefix apps/desktop-windows run build
```

Configure `VITE_GATEWAY_URL` prior to building. The output will land in `src-tauri/target/release/bundle/`. 
> Note: Local desktop builds are ad-hoc signed and will require a developer certificate for public release. See the [Release checklist](docs/production-readiness-report.md#release-gates).
