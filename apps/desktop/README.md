# Aira Desktop (macOS)

Tauri shell around the same single-page app the web build serves. One frontend,
two shells — the only divergence is which origin it runs from.

## Why the shell holds nothing

No product logic and no credentials live here. A packaged `.app` is just a
folder anyone can open, so an embedded API key would be public. The app talks to
the Aira gateway over HTTPS; the gateway holds the provider keys.

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

## The gateway URL is baked in at build time

`VITE_GATEWAY_URL` is compiled into the frontend, so a build points at whatever
that variable said. A release build must be made with the production gateway
URL, not `http://localhost:8787`, or the shipped app will try to reach a machine
the user does not have.

## CORS

The packaged app serves from `tauri://localhost`, not from a web origin. The
gateway allows that origin unconditionally (see `services/gateway/src/env.ts`),
because otherwise the dev server works while the bundled app is silently
blocked — a failure that only appears after packaging.

## Not yet done before release

- **Signing and notarization.** Builds are ad-hoc signed, so macOS will refuse
  to open them on any other machine. Needs an Apple Developer account, a
  Developer ID Application certificate, and notarization.
- **The orb** (`orb.mp4` / `orb.jpg`) is not cleared for commercial use.
