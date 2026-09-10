# AskDeepakAI — mobile and desktop front end

A responsive React 19 + TypeScript front-end demo derived from the orange-and-black reference. Includes chat, voice animation, browser-local chat history, a left slide-out panel, login, and a remote CLI demo.

## Start locally

Use Node.js 22.13+ and pnpm 11:

```sh
pnpm install
pnpm dev --host 0.0.0.0
```

Use the port printed by the server (normally 3000).

| View | URL |
| --- | --- |
| Desktop workspace | http://localhost:3000/desktop |
| Mobile workspace | http://localhost:3000/mobile |
| Desktop CLI | http://localhost:3000/desktop/cli |
| Mobile remote CLI | http://localhost:3000/mobile/cli |
| Desktop login | http://localhost:3000/desktop/login |
| Mobile login | http://localhost:3000/mobile/login |
| Automatically responsive | http://localhost:3000/ |

The mobile route keeps an iPhone-width canvas even on a desktop. The desktop route keeps a full workspace (minimum 1000 CSS pixels). The root route adapts to available width. On a physical iPhone on the same Wi-Fi, replace localhost with the computer's LAN address. The mobile route fills a narrow device viewport.

## Interactions

- Chat history at the top left opens a left drawer with Chat and CLI tabs.
- New chat starts a fresh conversation. Selecting a saved conversation restores it.
- Up to 30 conversations are stored in this browser; this is not an account-synced service.
- The home microphone plays the reference-derived voice demo. Pause/resume and send controls work.
- The CLI Start demo session button enables a simulated terminal. Commands: help, pwd, ls, whoami, status, history, echo, clear. Arrow keys recall commands; Tab completes supported commands.
- Login accepts a made-up email and a demo password with six or more characters. Credentials are neither sent nor stored. Only a preview session flag is kept in sessionStorage.
- Reduced motion stops animated assets and removes transitions.

## Demo scope

Login, AI replies, transcription, and remote CLI are front-end demonstrations, as requested. No real account authentication, microphone capture, remote command execution, trading, or file uploads take place. Local chat history is not protected by the demo login.

The terminal command evaluator never invokes a shell. A production version needs real authentication, authorization, and a remote execution service behind a server API; never put SSH credentials or service secrets in front-end code.

## Source

- components/askdeepakai/workspace.tsx — shared shell, chat, voice, history drawer and navigation
- components/askdeepakai/terminal.tsx — desktop/mobile CLI
- components/askdeepakai/login.tsx — login page
- lib/workspace-state.ts — history validation and simulated command responses
- app/globals.css — reference styling and container-based responsive layouts
- app/desktop and app/mobile — explicit preview routes
- public/assets/orb.mp4 and orb.jpg — motion and image extracted from the supplied reference
- tests/workspace-state.test.mjs — history and CLI tests

## Checks

```sh
pnpm exec tsc --noEmit
pnpm build
node --experimental-strip-types --test tests/workspace-state.test.mjs
```

The tests use Node.js 24 or later. They check stored-history validation, chat updates, history limits, command history, and safe simulated outputs. No browser interaction or physical-device tests have been performed. The optional feature-detected WebMCP demo action has no supported validation context here, so its browser contract remains unverified.

The orb comes from the user-supplied reference. Original assets remain owned by their respective owners. The former name and logo have been removed from the interface.

