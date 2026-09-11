# Aira shared browser runtime

Aira Desktop supervises a loopback-only Python service and a dedicated Chrome
profile. Its interactive page preview, research runner and local MCP clients
share **one Chrome session**, including tabs, cookies and navigation history.
The preview forwards clicks, text, control keys and scrolling. For video,
accessibility, complex shortcuts, selection and full browser fidelity, choose
**Open browser window**. The preview is not an embedded native Chromium engine.
The previous native WebKit view is no longer used by the Browser panel.

## Install once

Python 3.11 or newer and Chrome/Chromium are required. Create an isolated
environment; do not install into the system Python:

```sh
python3 -m venv "$HOME/.aira/browser/venv"
"$HOME/.aira/browser/venv/bin/python" -m pip install -r services/browser/requirements.txt
```

Alternatively set `AIRA_BROWSER_PYTHON` to an existing virtual environment's
absolute Python path before launching Aira. `AIRA_BROWSER_PROFILE` overrides
the dedicated profile directory; Aira never imports the user's Chrome profile.
`AIRA_BROWSER_EXECUTABLE` selects an installed Chrome/Chromium executable.
The service script is bundled into the desktop application. Development
resolves it relative to the Rust crate, independent of the launch directory.
If Chrome is not installed, install a supported Chrome/Chromium build before
connecting. Aira does not download or install runtimes without a user action.

The persistent profile belongs to the operating-system user, not a separate
Aira account. Switching Aira accounts stops the previous runtime and clears its
model session credentials; it does not erase website logins or browsing data
from that OS-level profile. Use a temporary profile when those should not
persist. Navigating between Aira panels keeps the current browser session open.

Ordinary browsing does not require a provider key or model. Research obtains
the signed-in session token and configured task model immediately before each
run. The gateway meters these requests under the task surface. Switching to a
temporary profile closes existing tabs; it is not an anonymity guarantee.
Unpacked extension directories are not silently loaded.
Research in temporary profiles sends `X-Aira-Memory: off` so the gateway skips
shared recall and automatic storage. Saving results is disabled for these runs,
and MCP clients cannot read or control temporary-profile tabs.

## Shared tools

The authenticated `POST /mcp` endpoint implements stateless JSON-RPC initialize,
ping, tools/list and tools/call with JSON responses. Browser-origin requests
are rejected; only local clients with the supervisor's fresh bearer credential
can control it. The supervisor keeps this credential in memory.

Tools: `browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_open_tab`,
`browser_navigate`, `browser_select_tab`, `browser_close_tab`,
`browser_history`, `browser_input`. Snapshots explicitly label page text as
untrusted. Tools never accept arbitrary JavaScript or filesystem URLs.

Start the Browser before connecting Coding so the coding runtime receives its
MCP connection. If Browser is restarted, reconnect Coding to refresh the local
credential. Coding also receives Aira's authenticated gateway memory MCP. Tool
calls are subject to coding permissions. OpenClaw's separate task runtime does
not yet have a verified direct MCP bridge; do not claim it shares browser tools.
Hosted web gateways cannot reach a desktop's loopback browser directly.

Research is serialized and capped at 12 steps by default (maximum 50 from
configuration). While research controls Chrome, panel and MCP mutations are
rejected. Stop cancels the server coroutine; leaving the Browser panel pauses
previews but keeps the runtime and current run alive. Closing Aira terminates
the supervised process groups, including browser and shell descendants.

## Verification

```sh
python3 -m unittest discover -s services/browser -p 'test_*.py'
```

The tests use a temporary loopback server and no real browsing or paid models.
Live checks require the installed runtime and should use a disposable profile
and local fixture pages. Signing, notarization and runtime distribution remain
separate release requirements.
