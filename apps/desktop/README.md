# Aira Desktop (macOS)

Tauri shell around the same single-page app the web build serves. One frontend,
two shells — the only divergence is which origin it runs from.

## Credential boundary

No provider API keys are embedded in the app. A packaged `.app` is a folder
anyone can inspect. The shell holds short-lived session credentials in memory
and supervises local runtime processes; provider keys remain in the gateway.

## Prerequisites

- Xcode Command Line Tools (`xcode-select --install`)
- Rust (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- For universal builds: `rustup target add x86_64-apple-darwin`

## Commands

```sh
npm run dev              # dev shell against the Vite dev server
npm run build            # .app + .dmg for this machine's architecture
npm run build:universal  # Intel + Apple Silicon
npm run icons            # regenerate the icon set from icon-source.png
```

Output lands in `src-tauri/target/**/release/bundle/`.

Local macOS builds use Tauri's ad-hoc signing identity (`-`) so the complete
application bundle receives a valid local signature. Release pipelines should
provide `APPLE_SIGNING_IDENTITY` with a Developer ID identity and configure
notarization. Check bundle integrity with `codesign --verify --deep --strict`
against the built `.app`; this does not substitute for notarization.

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
approval. Task-agent state uses Aira's own workspace directory. Stopping a
task-agent run stops that runtime because its HTTP API has no verified per-run
abort. All supervised process groups terminate when Aira exits.

## CORS

The packaged app serves from `tauri://localhost`, not from a web origin. The
gateway allows that origin unconditionally (see `services/gateway/src/env.ts`),
because otherwise the dev server works while the bundled app is silently
blocked — a failure that only appears after packaging.

## Not yet done before release

- **Signing and notarization.** Ad-hoc builds are not ready for public
  distribution and can be blocked by Gatekeeper on other machines. Needs an Apple Developer account, a
  Developer ID Application certificate, and notarization.
- **The orb** (`orb.mp4` / `orb.jpg`) is not cleared for commercial use.
