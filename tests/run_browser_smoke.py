#!/usr/bin/env python3
"""Run the Playwright smoke test.

Modes:
  default            serve frontend/ locally (or this directory, when there is no frontend/)
  SMOKE_SITE=<dir>   serve an assembled deploy directory as-is
  SMOKE_BASE=<url>   test a live URL directly
"""
from __future__ import annotations

import functools
import http.server
import os
import subprocess
import threading
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run_node(base: str) -> None:
    env = os.environ.copy()
    env["SMOKE_BASE"] = base
    subprocess.run(["node", str(PROJECT / "tests" / "browser_smoke.js")], check=True, timeout=180, env=env)


def main() -> int:
    if os.environ.get("SMOKE_BASE"):
        run_node(os.environ["SMOKE_BASE"])
        return 0
    default = PROJECT / "frontend" if (PROJECT / "frontend").is_dir() else PROJECT
    site = Path(os.environ.get("SMOKE_SITE") or default)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=site))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run_node(f"http://127.0.0.1:{server.server_port}/")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
