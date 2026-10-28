# -*- coding: utf-8 -*-
"""上交所股票期权「每日统计」抓取器 —— 逐日缓存 + 每日增量合并。

数据源
------
上海证券交易所 · 产品 → 股票期权 → 每日统计
    http://query.sse.com.cn/commonQuery.do
    sqlId = COMMON_SSE_ZQPZ_YSP_QQ_SJTJ_MRTJ_CX&tradeDate=YYYYMMDD

每个交易日返回全部 ETF 期权标的（510050 / 510300 / 510500 / 588000 / 588080）
的认购/认沽成交量与未平仓量。T 日收盘后更新；周末与节假日返回空 result。

缓存结构
--------
    cache/raw/sse/YYYYMMDD.json   单日原始数据（抓过就不再抓）
    cache/trading_days.csv        交易日历（种子 + 自动扩展）
    cache/holidays.json           探测过的非交易日
    cache/failed_days.json        抓取失败、下次重试的日期
    data/pcr_daily.csv            全部日期合并后的长表（"每日合并数据"）

用法
----
    python fetch_sse.py                 # 增量抓取到今天，然后合并
    python fetch_sse.py --force         # 忽略缓存，全部重抓
    python fetch_sse.py --start 2021-01-01
    python fetch_sse.py --no-merge      # 只抓不合并
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
RAW = HERE / "cache" / "raw" / "sse"
CALENDAR = HERE / "cache" / "trading_days.csv"
HOLIDAYS = HERE / "cache" / "holidays.json"
FAILED = HERE / "cache" / "failed_days.json"
MERGED = HERE / "data" / "pcr_daily.csv"
SEED_CALENDAR = HERE / "data" / "seed_calendar.csv"   # 随包附带的交易日历种子（可删）

DEFAULT_START = "2019-12-23"          # 沪深300ETF 期权上市日
URL = "http://query.sse.com.cn/commonQuery.do"
SQL_ID = "COMMON_SSE_ZQPZ_YSP_QQ_SJTJ_MRTJ_CX"
HEADERS = {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.sse.com.cn/",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
}

# 关注标的（顺序即前端卡片顺序）
FOCUS = [
    ("hs300", "沪深300", "510300", "华泰柏瑞沪深300ETF", "#4fc3f7"),
    ("zz500", "中证500", "510500", "南方中证500ETF", "#ffb74d"),
    ("kc50", "科创50", "588000", "华夏科创50ETF", "#b388ff"),
]
EXTRA = [("sz50", "上证50", "510050", "华夏上证50ETF", "#8bc34a")]
ALL_CODES = {c for _, _, c, _, _ in FOCUS + EXTRA}

MAX_WORKERS = 6
RETRIES = 3
REQUEST_TIMEOUT = 15

_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update(HEADERS)
        _local.s = s
    return s


# ---------------------------------------------------------------- 工具
def _num(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _iso(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def _d(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def weekdays_between(start: date, end: date):
    cur = start
    while cur <= end:
        if cur.weekday() < 5:
            yield cur
        cur += timedelta(days=1)


# ---------------------------------------------------------------- 日历
def load_calendar() -> list[str]:
    """读本地交易日历；不存在时用随包的 data/seed_calendar.csv 做种子，再退化到工作日。"""
    if CALENDAR.is_file():
        txt = CALENDAR.read_text(encoding="utf-8-sig").splitlines()
        days = [ln.strip() for ln in txt if ln.strip() and not ln.startswith("date")]
        if days:
            return days
    days: list[str] = []
    if SEED_CALENDAR.is_file():
        for ln in SEED_CALENDAR.read_text(encoding="utf-8-sig").splitlines():
            d = ln.split(",")[0].strip()
            if len(d) == 10 and d[4] == "-" and d[:4].isdigit():
                days.append(d)
    if not days:  # 最后兜底：工作日
        days = [_iso(d) for d in weekdays_between(date(2019, 12, 23), date.today())]
    CALENDAR.parent.mkdir(parents=True, exist_ok=True)
    CALENDAR.write_text("date\n" + "\n".join(days) + "\n", encoding="utf-8")
    print(f"  [日历] 初始化 {len(days)} 个交易日（{days[0]} ~ {days[-1]}）")
    return days


def save_calendar(days: list[str]) -> None:
    days = sorted(set(days))
    CALENDAR.write_text("date\n" + "\n".join(days) + "\n", encoding="utf-8")


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- 单日抓取
def fetch_day(day: str) -> list[dict]:
    """抓一个交易日的全部期权标的统计。

    返回 [] 表示该日无数据（非交易日或尚未发布）；网络/解析错误抛异常。
    """
    params = {
        "isPagination": "false",
        "sqlId": SQL_ID,
        "tradeDate": day.replace("-", ""),
    }
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            r = _session().get(URL, params=params, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            payload = r.json()
            rows = payload.get("result") or []
            out = []
            for row in rows:
                code = str(row.get("SECURITY_CODE") or "").strip()
                if not code:
                    continue
                out.append({
                    "code": code,
                    "name": str(row.get("SECURITY_ABBR") or "").strip(),
                    "call_vol": _num(row.get("CALL_VOLUME")),
                    "put_vol": _num(row.get("PUT_VOLUME")),
                    "call_oi": _num(row.get("LEAVES_CALL_QTY")),
                    "put_oi": _num(row.get("LEAVES_PUT_QTY")),
                    "total_vol": _num(row.get("TOTAL_VOLUME")),
                    "contracts": _num(row.get("CONTRACT_VOLUME")),
                    "raw_cp_rate": _num(row.get("CP_RATE")),
                })
            return out
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"{day} 抓取失败: {type(last).__name__}: {last}")


def _day_file(day: str) -> Path:
    return RAW / f"{day.replace('-', '')}.json"


def fetch_one(day: str, force: bool = False) -> str:
    """抓一天并落盘。返回状态：cached / fetched / empty。"""
    p = _day_file(day)
    if p.is_file() and not force:
        return "cached"
    rows = fetch_day(day)
    if not rows:
        return "empty"
    _write_json(p, {
        "trade_date": day,
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "rows": rows,
    })
    return "fetched"


# ---------------------------------------------------------------- 增量抓取
def refresh(force: bool = False, start: str = DEFAULT_START,
            recheck_last: int = 2, workers: int = MAX_WORKERS) -> dict:
    """增量抓取：只抓本地还没有的交易日 + 最近 recheck_last 天（防盘中/修正）。"""
    t0 = time.time()
    RAW.mkdir(parents=True, exist_ok=True)
    cal = load_calendar()
    cal_set = set(cal)
    start_d = max(_d(start), _d(cal[0])) if cal else _d(start)
    today = date.today()

    holidays = set(_read_json(HOLIDAYS, []))
    failed = set(_read_json(FAILED, []))
    done_files = {f.stem for f in RAW.glob("*.json")}  # 20261020

    # 1) 日历里已知的交易日
    wanted = [d for d in cal if _d(d) >= start_d]

    # 2) 日历尾部之后的工作日：逐个探测（缓存文件存在则跳过）
    tail_start = max(start_d, _d(cal[-1]) + timedelta(days=1)) if cal else start_d
    probe = []
    for d in weekdays_between(tail_start, today):
        ds = _iso(d)
        if ds in holidays:
            continue
        if d.strftime("%Y%m%d") in done_files:
            wanted.append(ds)
            continue
        if ds in cal_set:
            continue
        probe.append(ds)

    # 3) 最近 recheck_last 个已缓存交易日强制重抓（覆盖盘中未定稿数据）
    recheck = []
    if recheck_last > 0:
        recheck = sorted(done_files)[-recheck_last:]

    tasks = []
    seen = set()
    for ds in wanted:
        if ds in seen:
            continue
        seen.add(ds)
        if ds in recheck:
            continue  # 放到后面强制抓
        if _day_file(ds).is_file() and not force:
            continue
        tasks.append((ds, False))
    for ds in probe:
        tasks.append((ds, False))
    for stem in recheck:
        ds = f"{stem[:4]}-{stem[4:6]}-{stem[6:]}"
        if ds >= _iso(start_d):
            tasks.append((ds, True))

    total = len(tasks)
    print(f"  [抓取] 待处理 {total} 天（已缓存 {len(done_files)} 天，"
          f"日历 {len(cal)} 天，start={_iso(start_d)}）")
    if total == 0:
        return _merge_summary(t0, 0, len(done_files))

    fetched = empty = 0
    lock = threading.Lock()
    errors: list[str] = []
    done = 0

    def work(ds: str, is_recheck: bool):
        try:
            return ds, fetch_one(ds, force=is_recheck or force_effective), None
        except Exception as exc:  # noqa: BLE001
            return ds, None, str(exc)

    force_effective = force
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(work, ds, rc) for ds, rc in tasks]
        for fut in as_completed(futs):
            ds, status, err = fut.result()
            with lock:
                done += 1
                if err:
                    errors.append(f"{ds}: {err}")
                elif status == "fetched":
                    fetched += 1
                elif status == "empty":
                    empty += 1
                    if ds < _iso(today):
                        holidays.add(ds)
                if done % 100 == 0 or done == total:
                    print(f"  [抓取] {done}/{total}  新数据 {fetched}  空 {empty}  错 {len(errors)}")

    # 探测结果：非交易日写 holidays；今天空可能是未发布，不算节假日
    if empty:
        _write_json(HOLIDAYS, sorted(holidays))
    _write_json(FAILED, sorted(errors))
    if errors:
        print(f"  [抓取] {len(errors)} 天失败，下次刷新自动重试：{errors[:3]}")

    # 扩展日历：已知交易日 + 本次成功的日期
    new_days = [f"{s[:4]}-{s[4:6]}-{s[6:]}" for s in sorted(done_files)]
    for f in RAW.glob("*.json"):
        ds = f"{f.stem[:4]}-{f.stem[4:6]}-{f.stem[6:]}"
        if ds >= _iso(start_d):
            new_days.append(ds)
    save_calendar([d for d in new_days if d >= _iso(start_d)])
    return _merge_summary(t0, fetched + empty, len(list(RAW.glob('*.json'))))


def _merge_summary(t0: float, processed: int, cached_days: int) -> dict:
    summary = {
        "elapsed": round(time.time() - t0, 1),
        "processed": processed,
        "cached_days": cached_days,
    }
    print(f"  [抓取] 完成：处理 {processed} 天，缓存共 {cached_days} 天，"
          f"用时 {summary['elapsed']}s")
    return summary


# ---------------------------------------------------------------- 合并
def merge() -> dict:
    """把所有单日缓存合并为长表 data/pcr_daily.csv。"""
    rows = []
    for f in sorted(RAW.glob("*.json")):
        try:
            payload = json.loads(f.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"  [合并] 跳过损坏文件 {f.name}: {exc}")
            continue
        day = payload.get("trade_date") or f"{f.stem[:4]}-{f.stem[4:6]}-{f.stem[6:]}"
        for r in payload.get("rows") or []:
            code = str(r.get("code") or "").strip()
            if not code:
                continue
            cv, pv = _num(r.get("call_vol")), _num(r.get("put_vol"))
            co, po = _num(r.get("call_oi")), _num(r.get("put_oi"))
            rows.append({
                "date": day,
                "code": code,
                "name": r.get("name") or "",
                "call_vol": int(cv),
                "put_vol": int(pv),
                "call_oi": int(co),
                "put_oi": int(po),
                "vol_pcr": round(pv / cv, 6) if cv else "",
                "oi_pcr": round(po / co, 6) if co else "",
            })
    rows.sort(key=lambda x: (x["date"], x["code"]))
    MERGED.parent.mkdir(parents=True, exist_ok=True)
    import csv

    cols = ["date", "code", "name", "call_vol", "put_vol", "call_oi", "put_oi", "vol_pcr", "oi_pcr"]
    with MERGED.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    dates = sorted({r["date"] for r in rows})
    print(f"  [合并] {len(rows)} 行 / {len(dates)} 个交易日 -> {MERGED.name}")
    return {"rows": len(rows), "days": len(dates), "latest": dates[-1] if dates else ""}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="忽略缓存全部重抓")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--no-merge", action="store_true")
    ap.add_argument("--merge-only", action="store_true")
    ap.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = ap.parse_args()

    t0 = time.time()
    if not args.merge_only:
        refresh(force=args.force, start=args.start, workers=args.workers)
    if not args.no_merge:
        merge()
    print(f"  总用时 {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
