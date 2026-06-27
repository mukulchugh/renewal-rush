#!/usr/bin/env python3
"""Minimal Unreal MCP HTTP client (streamable HTTP + session ID)."""

from __future__ import annotations

import json
import time
import http.client
from typing import Any


class UnrealMCP:
    def __init__(self, host: str = "127.0.0.1", port: int = 8000, path: str = "/mcp"):
        self.host = host
        self.port = port
        self.path = path
        self.session: str | None = None
        self._req_id = 0

    def _post(self, body: dict[str, Any], timeout: float = 180.0) -> tuple[int, str]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session:
            headers["mcp-session-id"] = self.session

        conn.request("POST", self.path, json.dumps(body), headers)
        resp = conn.getresponse()
        if not self.session:
            self.session = resp.getheader("mcp-session-id") or resp.getheader("Mcp-Session-Id")

        chunks: list[bytes] = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = resp.read(16384)
            if chunk:
                chunks.append(chunk)
            elif chunks:
                break
            else:
                time.sleep(0.05)
        conn.close()
        return resp.status, b"".join(chunks).decode(errors="replace")

    @staticmethod
    def _parse_sse(raw: str) -> dict[str, Any] | None:
        if not raw.strip():
            return None
        for line in raw.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:])
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}

    def ensure_session(self) -> None:
        if self.session:
            return
        status, raw = self._post(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "renewal-rush-mcp", "version": "1.0"},
                },
            },
            timeout=30,
        )
        if status != 200:
            raise RuntimeError(f"MCP initialize failed: {status} {raw}")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=10)

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None, timeout: float = 300.0) -> dict[str, Any]:
        self.ensure_session()
        self._req_id += 1
        status, raw = self._post(
            {
                "jsonrpc": "2.0",
                "id": self._req_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
            timeout=timeout,
        )
        if status not in (200, 202):
            raise RuntimeError(f"tools/call {name} HTTP {status}: {raw}")
        parsed = self._parse_sse(raw)
        if not parsed:
            raise RuntimeError(f"tools/call {name} returned empty body")
        if "error" in parsed:
            raise RuntimeError(f"MCP error: {parsed['error']}")
        return parsed.get("result", parsed)

    def call_toolset(self, tool_name: str, arguments: dict[str, Any] | None = None, toolset_name: str | None = None, timeout: float = 300.0) -> str:
        payload: dict[str, Any] = {"tool_name": tool_name, "arguments": arguments or {}}
        if toolset_name:
            payload["toolset_name"] = toolset_name
        result = self.call_tool("call_tool", payload, timeout=timeout)
        content = result.get("content", [])
        if not content:
            return json.dumps(result)
        texts = [c.get("text", "") for c in content if isinstance(c, dict)]
        return "\n".join(texts) if texts else json.dumps(result)

    def list_toolsets(self) -> str:
        return self.call_toolset("list_toolsets")

    def describe_toolset(self, toolset_name: str) -> str:
        return self.call_toolset("describe_toolset", {"toolset_name": toolset_name})

    def execute_tool_script(self, script: str, timeout: float = 600.0) -> str:
        return self.call_toolset(
            "execute_tool_script",
            {"script": script},
            toolset_name="editor_toolset.toolsets.programmatic.ProgrammaticToolset",
            timeout=timeout,
        )


def wait_for_mcp(host: str = "127.0.0.1", port: int = 8000, seconds: float = 300.0) -> UnrealMCP:
    deadline = time.time() + seconds
    last_err = ""
    while time.time() < deadline:
        try:
            client = UnrealMCP(host, port)
            client.ensure_session()
            return client
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
            time.sleep(3)
    raise TimeoutError(f"MCP not ready after {seconds}s: {last_err}")