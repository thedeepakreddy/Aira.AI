# Automated checks

`workflows/ci.yml` checks the active web app, gateway, browser service and macOS
desktop shell on pushes and pull requests. It uses Node 24, Python 3.12 and the
locally verified Rust 1.98.1 toolchain. Dependency installs use the committed npm
and Cargo lockfiles. It does not deploy, sign releases or read provider secrets.

The UI job checks the production build at port 5192 and separately runs the
desktop bridge simulations against Vite at port 5191. All three suites intercept
external calls with test fixtures; they do not spend model tokens or drive real
local agents. Screenshots and result summaries are retained for 14 days, including
when a test fails.

To repeat the UI checks locally from `apps/web`, install dependencies and Chromium:

```sh
npm ci
npx playwright install chromium
npm run build
```

Start production preview in one terminal:

```sh
npm run preview -- --host 127.0.0.1 --port 5192 --strictPort
```

Run the production layout and workspace checks in another:

```sh
AIRA_TEST_URL=http://127.0.0.1:5192 npm run test:ui
```

For simulated desktop controls, start `npm run dev -- --port 5191` and run:

```sh
AIRA_TEST_URL=http://127.0.0.1:5191 node tests/agent-ui-smoke.mjs
AIRA_TEST_URL=http://127.0.0.1:5191 node tests/browser-ui-smoke.mjs
```

These checks do not replace signed application installation testing, real-provider
end-to-end tests, or manual assistive-technology testing. The reference demo under
`askdeepakai-front-end` is intentionally outside the active product checks.

Action release versions were checked against the official repositories for
[checkout](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0),
[setup-python](https://github.com/actions/setup-python/releases/tag/v7.0.0), and
[upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.1).
Chromium setup follows [Playwright's CI documentation](https://playwright.dev/docs/ci).
