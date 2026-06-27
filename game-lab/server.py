#!/usr/bin/env python3
"""Local Game Lab server — serves UI and stores your notes for agent collaboration."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
NOTES_FILE = DATA / "user-notes.json"
DEFAULT_PORT = 3847


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


class ReuseHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def pids_on_port(port: int) -> list[int]:
    try:
        out = subprocess.check_output(
            ["lsof", "-ti", f":{port}"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [int(pid) for pid in out.split() if pid.strip().isdigit()]


def game_lab_is_up(port: int) -> bool:
    url = f"http://127.0.0.1:{port}/renewal-rush.html"
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def stop_port_listeners(port: int) -> list[int]:
    killed: list[int] = []
    me = os.getpid()
    for pid in pids_on_port(port):
        if pid == me:
            continue
        for sig in (15, 9):
            try:
                subprocess.run(["kill", f"-{sig}", str(pid)], check=True, capture_output=True)
                killed.append(pid)
                break
            except subprocess.CalledProcessError:
                continue
    if killed:
        time.sleep(0.35)
    return list(dict.fromkeys(killed))


def free_port(port: int, attempts: int = 6) -> list[int]:
    all_killed: list[int] = []
    for _ in range(attempts):
        killed = stop_port_listeners(port)
        all_killed.extend(killed)
        if not pids_on_port(port):
            break
        time.sleep(0.15)
    return list(dict.fromkeys(all_killed))


def print_running(port: int, pid: int | None = None) -> None:
    pid_hint = f" (PID {pid})" if pid else ""
    print(f"Game Lab is already running at http://127.0.0.1:{port}{pid_hint}")
    print(f"Renewal Rush → http://127.0.0.1:{port}/renewal-rush.html")
    print("To restart: python3 server.py --restart")


def main() -> int:
    parser = argparse.ArgumentParser(description="Game Lab local server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--restart",
        action="store_true",
        help="Stop whatever is on this port, then start Game Lab",
    )
    args = parser.parse_args()
    port = args.port

    if args.restart:
        stopped = free_port(port)
        if stopped:
            print(f"Stopped previous listener(s) on :{port}: {', '.join(map(str, stopped))}")
    else:
        pids = pids_on_port(port)
        if pids and game_lab_is_up(port):
            print_running(port, pids[0])
            return 0

    try:
        httpd = ReuseHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        if exc.errno != 48:
            raise
        pids = pids_on_port(port)
        if game_lab_is_up(port):
            print_running(port, pids[0] if pids else None)
            return 0
        print(f"Port {port} is in use (PID {pids[0] if pids else '?'}) but is not Game Lab.", file=sys.stderr)
        print("Run: python3 server.py --restart", file=sys.stderr)
        return 1

    print(f"Game Lab → http://127.0.0.1:{port}")
    print("Leave this running while you learn and build.")
    print(f"Renewal Rush → http://127.0.0.1:{port}/renewal-rush.html")
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())