# Aira Desktop (Windows)

Tauri shell around the same single-page app the web build serves. One frontend,
two shells — the only divergence is which origin it runs from.

## Credential boundary

No provider API keys are embedded in the app. A packaged installer can be extracted
and inspected by anyone. The shell holds short-lived session credentials in memory
and supervises local runtime processes; provider keys remain in the gateway.

## Prerequisites

- Visual Studio C++ Build Tools (or the full Visual Studio IDE with C++ workload)
- Rust (`rustup-init.exe`)
- WebView2 Runtime (usually pre-installed on Windows 11)

## Commands

```sh
npm run dev              # dev shell against the Vite dev server
npm run build            # .msi + .nsis for this machine's architecture
npm run build:windows    # explicit Windows build
npm run icons            # regenerate the icon set from icon-source.png
```

Output lands in `src-tauri/target/release/bundle/`.

## The gateway URL is baked in at build time

`VITE_GATEWAY_URL` is compiled into the frontend, so a build points at whatever
that variable said. A release build must be made with the production gateway
URL, not `http://localhost:8787`, or the shipped app will try to reach a machine
the user does not have.

The desktop CSP permits HTTPS and secure WebSocket connections so a configured
production gateway works outside Supabase's domain. A deployment with a fixed
gateway can replace `https:` and `wss:` in `app.security.csp.connect-src` with
its exact origins. Remote web pages receive no desktop IPC capabilities.
Plain HTTP remains limited to loopback for development and local runtimes.

## Local runtimes

See `services/browser/README.md` for the pinned, isolated browser runtime.
The Browser panel and Coding's browser MCP share Chrome; the old native WebKit
surface has been retired so it cannot cover dialogs or other panels. Coding
requires an explicitly selected project folder, and unknown tools ask for
approval. Task-agent state uses Aira's own workspace directory (under `%APPDATA%\Aira`).
Stopping a task-agent run stops that runtime because its HTTP API has no verified per-run
abort. All supervised process trees terminate when Aira exits via Windows `taskkill`.

## CORS

The packaged app serves from `http://tauri.localhost` (or similar custom scheme),
not from a standard web origin. The gateway allows Tauri origins unconditionally
(see `services/gateway/src/env.ts`), because otherwise the dev server works while
the bundled app is silently blocked — a failure that only appears after packaging.

## Not yet done before release

- **Code Signing.** Unsigned Windows binaries will trigger Microsoft Defender SmartScreen
  warnings. Needs a code signing certificate (e.g., from an EV CA) configured in the Tauri pipeline.
- **The orb** (`orb.mp4` / `orb.jpg`) is not cleared for commercial use.
