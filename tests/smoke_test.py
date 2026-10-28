# -*- coding: utf-8 -*-
"""Smoke test: static files, JS/Python syntax, and a live server round-trip.

Run (from the repo root):
    python tests/smoke_test.py

No network is used: the server is started with --no-build and only the static
page + /api/status are requested.
"""
from __future__ import annotations

import json
import socketserver
import subprocess
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def check_syntax() -> None:
    for py in ["serve.py", "fetch_sse.py", "fetch_futures.py", "build_data.py", "build_futures.py"]:
        try:
            compile((ROOT / py).read_text(encoding="utf-8"), py, "exec")
            ok = True
        except SyntaxError as exc:  # noqa: BLE001
            ok = False
            print("   ", exc)
        check(f"python syntax: {py}", ok)

    node = None
    for cand in ("node", "node.exe"):
        try:
            subprocess.run([cand, "--version"], capture_output=True, timeout=10)
            node = cand
            break
        except Exception:  # noqa: BLE001
            continue
    if node is None:
        print("SKIP  node --check (node not found)")
        return
    for js in ["assets/app.js", "assets/mock-data.js"]:
        r = subprocess.run([node, "--check", str(ROOT / js)], capture_output=True, timeout=60)
        check(f"node --check: {js}", r.returncode == 0, r.stderr.decode("utf-8", "replace")[-200:])


def check_static() -> None:
    required = [
        "index.html", "serve.py", "fetch_sse.py", "fetch_futures.py",
        "build_data.py", "build_futures.py", "requirements.txt",
        "assets/app.js", "assets/style.css", "assets/mock-data.js",
        "vendor/echarts.min.js", "vendor/fonts/NotoSansSC-400.woff2",
        "vendor/fonts/NotoSansSC-700.woff2", "data/seed_calendar.csv",
        "docs/UI_SPEC.md", "DATA_CONTRACT.md", "README.md", "LICENSE",
    ]
    for rel in required:
        check(f"file exists: {rel}", (ROOT / rel).is_file())

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for ref in ["assets/style.css", "assets/app.js", "vendor/echarts.min.js",
                "pcrMatrix", "pcrMatrixDate"]:
        check(f"index.html contains {ref}", ref in html)
    appjs = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")
    check("app.js loads mock-data.js dynamically", "assets/mock-data.js" in appjs)


def check_server() -> None:
    sys.path.insert(0, str(ROOT))
    try:
        import serve  # noqa: PLC0415

        with socketserver.TCPServer(("127.0.0.1", 0), socketserver.BaseRequestHandler) as probe:
            port = probe.server_address[1]
        server = ThreadingHTTPServer(("127.0.0.1", port), serve.Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{port}"
            for path in ["/", "/assets/app.js", "/api/status"]:
                with urllib.request.urlopen(base + path, timeout=10) as resp:
                    body = resp.read()
                    check(f"GET {path} 200", resp.status == 200 and len(body) > 100)
            with urllib.request.urlopen(base + "/api/status", timeout=10) as resp:
                obj = json.loads(resp.read().decode("utf-8"))
            check("/api/status has keys", isinstance(obj, dict) and "exists" in obj and "building" in obj)
        finally:
            server.shutdown()
            server.server_close()
    except Exception as exc:  # noqa: BLE001
        check("live server round-trip", False, f"{type(exc).__name__}: {exc}")


def main() -> int:
    check_static()
    check_syntax()
    check_server()
    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} check(s)")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
