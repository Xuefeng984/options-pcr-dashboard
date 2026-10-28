# -*- coding: utf-8 -*-
"""把 data/pcr_daily.csv 汇总成前端要的 cache/dashboard.json（契约见 DATA_CONTRACT.md）。

    python build_data.py            # 只汇总
    python build_data.py --fetch    # 先增量抓取+合并，再汇总（刷新按钮走这条）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
MERGED = HERE / "data" / "pcr_daily.csv"
OUT = HERE / "cache" / "dashboard.json"

VERSION = 1
SOURCE = "上海证券交易所 · 股票期权每日统计"
SOURCE_URL = "http://www.sse.com.cn/market/stockoption/optiondaily/"

INDICES = [
    ("hs300", "沪深300", "510300", "华泰柏瑞沪深300ETF", "#4fc3f7"),
    ("zz500", "中证500", "510500", "南方中证500ETF", "#ffb74d"),
    ("kc50", "科创50", "588000", "华夏科创50ETF", "#b388ff"),
]
EXTRA = [("sz50", "上证50", "510050", "华夏上证50ETF", "#8bc34a")]


def read_merged() -> dict[str, dict[str, list]]:
    """返回 {code: {"dates":[], "call_vol":[], ...}}。"""
    if not MERGED.is_file():
        return {}
    import csv

    out: dict[str, dict[str, list]] = {}
    with MERGED.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            code = (row.get("code") or "").strip()
            day = (row.get("date") or "").strip()
            if not code or len(day) != 10:
                continue
            b = out.setdefault(code, {
                "dates": [], "call_vol": [], "put_vol": [],
                "call_oi": [], "put_oi": [], "name": row.get("name") or "",
            })
            cv = _int(row.get("call_vol"))
            pv = _int(row.get("put_vol"))
            co = _int(row.get("call_oi"))
            po = _int(row.get("put_oi"))
            b["dates"].append(day)
            b["call_vol"].append(cv)
            b["put_vol"].append(pv)
            b["call_oi"].append(co)
            b["put_oi"].append(po)
    for b in out.values():
        n = len(b["dates"])
        order = sorted(range(n), key=lambda i: b["dates"][i])
        for k in ("dates", "call_vol", "put_vol", "call_oi", "put_oi"):
            b[k] = [b[k][i] for i in order]
    return out


def _int(v) -> int:
    try:
        return int(float(str(v).strip() or 0))
    except (TypeError, ValueError):
        return 0


def _pcr(num: int, den: int):
    if not den:
        return None
    return round(num / den, 4)


def build_index(key: str, name: str, code: str, full_name: str, color: str,
                raw: dict[str, dict[str, list]]) -> dict | None:
    b = raw.get(code)
    if not b or not b["dates"]:
        return None
    vol, oi = [], []
    for pv, cv in zip(b["put_vol"], b["call_vol"]):
        vol.append(_pcr(pv, cv))
    for po, co in zip(b["put_oi"], b["call_oi"]):
        oi.append(_pcr(po, co))
    # 契约要求 vol/oi 为 0~10 浮点；极值（分母异常小）截断，避免破坏缩放
    vol = [None if v is None else round(max(0.0, min(10.0, v)), 4) for v in vol]
    oi = [None if v is None else round(max(0.0, min(10.0, v)), 4) for v in oi]
    return {
        "key": key,
        "name": name,
        "code": code,
        "code_suffix": f"{code}.SH",
        "full_name": full_name,
        "color": color,
        "start": b["dates"][0],
        "end": b["dates"][-1],
        "count": len(b["dates"]),
        "dates": b["dates"],
        "vol": vol,
        "oi": oi,
        "call_vol": b["call_vol"],
        "put_vol": b["put_vol"],
        "call_oi": b["call_oi"],
        "put_oi": b["put_oi"],
    }


def build(fetch: bool = False) -> int:
    t0 = time.time()
    if fetch:
        import fetch_sse

        fetch_sse.refresh()
        fetch_sse.merge()

    raw = read_merged()
    if not raw:
        print("[build] 没有 data/pcr_daily.csv，先抓数据：python build_data.py --fetch")
        return 2

    indices = [x for x in (build_index(*spec, raw) for spec in INDICES) if x]
    if not indices:
        print("[build] 关注标的（510300/510500/588000）没有任何数据")
        return 2
    extra = [x for x in (build_index(*spec, raw) for spec in EXTRA) if x]

    all_dates = sorted({d for idx in indices for d in idx["dates"]})
    latest = all_dates[-1] if all_dates else ""
    payload = {
        "ok": True,
        "version": VERSION,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": SOURCE,
        "source_url": SOURCE_URL,
        "latest_trade_date": latest,
        "days": len(all_dates),
        "first_trade_date": all_dates[0] if all_dates else "",
        "indices": indices,
        "extra_indices": extra,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    os.replace(tmp, OUT)

    size_kb = OUT.stat().st_size / 1024
    for idx in indices + extra:
        print(f"  [build] {idx['name']:<6} {idx['code']}  {idx['count']:>5} 天  "
              f"{idx['start']} ~ {idx['end']}")
    print(f"  [build] {latest} 共 {len(all_dates)} 个交易日 -> cache/dashboard.json "
          f"({size_kb:.0f} KB, {time.time() - t0:.1f}s)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="先增量抓取并合并，再汇总")
    args = ap.parse_args()
    try:
        return build(fetch=args.fetch)
    except Exception as exc:  # noqa: BLE001  让 serve.py 的 build.log 拿到可读原因
        import traceback

        traceback.print_exc()
        print(f"[build] 失败: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
