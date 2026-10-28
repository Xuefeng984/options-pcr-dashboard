# -*- coding: utf-8 -*-
"""股指期货「升贴水」抓取器 —— 逐合约 + 指数日线缓存（新浪财经）。

数据源
------
股指期货（中金所 IF / IC / IM / IH，逐合约日线）
    https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{code}=/InnerFuturesNewService.getDailyKLine?symbol={code}
    返回该合约从上市到退市的全部日线（已退市合约也能取到历史）。

现货指数（新浪财经指数日线，datalen=3000 约 12 年）
    https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={sym}&scale=240&ma=no&datalen=3000

说明
----
- 中金所目前只有 4 个股指期货品种：IF(沪深300) / IC(中证500) / IM(中证1000) / IH(上证50)。
  **没有科创50 指数期货**，所以本模块不含科创50；页面里会以「暂无」提示代替。
- 合约代码 = 品种 + YYMM，例如 IF2611 = 沪深300 2026 年 11 月合约。
- 中金所挂牌规则：当月、下月、随后两个季月，因此任意交易日最多 4 个合约可交易。
- 某合约「是否上市」直接以新浪是否返回数据为准；返回空的合约记入 failed_contracts.json，
  下次增量刷新不再重试（--full 会重试）。

缓存结构
--------
    cache/raw/idx/000300.json     现货指数日线（沪深300 等 4 条）
    cache/raw/fut/IF2611.json     单合约日线（date, close, volume, oi）
    cache/failed_contracts.json   确认没有数据的合约（如 IM 2022-07 之前的月份）

用法
----
    python fetch_futures.py                 # 增量抓取（指数全刷，合约只刷活跃/缺失的）
    python fetch_futures.py --full          # 忽略 failed 记录，重试全部缺失合约
    python fetch_futures.py --no-index      # 只抓合约
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
RAW_IDX = HERE / "cache" / "raw" / "idx"
RAW_FUT = HERE / "cache" / "raw" / "fut"
FAILED = HERE / "cache" / "failed_contracts.json"

IDX_URL = ("https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
           "CN_MarketData.getKLineData")
FUT_URL = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/"
           "var%20_{code}=/InnerFuturesNewService.getDailyKLine?symbol={code}")
HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://finance.sina.com.cn/",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
}

# 现货指数：新浪代码 -> 中证/上证代码（顺序即页面卡片顺序由 build 决定）
IDX_SYMBOLS = [
    ("000300", "sh000300"),   # 沪深300
    ("000905", "sh000905"),   # 中证500
    ("000852", "sh000852"),   # 中证1000
    ("000016", "sh000016"),   # 上证50
]
PRODUCTS = [
    ("IF", "000300", "沪深300"),
    ("IC", "000905", "中证500"),
    ("IM", "000852", "中证1000"),
    ("IH", "000016", "上证50"),
]

CONTRACT_START = (2019, 1)     # 合约覆盖起点（2019 年前的合约不抓）
IDX_DATALEN = 3000             # 约 12 年
MAX_WORKERS = 3
RETRIES = 4
TIMEOUT = 20


def _get(url: str, params: dict | None = None) -> requests.Response:
    """不用 Session（复用连接会被新浪接口判成异常返回 null），每次新连接 + 少量抖动。"""
    time.sleep(0.08 + random.random() * 0.12)
    return requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)


# ---------------------------------------------------------------- 工具
def _write_json(path: Path, obj, indent: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=indent), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _months(start: tuple[int, int], end: tuple[int, int]):
    y, m = start
    while (y, m) <= end:
        yield y, m
        m += 1
        if m > 12:
            y, m = y + 1, 1


def _contract_months_end(today: date) -> tuple[int, int]:
    """合约月份抓到「今天往后 13 个月」，保证下一年度合约已在缓存。"""
    total = today.year * 12 + (today.month - 1) + 13
    return total // 12, total % 12 + 1


def contract_codes(product: str) -> list[str]:
    end = _contract_months_end(date.today())
    return [f"{product}{y % 100:02d}{m:02d}" for y, m in _months(CONTRACT_START, end)]


def contract_expiry(code: str) -> date:
    """中金所股指期货交割日 = 合约月份的第三个周五（遇节假日由调用方顺延）。"""
    ym = re.search(r"(\d{2})(\d{2})$", code)
    yy, mm = int(ym.group(1)), int(ym.group(2))
    year = 2000 + yy if yy < 70 else 1900 + yy
    d = date(year, mm, 1)
    fridays = 0
    while True:
        if d.weekday() == 4:
            fridays += 1
            if fridays == 3:
                return d
        d += timedelta(days=1)


# ---------------------------------------------------------------- 抓取
def fetch_index(code: str, sym: str) -> list[dict]:
    params = {"symbol": sym, "scale": "240", "ma": "no", "datalen": str(IDX_DATALEN)}
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            r = _get(IDX_URL, params=params)
            r.raise_for_status()
            rows = r.json()
            out = []
            for row in rows or []:
                day = str(row.get("day") or "")[:10]
                close = row.get("close")
                if day and close is not None:
                    out.append({"day": day, "close": round(float(close), 4)})
            if not out:
                raise RuntimeError("空数据")
            return out
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"指数 {code} 抓取失败: {type(last).__name__}: {last}")


_JSONP_RE = re.compile(r"=\s*\((\[.*?\])\)\s*;", re.S)


def fetch_contract(code: str) -> list[dict]:
    """抓一个合约的全部日线；合约不存在（接口返回 null）时返回 []。

    新浪接口在请求过密/复用连接时会返回 `(null)`，所以这里把「解析不出来」当成
    可重试的错误，退避后重试；重试仍失败才当作无数据。
    """
    url = FUT_URL.format(code=code)
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            r = _get(url)
            r.raise_for_status()
            m = _JSONP_RE.search(r.text)
            if not m:
                raise RuntimeError("接口返回 null（可能被限流）")
            rows = json.loads(m.group(1))
            out = []
            for row in rows or []:
                day = str(row.get("d") or "")[:10]
                close = row.get("c")
                if not day or close in (None, "", "0.000"):
                    continue
                try:
                    fclose = float(close)
                except ValueError:
                    continue
                if fclose <= 0:
                    continue
                out.append({
                    "d": day,
                    "c": round(fclose, 4),
                    "v": int(float(row.get("v") or 0)),
                    "p": int(float(row.get("p") or 0)),
                })
            return out
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.8 * (attempt + 1))
    if isinstance(last, RuntimeError) and "null" in str(last):
        return []          # 确认接口没有这个合约（如 IM 2022-07 之前）
    raise RuntimeError(f"合约 {code} 抓取失败: {type(last).__name__}: {last}")


def _contract_file(code: str) -> Path:
    return RAW_FUT / f"{code}.json"


def _idx_file(code: str) -> Path:
    return RAW_IDX / f"{code}.json"


def refresh(full: bool = False, with_index: bool = True) -> dict:
    t0 = time.time()
    RAW_IDX.mkdir(parents=True, exist_ok=True)
    RAW_FUT.mkdir(parents=True, exist_ok=True)
    today = date.today()
    summary = {"index": 0, "fetched": 0, "cached": 0, "failed": 0, "elapsed": 0.0}

    # 1) 指数日线：每次都刷（4 个请求，很轻）
    if with_index:
        for code, sym in IDX_SYMBOLS:
            try:
                rows = fetch_index(code, sym)
                _write_json(_idx_file(code), {
                    "code": code,
                    "symbol": sym,
                    "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "data": rows,
                })
                summary["index"] += 1
                print(f"  [指数] {code} {len(rows)} 天 {rows[0]['day']} ~ {rows[-1]['day']}")
            except Exception as exc:  # noqa: BLE001
                print(f"  [指数] {code} 失败：{exc}（沿用旧缓存）")
        sys.stdout.flush()

    # 目标交易日 = 指数缓存里的最新一天（合约与指数同为收盘价，指数已出当日数据即视作已收盘）
    target_day = max(
        (datetime.strptime(rows["data"][-1]["day"], "%Y-%m-%d").date()
         for rows in (_read_json(_idx_file(code), {}) for code, _sym in IDX_SYMBOLS)
         if rows.get("data")),
        default=today,
    )

    # 2) 合约：决定哪些需要抓
    failed = set() if full else set(_read_json(FAILED, []))
    tasks: list[tuple[str, bool]] = []
    for product, _spot, _name in PRODUCTS:
        for code in contract_codes(product):
            p = _contract_file(code)
            exp = contract_expiry(code)
            if p.is_file():
                try:
                    last_day = json.loads(p.read_text(encoding="utf-8"))["data"][-1]["d"]
                    last_d = datetime.strptime(last_day, "%Y-%m-%d").date()
                except Exception:  # noqa: BLE001
                    last_d = date(1990, 1, 1)
                if exp < target_day - timedelta(days=1):
                    # 目标日之前就到期：数据是终态，不重抓
                    summary["cached"] += 1
                    continue
                if last_d >= target_day:
                    summary["cached"] += 1
                    continue
                tasks.append((code, True))
                continue
            if code in failed:
                summary["cached"] += 1
                continue
            tasks.append((code, False))

    total = len(tasks)
    print(f"  [合约] 待处理 {total} 个（已缓存/跳过 {summary['cached']} 个，"
          f"failed 记录 {len(failed)} 个）")
    if total == 0:
        summary["elapsed"] = round(time.time() - t0, 1)
        return summary

    lock = threading.Lock()
    done = 0
    new_failed: set[str] = set()
    errors: list[str] = []

    def work(code: str):
        try:
            return code, fetch_contract(code), None
        except Exception as exc:  # noqa: BLE001
            return code, None, str(exc)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = [ex.submit(work, code) for code, _ in tasks]
        for fut in as_completed(futs):
            code, rows, err = fut.result()
            with lock:
                done += 1
                if err:
                    errors.append(f"{code}: {err}")
                elif not rows:
                    new_failed.add(code)
                else:
                    _write_json(_contract_file(code), {
                        "code": code,
                        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "data": rows,
                    })
                    summary["fetched"] += 1
                if done % 40 == 0 or done == total:
                    print(f"  [合约] {done}/{total}  新抓 {summary['fetched']}  "
                          f"无数据 {len(new_failed)}  错 {len(errors)}")
                    sys.stdout.flush()

    if new_failed:
        _write_json(FAILED, sorted(failed | new_failed))
    summary["failed"] = len(new_failed)
    if errors:
        print(f"  [合约] {len(errors)} 个失败（下次刷新自动重试）：{errors[:3]}")
    summary["elapsed"] = round(time.time() - t0, 1)
    print(f"  [抓取] 完成：新抓 {summary['fetched']} 个合约，无数据 {len(new_failed)}，"
          f"用时 {summary['elapsed']}s")
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="重试 failed 里的合约")
    ap.add_argument("--no-index", action="store_true", help="只抓合约，不刷指数")
    args = ap.parse_args()
    refresh(full=args.full, with_index=not args.no_index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
