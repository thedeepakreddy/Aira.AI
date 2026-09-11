"""Opt-in real Chrome smoke: local fixture pages, disposable profile, no LLM."""
from __future__ import annotations
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        html = f'''<!doctype html><title>Aira fixture {self.path}</title>
        <h1>Aira browser fixture {self.path}</h1>
        <input aria-label="Test input" style="position:absolute;left:30px;top:100px;width:250px;height:35px" oninput="document.querySelector('#typed').textContent=this.value;localStorage.setItem('typed',this.value)">
        <p id="typed" style="position:absolute;top:150px">Waiting for input</p>
        <script>document.querySelector('#typed').textContent=localStorage.getItem('typed')||'Waiting for input'</script>'''.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)
    def log_message(self, *_):
        pass


def main():
    fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    # Reserve a port immediately before launching the isolated service.
    probe = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    port = probe.server_port
    probe.server_close()
    token = str(uuid.uuid4())
    url = f"http://127.0.0.1:{fixture.server_port}"
    with tempfile.TemporaryDirectory(prefix="aira-browser-smoke-") as temp:
        env = {**os.environ, "AIRA_BROWSER_PORT": str(port), "AIRA_BROWSER_TOKEN": token,
               "AIRA_BROWSER_PROFILE": str(Path(temp) / "profile"), "AIRA_BROWSER_HEADLESS": "1",
               "AIRA_BROWSER_MODEL": "", "AIRA_TOKEN": "", "ANONYMIZED_TELEMETRY": "false"}
        log = tempfile.TemporaryFile(mode="w+")
        child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("server.py"))], env=env, stdout=log, stderr=log)
        def request(path, body=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=130)
            connection.request("POST" if body is not None else "GET", path, json.dumps(body) if body is not None else None,
                               {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            response = connection.getresponse()
            data = json.loads(response.read())
            connection.close()
            if response.status != 200:
                raise AssertionError(f"{path}: HTTP {response.status}: {data}")
            return data
        def rpc(method, params=None):
            return request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})["result"]
        try:
            for _ in range(150):
                try:
                    if request("/health")["ready"]:
                        break
                except (ConnectionError, OSError):
                    pass
                time.sleep(.2)
            else:
                raise AssertionError("Service never became ready")
            assert rpc("initialize", {"protocolVersion": "2025-06-18"})["serverInfo"]["name"] == "aira-shared-browser"
            assert len(rpc("tools/list")["tools"]) == 9
            first = request("/tabs/open", {"url": url + "/one"})
            tab_one = next(t["id"] for t in first["tabs"] if t["url"].endswith("/one"))
            request("/input", {"type": "click", "x": 80, "y": 115})
            request("/input", {"type": "text", "text": "Shared Chrome input works"})
            snap = rpc("tools/call", {"name": "browser_snapshot", "arguments": {}})
            assert not snap["isError"] and "Shared Chrome input works" in snap["content"][0]["text"], snap
            shot = request("/screen")
            assert shot["image"].startswith("data:image/jpeg;base64,") and len(shot["image"]) > 1000
            mcp_shot = rpc("tools/call", {"name": "browser_screenshot", "arguments": {}})
            assert mcp_shot["content"][0]["mimeType"] == "image/jpeg"
            second = request("/tabs/open", {"url": url + "/two"})
            tab_two = next(t["id"] for t in second["tabs"] if t["url"].endswith("/two"))
            request("/tabs/select", {"id": tab_one})
            snap = rpc("tools/call", {"name": "browser_snapshot", "arguments": {}})
            assert "Shared Chrome input works" in snap["content"][0]["text"], "Switching tabs lost page state"
            request("/navigate", {"url": url + "/three"})
            request("/history", {"action": "back"})
            time.sleep(.5)
            assert request("/screen")["url"].endswith("/one")
            request("/history", {"action": "forward"})
            time.sleep(.5)
            assert request("/screen")["url"].endswith("/three")
            request("/history", {"action": "reload"})
            closed = request("/tabs/close", {"id": tab_two})
            assert tab_two not in [t["id"] for t in closed["tabs"]]
            request("/mode", {"private": True})
            request("/tabs/open", {"url": url + "/private"})
            blocked = rpc("tools/call", {"name": "browser_snapshot", "arguments": {}})
            assert blocked["isError"]
            request("/mode", {"private": False})
            request("/tabs/open", {"url": url + "/restored"})
            restored = rpc("tools/call", {"name": "browser_snapshot", "arguments": {}})
            assert "Shared Chrome input works" in restored["content"][0]["text"], "Saved profile lost its persistent local storage"
            print("PASS: authenticated readiness, MCP initialize/list/snapshot/screenshot, real tabs, selection preserves input, navigation, history, reload, screenshot, close, private isolation, persistent profile")
        except BaseException:
            log.seek(0)
            print(log.read()[-6000:], file=sys.stderr)
            raise
        finally:
            child.terminate()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            log.close()
            fixture.shutdown()
            fixture.server_close()


if __name__ == "__main__":
    main()
