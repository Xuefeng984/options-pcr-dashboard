# -*- coding: utf-8 -*-
"""把「逐合约期货日线 + 现货指数日线」合并成前端直接可用的 cache/futures.json。

口径（写进页面脚注与 DATA_CONTRACT.md）
---------------------------------------
- 基差点数     basis      = 期货收盘 - 现货收盘            （负值 = 贴水）
- 基差率       basis_rate = (期货/现货 - 1) × 100          （负值 = 贴水）
- 年化贴水率   ann        = (现货 - 期货)/现货 × 365/剩余天数 × 100
                            （正值 = 贴水，负值 = 升水；剩余天数 = 交割日 - 交易日）
- 主力合约：当天有成交量/持仓且未到期、剩余天数 ≥ 7 天的最近月合约；
            若都不满足则取最近月未到期合约。交割日 = 合约月第三个周五（遇节假日顺延到下一交易日）。
- 恒定到期 30 天（cm30）：取相邻两个未到期合约，按剩余天数把「基差点数」线性插值到
            30 个日历天处，再年化（cm_ann）并换算基差率（cm_rate）。没有更低到期合约时
            （刚换月、近月剩余 30~45 天），直接用近月合约自身年化。目的是消除换月跳变
            与近月年化在剩余天数很小时被 365/dte 放大的噪声，让历史比较有意义。
- 中金所只有 IF / IC / IM / IH 四个股指期货品种，没有科创50 指数期货（页面已注明）。

输入：cache/raw/idx/*.json、cache/raw/fut/*.json
输出：cache/futures.json（前端数据源）、data/futures_daily.csv（每日合并数据，给人看）

用法：python build_futures.py
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
RAW_IDX = HERE / "cache" / "raw" / "idx"
RAW_FUT = HERE / "cache" / "raw" / "fut"
OUT = HERE / "cache" / "futures.json"
MERGED = HERE / "data" / "futures_daily.csv"

VERSION = 2
SOURCE = "中国金融期货交易所 · 新浪财经（合约与指数日线）"
SOURCE_URL = "http://www.cffex.com.cn/sj/hqsj/rtj/"
MIN_DTE = 7          # 主力合约最少剩余天数（避免交割周年化放大）
MAX_ROLL = 10        # 交割日遇节假日最多顺延几天
CM_TARGET = 30       # 恒定到期目标：30 个日历天
CM_FALLBACK_MAX = 45 # 刚换月、没有更低到期合约时，近月剩余天数不超过该值时允许回退

INDICES = [
    {"key": "hs300", "name": "沪深300", "color": "#4fc3f7", "product": "IF", "spot": "000300"},
    {"key": "zz500", "name": "中证500", "color": "#ffb74d", "product": "IC", "spot": "000905"},
    {"key": "zz1000", "name": "中证1000", "color": "#26c6da", "product": "IM", "spot": "000852"},
    {"key": "sz50", "name": "上证50", "color": "#8bc34a", "product": "IH", "spot": "000016"},
]
EXTRA_KEYS = ["zz1000", "sz50"]     # 用户点名 3 个之外，额外提供 2 个品种


def load_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def third_friday(year: int, month: int) -> date:
    d = date(year, month, 1)
    n = 0
    while True:
        if d.weekday() == 4:
            n += 1
            if n == 3:
                return d
        d += timedelta(days=1)


def contract_expiry(code: str, trading_days: set[str]) -> date:
    """合约交割日：合约月第三个周五，若不是交易日则顺延到之后最近的交易日。"""
    ym = code[-4:]
    yy, mm = int(ym[:2]), int(ym[2:])
    year = 2000 + yy if yy < 70 else 1900 + yy
    d = third_friday(year, mm)
    for _ in range(MAX_ROLL):
        if d.strftime("%Y-%m-%d") in trading_days:
            return d
        d += timedelta(days=1)
    return third_friday(year, mm)


def load_spot(code: str) -> dict[str, float]:
    obj = load_json(RAW_IDX / f"{code}.json", {})
    out: dict[str, float] = {}
    for row in obj.get("data") or []:
        day = str(row.get("day") or "")[:10]
        close = row.get("close")
        if day and close is not None:
            out[day] = float(close)
    return out


def load_contracts(product: str) -> dict[str, tuple[date, float]]:
    """返回 {交易日: (交割日, 收盘价)} 与 {合约代码: ...} 两个视角，这里合并为逐日候选。"""
    contracts: dict[str, dict[str, float]] = {}
    for f in sorted(RAW_FUT.glob(f"{product}[0-9]*.json")):
        obj = load_json(f, {})
        code = obj.get("code") or f.stem
        rows = obj.get("data") or []
        contracts[code] = {str(r["d"])[:10]: float(r["c"]) for r in rows if r.get("d")}
    return contracts


def load_oi(product: str) -> dict[str, dict[str, float]]:
    """返回 {合约代码: {交易日: 持仓量}}（新浪逐合约日线里的 p 字段）。"""
    out: dict[str, dict[str, float]] = {}
    for f in sorted(RAW_FUT.glob(f"{product}[0-9]*.json")):
        obj = load_json(f, {})
        code = obj.get("code") or f.stem
        series: dict[str, float] = {}
        for r in obj.get("data") or []:
            day = str(r.get("d", ""))[:10]
            if day and r.get("p") is not None:
                series[day] = float(r["p"])
        out[code] = series
    return out


def constant_maturity(cand: list[tuple[date, str, float]], spot: float, d0: date,
                      target: int = CM_TARGET) -> dict | None:
    """把当天可交易合约的基差插值到「恒定到期 target 天」，返回 cm 口径。

    cand 需按交割日升序，且只含 d0 之后到期的合约。返回:
      {"basis": 点, "rate": %, "ann": %, "mode": exact|interp|front,
       "lo": 低到期合约代码或 "", "hi": 高到期合约代码或 "", "dte": target 或回退时的实际剩余天数}
    """
    if not cand or spot <= 0:
        return None
    tgt = d0 + timedelta(days=target)
    lo = hi = None
    for exp, code, fut in cand:
        if exp <= tgt:
            lo = (exp, code, fut)
        if exp >= tgt:
            hi = (exp, code, fut)
            break
    if lo is not None and hi is not None and lo[0] == hi[0]:
        dte = (lo[0] - d0).days
        if dte <= 0:
            return None
        basis = lo[2] - spot
        return {"basis": basis, "rate": (lo[2] / spot - 1.0) * 100.0,
                "ann": -basis / spot * 365.0 / dte * 100.0, "mode": "exact",
                "lo": lo[1], "hi": hi[1], "dte": dte}
    if lo is not None and hi is not None:
        d1 = (lo[0] - d0).days
        d2 = (hi[0] - d0).days
        b1 = lo[2] - spot
        b2 = hi[2] - spot
        b = b1 + (b2 - b1) * (target - d1) / (d2 - d1)
        return {"basis": b, "rate": b / spot * 100.0,
                "ann": -b / spot * 365.0 / target * 100.0, "mode": "interp",
                "lo": lo[1], "hi": hi[1], "dte": target}
    # 刚换月：所有合约剩余天数都 > target，用最近月合约自身年化（剩余天数不超过上限时）
    if hi is not None:
        dte = (hi[0] - d0).days
        if dte <= CM_FALLBACK_MAX:
            basis = hi[2] - spot
            return {"basis": basis, "rate": (hi[2] / spot - 1.0) * 100.0,
                    "ann": -basis / spot * 365.0 / dte * 100.0, "mode": "front",
                    "lo": "", "hi": hi[1], "dte": dte}
    return None


def build_index(product: str, spot: dict[str, float],
                contracts: dict[str, dict[str, float]], cal: set[str]) -> dict | None:
    expiries = {code: contract_expiry(code, cal) for code in contracts}
    dates = sorted(d for d in spot if d in cal)
    if not dates:
        return None
    by_date: dict[str, list[tuple[date, str, float]]] = {}
    for code, series in contracts.items():
        exp = expiries[code]
        for day, close in series.items():
            if day not in spot:
                continue
            by_date.setdefault(day, []).append((exp, code, close))

    out_dates: list[str] = []
    out_spot: list[float] = []
    out_fut: list[float] = []
    out_basis: list[float] = []
    out_rate: list[float] = []
    out_ann: list[float] = []
    out_cm_basis: list[float | None] = []
    out_cm_rate: list[float | None] = []
    out_cm_ann: list[float | None] = []
    latest = None
    latest_cm = None
    cm_count = 0

    for day in dates:
        cand = sorted([x for x in by_date.get(day, []) if x[0] > date.fromisoformat(day)],
                      key=lambda x: x[0])
        if not cand:
            continue
        d0 = date.fromisoformat(day)
        mature = [x for x in cand if (x[0] - d0).days >= MIN_DTE]
        exp, code, fut = min(mature or cand, key=lambda x: x[0])
        s = spot[day]
        dte = (exp - d0).days
        if s <= 0 or dte <= 0:
            continue
        basis = fut - s
        rate = (fut / s - 1.0) * 100.0
        ann = (s - fut) / s * 365.0 / dte * 100.0
        out_dates.append(day)
        out_spot.append(round(s, 3))
        out_fut.append(round(fut, 3))
        out_basis.append(round(basis, 3))
        out_rate.append(round(rate, 4))
        out_ann.append(round(ann, 4))

        cm = constant_maturity(cand, s, d0)
        if cm is None:
            out_cm_basis.append(None)
            out_cm_rate.append(None)
            out_cm_ann.append(None)
        else:
            cm_count += 1
            out_cm_basis.append(round(cm["basis"], 3))
            out_cm_rate.append(round(cm["rate"], 4))
            out_cm_ann.append(round(cm["ann"], 4))

        latest = {
            "date": day, "spot": round(s, 3), "fut": round(fut, 3),
            "basis": round(basis, 3), "basis_rate": round(rate, 4),
            "ann": round(ann, 4), "code": code,
            "expiry": exp.strftime("%Y-%m-%d"), "dte": dte,
        }
        latest_cm = None if cm is None else {
            "basis": round(cm["basis"], 3), "basis_rate": round(cm["rate"], 4),
            "ann": round(cm["ann"], 4), "mode": cm["mode"], "dte": cm["dte"],
            "lo": cm["lo"], "hi": cm["hi"],
            "lo_expiry": next((e.strftime("%Y-%m-%d") for e, c, _ in cand if c == cm["lo"]), "")
            if cm["lo"] else "",
            "hi_expiry": next((e.strftime("%Y-%m-%d") for e, c, _ in cand if c == cm["hi"]), "")
            if cm["hi"] else "",
        }
    if not out_dates:
        return None
    return {
        "dates": out_dates,
        "spot": out_spot,
        "fut": out_fut,
        "basis": out_basis,
        "basis_rate": out_rate,
        "ann": out_ann,
        "cm_basis": out_cm_basis,
        "cm_rate": out_cm_rate,
        "cm_ann": out_cm_ann,
        "cm_count": cm_count,
        "latest": latest,
        "latest_cm": latest_cm,
    }


def term_structure(product: str, spot: float, trade_day: str,
                   contracts: dict[str, dict[str, float]], cal: set[str],
                   oi: dict[str, dict[str, float]] | None = None) -> dict:
    """返回 {"contracts": [...], "oi_max": code|None, "next_quarter": code|None}。

    contracts 行里新增 oi（持仓量，新浪 p 字段）与 is_next_quarter 标记。
    """
    d0 = date.fromisoformat(trade_day)
    rows = []
    for code, series in contracts.items():
        if trade_day not in series:
            continue
        exp = contract_expiry(code, cal)
        dte = (exp - d0).days
        if dte <= 0:
            continue
        fut = series[trade_day]
        basis = fut - spot
        rows.append({
            "code": code,
            "expiry": exp.strftime("%Y-%m-%d"),
            "dte": dte,
            "fut": round(fut, 3),
            "basis": round(basis, 3),
            "basis_rate": round((fut / spot - 1.0) * 100.0, 4),
            "ann": round((spot - fut) / spot * 365.0 / dte * 100.0, 4),
            "oi": (oi or {}).get(code, {}).get(trade_day),
        })
    rows.sort(key=lambda r: r["expiry"])
    # 持仓量最大合约（通常就是近月主力）；平手时取更近到期
    oi_max = None
    for r in rows:
        if r["oi"] is None:
            continue
        if oi_max is None or r["oi"] > oi_max["oi"]:
            oi_max = r
    # 下一个季月合约：到期月 ∈ {3,6,9,12}、到期日 > 当日，且与「持仓量最大合约」不同的最近一个
    # （主力正在移仓时，持仓量最大合约本身可能就是季月，此时取再下一个季月）
    next_q = None
    oi_max_code = oi_max["code"] if oi_max else None
    for r in rows:
        if int(r["expiry"][5:7]) not in (3, 6, 9, 12):
            continue
        if date.fromisoformat(r["expiry"]) <= d0:
            continue
        if r["code"] == oi_max_code:
            continue
        next_q = r
        break
    for r in rows:
        r["is_next_quarter"] = bool(next_q and r["code"] == next_q["code"])
    return {
        "contracts": rows,
        "oi_max": oi_max["code"] if oi_max else None,
        "next_quarter": next_q["code"] if next_q else None,
    }


def build() -> dict:
    t0 = datetime.now()
    print(f"[build_futures] 开始 {t0:%Y-%m-%d %H:%M:%S}")

    spots = {idx["spot"]: load_spot(idx["spot"]) for idx in INDICES}
    if not spots.get("000300"):
        raise RuntimeError("缺少现货指数缓存，请先执行 python fetch_futures.py")
    cal: set[str] = set(spots["000300"])

    indices: list[dict] = []
    term: list[dict] = []
    csv_rows: list[dict] = []

    for cfg in INDICES:
        spot = spots.get(cfg["spot"]) or {}
        contracts = load_contracts(cfg["product"])
        if not contracts:
            print(f"  [跳过] {cfg['name']}({cfg['product']}) 没有合约缓存")
            continue
        built = build_index(cfg["product"], spot, contracts, cal)
        if not built:
            print(f"  [跳过] {cfg['name']}({cfg['product']}) 无法计算基差")
            continue
        latest = built["latest"]
        indices.append({
            "key": cfg["key"],
            "name": cfg["name"],
            "color": cfg["color"],
            "product": cfg["product"],
            "spot_code": cfg["spot"],
            "extra": cfg["key"] in EXTRA_KEYS,
            "days": len(built["dates"]),
            "start": built["dates"][0],
            "end": built["dates"][-1],
            "dates": built["dates"],
            "spot": built["spot"],
            "fut": built["fut"],
            "basis": built["basis"],
            "basis_rate": built["basis_rate"],
            "ann": built["ann"],
            "cm_target": CM_TARGET,
            "cm_days": built["cm_count"],
            "cm_basis": built["cm_basis"],
            "cm_rate": built["cm_rate"],
            "cm_ann": built["cm_ann"],
            "latest": latest,
            "latest_cm": built["latest_cm"],
        })
        for i, day in enumerate(built["dates"]):
            csv_rows.append({
                "date": day,
                "product": cfg["product"],
                "index": cfg["key"],
                "spot": built["spot"][i],
                "fut": built["fut"][i],
                "basis": built["basis"][i],
                "basis_rate": built["basis_rate"][i],
                "ann": built["ann"][i],
                "cm_basis": "" if built["cm_basis"][i] is None else built["cm_basis"][i],
                "cm_rate": "" if built["cm_rate"][i] is None else built["cm_rate"][i],
                "cm_ann": "" if built["cm_ann"][i] is None else built["cm_ann"][i],
                "front_code": latest["code"] if day == latest["date"] else "",
            })
        cm_latest = built["latest_cm"] or {}
        print(f"  [构建] {cfg['name']}({cfg['product']}) {len(built['dates'])} 天 "
              f"{built['dates'][0]} ~ {built['dates'][-1]}  最新 "
              f"基差 {latest['basis']:+.2f} 点 / 基差率 {latest['basis_rate']:+.3f}% / "
              f"近月年化 {latest['ann']:+.2f}%  主力 {latest['code']}；"
              f"cm{CM_TARGET} 年化 {cm_latest.get('ann', float('nan')):+.2f}%"
              f"（{cm_latest.get('mode', '-')}，{built['cm_count']} 天可算）")

    if not indices:
        raise RuntimeError("没有任何指数可输出（检查 cache/raw 里的期货与指数缓存）")

    # 期限结构：取所有品种最新交易日里最晚的那一天
    global_latest = max(idx["latest"]["date"] for idx in indices)
    for cfg in INDICES:
        if cfg["key"] not in {i["key"] for i in indices}:
            continue
        spot_series = spots.get(cfg["spot"]) or {}
        spot = spot_series.get(global_latest)
        if spot is None:
            continue
        ts = term_structure(cfg["product"], spot, global_latest,
                            load_contracts(cfg["product"]), cal,
                            load_oi(cfg["product"]))
        if ts["contracts"]:
            term.append({"key": cfg["key"], "name": cfg["name"],
                         "color": cfg["color"], "contracts": ts["contracts"],
                         "oi_max": ts["oi_max"], "next_quarter": ts["next_quarter"]})
    print(f"  [期限结构] {global_latest}：" + "，".join(
        f"{t['key']}={len(t['contracts'])} 个合约" for t in term))

    MERGED.parent.mkdir(parents=True, exist_ok=True)
    cols = ["date", "product", "index", "spot", "fut", "basis", "basis_rate", "ann",
            "cm_basis", "cm_rate", "cm_ann", "front_code"]
    with MERGED.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(sorted(csv_rows, key=lambda r: (r["date"], r["product"])))

    payload = {
        "ok": True,
        "version": VERSION,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": SOURCE,
        "source_url": SOURCE_URL,
        "latest_trade_date": global_latest,
        "first_trade_date": min(i["start"] for i in indices),
        "days": max(i["days"] for i in indices),
        "cm_target": CM_TARGET,
        "definition": {
            "basis": "basis = 期货收盘 - 现货收盘（点，负=贴水）",
            "basis_rate": "basis_rate = (期货/现货 - 1) × 100（%，负=贴水）",
            "ann": "ann = (现货-期货)/现货 × 365/剩余天数 × 100（%，正=贴水），基于近月主力合约",
            "cm_ann": "cm_ann = 把相邻两合约的基差点数按剩余天数线性插值到 30 天处再年化"
                      "（%，正=贴水）；无更低到期合约时（刚换月）用近月合约自身年化",
            "front": "主力=未到期且剩余天数≥7 的最近月合约；交割日=合约月第三个周五（顺延到交易日）",
        },
        "indices": indices,
        "extra_keys": [k for k in EXTRA_KEYS if k in {i["key"] for i in indices}],
        "term_structure": {"trade_date": global_latest, "indices": term},
        "notes": [
            "中金所目前只有 IF / IC / IM / IH 四个股指期货品种，没有科创50 指数期货，"
            "因此本页不含科创50 的期货升贴水。",
            "跟踪默认口径改为「恒定到期 30 天年化贴水（cm_ann）」：近月年化在剩余天数很少时会被"
            " 365/剩余天数 放大，且每次换月主力合约切换都会跳变（历史平均跳 6.6 个百分点、最大 23.5），"
            "因此不适合直接做历史比较；cm 口径把贴水插值到固定 30 天，换月跳变降到平均 2.3 个百分点。",
            "5–8 月是 A 股分红季，指数分红除权会让贴水机械性加深：IF 的 cm30 月度均值 6 月约 +11%、"
            "12 月约 −1%，跨月/跨季比较时请注意这一季节性。",
            "极端行情日（如 2020-02-03、2024-09-27、2025-04-07）基差本身会剧烈波动，"
            "cm30 也会出现大跳变，这是真实行情而非数据错误。",
            "年化贴水率用日历天数年化；临近交割（剩余天数 < 7）的合约不作为主力，避免年化值异常放大。",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_name(OUT.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(OUT)
    print(f"[build_futures] 完成：{len(indices)} 个品种，{len(csv_rows)} 行 -> "
          f"{OUT.name}（{OUT.stat().st_size / 1024:.0f} KB）")
    print(f"[build_futures] 总用时 {(datetime.now() - t0).total_seconds():.1f}s")
    return payload


def main() -> int:
    build()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
