# -*- coding: utf-8 -*-
"""期权 PCR 看板本地服务（纯标准库，无需额外依赖）。

    python serve.py                 # 默认 http://127.0.0.1:8788，自动开浏览器
    python serve.py --port 9000 --no-open

路由
----
    GET  /                index.html
    GET  /api/data        cache/dashboard.json（前端唯一数据源）
    GET  /api/status      {exists,mtime,size_kb,building,build_seconds}
    GET  /api/buildlog    上次构建日志（失败时给前端显示原因）
    POST /api/refresh     增量抓取 + 合并 + 重算 dashboard.json（同步等待完成）
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
DASHBOARD = HERE / "cache" / "dashboard.json"
FUTURES = HERE / "cache" / "futures.json"
BUILD_LOG = HERE / "cache" / "build.log"
BUILD_SCRIPT = HERE / "build_data.py"
FETCH_FUT_SCRIPT = HERE / "fetch_futures.py"
BUILD_FUT_SCRIPT = HERE / "build_futures.py"
BUILD_TIMEOUT = 900
BUILD_STALE = 900          # 超过这个时间没结束，认为锁已死，允许接管

_STATE: dict = {"active": False, "started": 0.0, "by": ""}
_LOCK = threading.Lock()

DEFAULT_PORT = 8788


# ------------------------------------------------------------------ 工具
def _now() -> float:
    return time.time()


def _json_bytes(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _read_build_log(limit: int = 6000) -> str:
    try:
        txt = BUILD_LOG.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return txt[-limit:]


def _explain(log: str) -> str:
    """把构建日志里的异常压成一句人能看懂的中文原因。"""
    txt = log or ""
    rules = [
        ("ModuleNotFoundError", "缺少 Python 依赖：请先 pip install -r requirements.txt"),
        ("ConnectionError", "网络无法连接上交所，请检查网络/代理后重试"),
        ("ProxyError", "代理服务器拒绝连接，请关闭代理或设置正确代理后重试"),
        ("TimeoutError", "连接上交所超时，请稍后重试"),
        ("SSLError", "HTTPS 证书校验失败，请检查系统时间或代理"),
        ("PermissionError", "文件被占用或无写入权限，请关闭占用程序后重试"),
        ("JSONDecodeError", "上交所返回内容无法解析（可能被限流），请稍后重试"),
        ("没有 data/pcr_daily.csv", "本地还没有数据，请先执行 python fetch_sse.py"),
    ]
    for needle, msg in rules:
        if needle in txt:
            return msg
    tail = [ln for ln in txt.strip().splitlines() if ln.strip()]
    return tail[-1][-160:] if tail else "未知原因，详见 /api/buildlog"


def _dashboard_meta() -> dict:
    """读 dashboard.json 的少量字段，用于 status/refresh 回包。"""
    try:
        obj = json.loads(DASHBOARD.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return {
        "total_days": obj.get("days"),
        "latest_trade_date": obj.get("latest_trade_date"),
        "generated_at": obj.get("generated_at"),
    }


def _futures_meta() -> dict:
    """读 futures.json 的少量字段，用于 status/refresh 回包。"""
    try:
        obj = json.loads(FUTURES.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return {
        "total_days": obj.get("days"),
        "latest_trade_date": obj.get("latest_trade_date"),
        "generated_at": obj.get("generated_at"),
    }


def _run_script(script: Path, env: dict) -> tuple[int, str]:
    cmd = [sys.executable, str(script)]
    proc = subprocess.run(
        cmd, cwd=str(HERE), capture_output=True, timeout=BUILD_TIMEOUT,
        env=env, text=True, encoding="utf-8", errors="replace",
    )
    out = (proc.stdout or "") + ("\n[stderr]\n" + proc.stderr if proc.stderr else "")
    return proc.returncode, out


def _run_futures(fetch: bool) -> dict:
    """跑期货管线：fetch_futures.py（可选）→ build_futures.py。

    成功返回 {ok,elapsed,new_days,days,latest_trade_date,generated_at}，
    失败返回 {ok:False,error}。日志追加到 cache/build.log。
    """
    t0 = _now()
    before = (_futures_meta() or {}).get("total_days") or 0
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    scripts = ([FETCH_FUT_SCRIPT] if fetch else []) + [BUILD_FUT_SCRIPT]
    log_parts: list[str] = []
    for script in scripts:
        try:
            rc, out = _run_script(script, env)
        except subprocess.TimeoutExpired:
            log_parts.append(f"$ {script.name}\n超时（>{BUILD_TIMEOUT}s）")
            _append_build_log("\n".join(log_parts))
            return {"ok": False, "error": f"期货数据构建超时（>{BUILD_TIMEOUT}s），请稍后重试",
                    "elapsed": round(_now() - t0, 1)}
        log_parts.append(f"$ {script.name}\n{out}")
        if rc != 0:
            _append_build_log("\n".join(log_parts))
            return {"ok": False, "error": _explain(out), "elapsed": round(_now() - t0, 1)}
    _append_build_log("\n".join(log_parts))
    meta = _futures_meta()
    after = meta.get("total_days") or before
    return {
        "ok": True,
        "elapsed": round(_now() - t0, 1),
        "new_days": max(0, int(after) - int(before)),
        "days": after,
        "latest_trade_date": meta.get("latest_trade_date"),
        "generated_at": meta.get("generated_at"),
    }


def _append_build_log(text: str) -> None:
    BUILD_LOG.parent.mkdir(parents=True, exist_ok=True)
    with BUILD_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"\n[{datetime.now():%Y-%m-%d %H:%M:%S}] 期货\n{text}\n")


def _run_build(fetch: bool) -> dict:
    """先跑期权 PCR 构建，成功后再跑期货管线。"""
    result = _run_build_pcr(fetch)
    if result.get("ok"):
        result["futures"] = _run_futures(fetch)
    return result


def _run_build_pcr(fetch: bool) -> dict:
    """跑 build_data.py；成功返回 {ok,elapsed,...}，失败返回 {ok:False,error}。"""
    t0 = _now()
    before = (_dashboard_meta() or {}).get("total_days") or 0
    cmd = [sys.executable, str(BUILD_SCRIPT)]
    if fetch:
        cmd.append("--fetch")
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    BUILD_LOG.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            cmd, cwd=str(HERE), capture_output=True, timeout=BUILD_TIMEOUT,
            env=env, text=True, encoding="utf-8", errors="replace",
        )
        out = (proc.stdout or "") + ("\n[stderr]\n" + proc.stderr if proc.stderr else "")
        BUILD_LOG.write_text(
            f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {' '.join(cmd)}\n{out}\n",
            encoding="utf-8",
        )
        if proc.returncode != 0:
            return {"ok": False, "error": _explain(out), "elapsed": round(_now() - t0, 1)}
    except subprocess.TimeoutExpired:
        BUILD_LOG.write_text(
            f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 超时（>{BUILD_TIMEOUT}s）\n",
            encoding="utf-8",
        )
        return {"ok": False, "error": f"刷新超时（>{BUILD_TIMEOUT}s），请稍后重试",
                "elapsed": round(_now() - t0, 1)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"启动构建失败：{type(exc).__name__}: {exc}",
                "elapsed": round(_now() - t0, 1)}

    meta = _dashboard_meta()
    after = meta.get("total_days") or before
    new_days = max(0, int(after) - int(before))
    return {
        "ok": True,
        "elapsed": round(_now() - t0, 1),
        "new_days": new_days,
        "total_days": after,
        "latest_trade_date": meta.get("latest_trade_date"),
        "generated_at": meta.get("generated_at"),
        "cached": new_days == 0,
    }


# ------------------------------------------------------------------ HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = "PCRBoard/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    # ---- 通用输出
    def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send_json(self, obj, code: int = 200) -> None:
        self._send(code, _json_bytes(obj), "application/json; charset=utf-8")

    def _send_file(self, rel: str, cache: str) -> None:
        path = (HERE / rel).resolve()
        if HERE not in path.parents and path != HERE:
            self._send_json({"ok": False, "error": "非法路径"}, 403)
            return
        if not path.is_file():
            self._send_json({"ok": False, "error": f"文件不存在: {rel}"}, 404)
            return
        data = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, data, ctype, cache)

    # ---- GET
    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/api/data", "/api/data/"):
                if not DASHBOARD.is_file():
                    self._send_json({"ok": False, "error": "还没有数据，请点击「刷新数据」"}, 503)
                    return
                self._send(200, DASHBOARD.read_bytes(), "application/json; charset=utf-8")
            elif path in ("/api/futures", "/api/futures/"):
                if not FUTURES.is_file():
                    self._send_json({"ok": False, "error": "还没有期货数据，请点击「刷新数据」"}, 503)
                    return
                self._send(200, FUTURES.read_bytes(), "application/json; charset=utf-8")
            elif path == "/api/status":
                exists = DASHBOARD.is_file()
                st = DASHBOARD.stat() if exists else None
                fexists = FUTURES.is_file()
                fst = FUTURES.stat() if fexists else None
                fmeta = _futures_meta() if fexists else {}
                active = bool(_STATE["active"])
                self._send_json({
                    "ok": True,
                    "exists": exists,
                    "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S") if st else None,
                    "size_kb": round(st.st_size / 1024, 1) if st else 0,
                    # 契约 §5：building 为对象
                    "building": {
                        "active": active,
                        "seconds": round(_now() - _STATE["started"], 1) if active else 0,
                        "by": _STATE["by"],
                    },
                    # 契约 §10：期货数据状态
                    "futures": {
                        "exists": fexists,
                        "mtime": datetime.fromtimestamp(fst.st_mtime).strftime("%Y-%m-%d %H:%M:%S") if fst else None,
                        "size_kb": round(fst.st_size / 1024, 1) if fst else 0,
                        "days": fmeta.get("total_days"),
                    },
                })
            elif path == "/api/buildlog":
                text = _read_build_log()
                self._send_json({"ok": True, "exists": bool(text), "text": text,
                                 "log": text})
            elif path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
            elif path in ("/", "/index.html"):
                self._send_file("index.html", "no-cache")
            elif path.startswith("/assets/"):
                self._send_file(path.lstrip("/"), "no-cache")
            elif path.startswith("/vendor/"):
                self._send_file(path.lstrip("/"), "max-age=604800")
            elif path.startswith("/docs/"):
                self._send_file(path.lstrip("/"), "no-cache")
            else:
                self._send_json({"ok": False, "error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---- POST
    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/api/refresh", "/api/refresh/"):
            self._send_json({"ok": False, "error": "not found"}, 404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        with _LOCK:
            busy = _STATE["active"] and (_now() - _STATE["started"]) < BUILD_STALE
            running = round(_now() - _STATE["started"], 1) if busy else 0
            if not busy:
                _STATE.update(active=True, started=_now(), by="api")
        if busy:
            self._send_json({"ok": False, "busy": True, "running_seconds": running,
                             "error": f"已有刷新任务在运行（{running}s），请稍候再试"}, 409)
            return
        try:
            result = _run_build(fetch=True)
        finally:
            with _LOCK:
                _STATE.update(active=False, started=0.0, by="")
        self._send_json(result, 200 if result.get("ok") else 500)

    # ---- 日志
    def log_message(self, fmt: str, *args) -> None:
        if "/api/" in (args[0] if args else ""):
            return
        sys.stderr.write(f"  {self.address_string()} {fmt % args}\n")


def _open_browser_later(url: str) -> None:
    def go():
        time.sleep(0.8)
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=go, daemon=True).start()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--open", action="store_true",
                    help="显式打开浏览器（默认构建完成后就会打开；与 --no-open 互斥）")
    ap.add_argument("--rebuild", action="store_true",
                help="启动时用现有缓存强制重新汇总数据（不重新抓取历史）")
    ap.add_argument("--no-build", action="store_true",
                    help="不自动抓取/构建数据（首次运行或只想预览界面时使用）")
    args = ap.parse_args()

    if args.no_build:
        print("[serve] 跳过自动构建（--no-build）；页面会提示无数据，可用 ?mock=1 预览界面")
    elif args.rebuild or not DASHBOARD.is_file():
        why = "强制重建" if args.rebuild else "首次启动，先抓取数据（可能需要几分钟）"
        print(f"[serve] {why} …")
        r = _run_build(fetch=True)
        print(f"[serve] 构建结果：{r}")
        if not r.get("ok"):
            print("[serve] 构建失败，页面会提示错误；可点「刷新数据」重试。")
    elif not FUTURES.is_file():
        print("[serve] 还没有期货数据，先构建（首次全量约 5~8 分钟，增量约 1~3 分钟）…")
        r = _run_futures(fetch=True)
        print(f"[serve] 期货构建结果：{r}")

    url = f"http://{args.host}:{args.port}/"
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"[serve] 看板已启动: {url}")
    print("[serve] Ctrl+C 停止")
    if not args.no_open:
        _open_browser_later(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] 已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
