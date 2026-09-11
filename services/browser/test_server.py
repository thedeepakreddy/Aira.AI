"""HTTP/MCP boundary regressions without Chrome, external pages or model spend."""
import asyncio
import concurrent.futures
import http.client
import json
import threading
import unittest
from unittest.mock import patch
import server


class BrowserProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.TOKEN = "test-browser-authority"
        cls.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.http.daemon_threads = True
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.loop_thread = threading.Thread(target=server.LOOP.run_forever, daemon=True)
        cls.loop_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        server.LOOP.call_soon_threadsafe(server.LOOP.stop)

    def request(self, method, path, body=None, token=server.TOKEN, origin=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=3)
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        result = response.status, json.loads(raw) if raw else None
        connection.close()
        return result

    def rpc(self, method, params=None):
        return self.request("POST", "/mcp", {"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}}, token=server.TOKEN)

    def test_health_requires_authority(self):
        self.assertEqual(self.request("GET", "/health", token="wrong")[0], 401)
        self.assertEqual(self.request("GET", "/health", token=server.TOKEN)[0], 200)

    def test_browser_origins_cannot_drive_local_service(self):
        status, _ = self.request("POST", "/mcp", {}, token=server.TOKEN, origin="https://evil.example")
        self.assertEqual(status, 401)

    def test_mcp_initialization_and_tool_schemas(self):
        status, body = self.rpc("initialize", {"protocolVersion": "2025-06-18"})
        self.assertEqual(status, 200)
        self.assertEqual(body["result"]["protocolVersion"], "2025-06-18")
        tools = self.rpc("tools/list")[1]["result"]["tools"]
        self.assertEqual(len(tools), 9)
        self.assertIn("browser_snapshot", [tool["name"] for tool in tools])
        self.assertTrue(all(t["inputSchema"]["additionalProperties"] is False for t in tools))

    def test_unknown_tools_and_invalid_input_are_errors(self):
        result = self.rpc("tools/call", {"name": "shell", "arguments": {}})[1]["result"]
        self.assertTrue(result["isError"])
        result = self.rpc("tools/call", {"name": "browser_navigate", "arguments": {"url": "https://example.com", "script": "evil"}})[1]["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(self.request("POST", "/tabs/open", ["invalid"], token=server.TOKEN)[0], 400)

    def test_mutations_are_rejected_during_research(self):
        future = concurrent.futures.Future()
        server.RUNS["active"] = future
        try:
            self.assertEqual(self.request("POST", "/navigate", {"url": "https://example.com"}, token=server.TOKEN)[0], 409)
            result = self.rpc("tools/call", {"name": "browser_close_tab", "arguments": {"id": "tab"}})[1]["result"]
            self.assertTrue(result["isError"])
            self.assertTrue(self.request("POST", "/cancel", {"run": "active"}, token=server.TOKEN)[1]["cancelled"])
            self.assertTrue(future.cancelled())
        finally:
            server.RUNS.clear()

    def test_url_boundary(self):
        for url in ("file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hello", "https://user:secret@example.com", "chrome://settings"):
            with self.assertRaises(ValueError):
                server.valid_url(url)
        self.assertEqual(server.valid_url("https://example.com"), "https://example.com")

    def test_private_tabs_are_not_exposed_to_other_agents(self):
        server.SESSION["private"] = True
        try:
            result = self.rpc("tools/call", {"name": "browser_snapshot", "arguments": {}})[1]["result"]
            self.assertTrue(result["isError"])
            self.assertIn("Temporary-profile", result["content"][0]["text"])
        finally:
            server.SESSION["private"] = False

    def test_cancel_before_run_registration_is_remembered(self):
        self.request("POST", "/cancel", {"run": "not-yet-started"}, token=server.TOKEN)
        self.assertIn("not-yet-started", server.CANCELLED)
        server.CANCELLED.clear()

    def test_timeout_cancels_underlying_coroutine(self):
        cancelled = threading.Event()
        async def wait_forever():
            try:
                await asyncio.sleep(30)
            finally:
                cancelled.set()
        with self.assertRaises(TimeoutError):
            server.run_on_loop(wait_forever(), .02)
        self.assertTrue(cancelled.wait(1))


if __name__ == "__main__":
    unittest.main()
