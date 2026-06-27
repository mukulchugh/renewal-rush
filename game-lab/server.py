#!/usr/bin/env python3
"""Local Game Lab server — serves UI and stores your notes for agent collaboration."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
NOTES_FILE = DATA / "user-notes.json"


def load_notes() -> list:
    if NOTES_FILE.exists():
        return json.loads(NOTES_FILE.read_text())
    return []


def save_notes(notes: list) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    NOTES_FILE.write_text(json.dumps(notes, indent=2))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        if args and "200" in str(args[1]):
            return
        super().log_message(format, *args)

    def do_GET(self):
        if urlparse(self.path).path == "/api/notes":
            self._json_response(load_notes())
            return
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/notes":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode() or "{}")
            text = (body.get("text") or "").strip()
            if not text:
                self._json_response({"ok": False, "error": "empty"}, status=400)
                return
            notes = load_notes()
            notes.append(
                {
                    "time": datetime.now(timezone.utc).isoformat(),
                    "text": text,
                }
            )
            save_notes(notes)
            self._json_response({"ok": True, "count": len(notes)})
            return
        self.send_error(404)

    def _json_response(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    port = 3847
    print(f"Game Lab → http://127.0.0.1:{port}")
    print("Leave this running while you learn and build.")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()