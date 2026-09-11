"""Aira's browsing agent.

A small HTTP service around browser-use, supervised by the desktop shell the
same way OpenCode and OpenClaw are: Aira picks the port, mints the token, binds
to loopback, and kills the process on exit.

It exists as a service rather than a library call for two reasons:

  * browser-use is Python and the rest of Aira is not. A subprocess with an HTTP
    boundary is the honest seam between them.
  * Browsing is wanted by every surface, not just its own panel. A service can
    be called by the gateway on behalf of chat, voice, or either agent, where an
    in-process library could only serve whoever imported it.

The model is reached through Aira's gateway, never a vendor directly, so a
browsing run is metered and capped like every other surface.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("AIRA_BROWSER_PORT", "0"))
TOKEN = os.environ.get("AIRA_BROWSER_TOKEN", "")
GATEWAY = os.environ.get("AIRA_GATEWAY_URL", "http://localhost:8787").rstrip("/")
GATEWAY_TOKEN = os.environ.get("AIRA_TOKEN", "")
MODEL = os.environ.get("AIRA_BROWSER_MODEL", "")
# Browsing is the one surface that reads whatever a page happens to say, so it
# is capped: a runaway agent is a bill as well as a hang.
MAX_STEPS = int(os.environ.get("AIRA_BROWSER_MAX_STEPS", "12"))
# Its own Chrome profile, not the user's. See the note in `_browse`.
PROFILE_DIR = os.environ.get(
    "AIRA_BROWSER_PROFILE", os.path.expanduser("~/.aira/browser/profile")
)
HEADLESS = os.environ.get("AIRA_BROWSER_HEADLESS", "1") not in ("0", "false")


def clear_profile_lock() -> None:
    """Removes Chrome's singleton lock from Aira's own profile.

    Chrome refuses to start on a profile another instance holds, and it marks
    that with three symlinks naming a pid. If a run is orphaned — the app
    crashes, the machine sleeps, the service is killed — those survive, and
    every later run dies with "exited before CDP became available", which reads
    like a broken install rather than a stale lock.

    Safe because this profile belongs to Aira alone and one service runs at a
    time; the files are symlinks, not data.
    """
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        path = os.path.join(PROFILE_DIR, name)
        try:
            if os.path.islink(path) or os.path.exists(path):
                os.unlink(path)
                log(f"cleared a stale {name} from a previous run")
        except OSError as error:
            log(f"could not clear {name}: {error}")


def log(message: str) -> None:
    """Startup and failure detail goes to stderr, which the shell drains."""
    print(f"[browser] {message}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # noqa: D102 - quieter than the default
        pass

    # ── helpers ──────────────────────────────────────────────────────────────

    def _authorised(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _event(self, data: dict) -> None:
        self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    # ── routes ───────────────────────────────────────────────────────────────

    def do_GET(self) -> None:
        if self.path == "/health":
            # Unauthenticated on purpose: the supervisor has to be able to ask
            # whether the process is up before it has anything to authenticate.
            self._json(200, {"ok": True, "ready": READY.is_set()})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/run":
            self._json(404, {"error": "not found"})
            return
        if not self._authorised():
            self._json(401, {"error": "unauthorized"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "malformed body"})
            return

        task = (body.get("task") or "").strip()
        if not task:
            self._json(400, {"error": "`task` is required"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            asyncio.run(self._browse(task, int(body.get("maxSteps") or MAX_STEPS)))
        except Exception as error:  # noqa: BLE001 - the client needs the reason
            self._event({"type": "error", "message": str(error)[:400]})
        self._event({"type": "done"})

    async def _browse(self, task: str, max_steps: int) -> None:
        from browser_use import Agent, BrowserProfile, ChatOpenAI

        # Through Aira's gateway, never a vendor directly: that is what keeps a
        # browsing run metered, capped, and attributable like every other
        # surface. The `task` mount tags the spend as task work.
        llm = ChatOpenAI(
            model=MODEL,
            base_url=f"{GATEWAY}/openai/task/v1",
            api_key=GATEWAY_TOKEN or "aira-local",
        )

        # A separate profile, deliberately. browser-use can reuse the user's own
        # Chrome profile, which would put the agent inside every session they
        # are signed into — their mail, their bank — on a surface whose whole
        # job is to follow instructions found on web pages. Aira browses logged
        # out unless the user chooses otherwise.
        profile = BrowserProfile(
            user_data_dir=PROFILE_DIR,
            headless=HEADLESS,
            downloads_path=os.path.join(PROFILE_DIR, "downloads"),
        )

        clear_profile_lock()

        self._event({"type": "start", "task": task, "model": MODEL})
        step = 0

        async def on_step(agent) -> None:
            """Reports progress. A browse is slow and silence reads as a hang.

            Async because browser-use awaits this hook; a plain function returns
            None and the run dies on `await None` one step in.
            """
            nonlocal step
            step += 1
            try:
                state = agent.state.history
                url = state.urls()[-1] if state.urls() else ""
                action = state.model_actions()[-1] if state.model_actions() else {}
                name = next(iter(action), "") if isinstance(action, dict) else ""
            except Exception:  # noqa: BLE001 - progress must never break the run
                url, name = "", ""
            self._event({"type": "step", "n": step, "url": url, "action": name})

        agent = Agent(task=task, llm=llm, browser_profile=profile, max_actions_per_step=3)
        history = await agent.run(max_steps=max_steps, on_step_end=on_step)

        self._event(
            {
                "type": "result",
                "text": (history.final_result() or "").strip(),
                "steps": step,
                "urls": [u for u in (history.urls() or []) if u][-8:],
            }
        )


READY = threading.Event()


def main() -> None:
    if not TOKEN:
        log("refusing to start without AIRA_BROWSER_TOKEN — the service drives a real browser")
        sys.exit(2)
    if not MODEL:
        log("refusing to start without AIRA_BROWSER_MODEL")
        sys.exit(2)

    # Loopback only. This drives a browser signed into the user's sessions, so
    # it must never be reachable from off the machine.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    port = server.server_address[1]
    log(f"listening on 127.0.0.1:{port} — model {MODEL} via {GATEWAY}")

    # Importing browser-use takes seconds; announcing readiness only after it
    # lands stops the panel sending a task into a half-loaded process.
    def warm() -> None:
        try:
            import browser_use  # noqa: F401

            READY.set()
            log("browser-use loaded")
        except Exception as error:  # noqa: BLE001
            log(f"could not load browser-use: {error}")

    threading.Thread(target=warm, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
