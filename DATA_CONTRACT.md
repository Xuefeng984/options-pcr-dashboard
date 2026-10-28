# 期权 PCR 观测 —— 数据与接口契约（冻结版 v1）

> 本文件是前后端之间**唯一**的接口约定。前端只依赖 `GET /api/data` 的 JSON；
> 后端保证本文件描述的字段存在、类型稳定。

## 1. 数据来源

- 上海证券交易所「产品 → 股票期权 → 每日统计」接口
  `http://query.sse.com.cn/commonQuery.do`
  `sqlId=COMMON_SSE_ZQPZ_YSP_QQ_SJTJ_MRTJ_CX&tradeDate=YYYYMMDD`
  每个交易日返回 5 个 ETF 期权标的（510050 / 510300 / 510500 / 588000 / 588080）的
  **认购成交量 CALL_VOLUME、认沽成交量 PUT_VOLUME、未平仓认购 LEAVES_CALL_QTY、
  未平仓认沽 LEAVES_PUT_QTY**。T 日收盘后更新，周末/节假日返回空 result。
- 口径：**上交所单市场口径**。三个关注标的：

| key    | 名称   | 合约标的代码 | 标的名称             | 期权上市日  |
|--------|--------|--------------|----------------------|-------------|
| hs300  | 沪深300 | 510300      | 华泰柏瑞沪深300ETF   | 2019-12-23  |
| zz500  | 中证500 | 510500      | 南方中证500ETF       | 2022-09-19  |
| kc50   | 科创50  | 588000      | 华夏科创50ETF        | 2023-06-05  |

## 2. 指标定义（后端只给原始量，前端计算滚动统计）

对每个标的、每个交易日：

```
成交PCR vol = 认沽成交量 / 认购成交量 = PUT_VOLUME / CALL_VOLUME
持仓PCR oi  = 认沽持仓量 / 认购持仓量 = LEAVES_PUT_QTY / LEAVES_CALL_QTY
```

滚动统计（前端按下拉窗口 N 现算，N ∈ {120, 250, 500}）：

- 中枢 `ma[i]` = 最近 N 个点（含当日）的算术均值，i < N-1 时为 null
- 标准差 `sd[i]` = 最近 N 个点的总体标准差（ddof=0），i < N-1 时为 null
- 上轨 `up[i] = ma[i] + k*sd[i]`，下轨 `dn[i] = ma[i] - k*sd[i]`，k ∈ {1.5, 2, 2.5}
- `z[i] = (v[i] - ma[i]) / sd[i]`（sd 为 0 时置 null）
- 稳健中枢 `med[i]` = 最近 N 个点的中位数；`mad[i]` = 中位数绝对偏差 × 1.4826
- 稳健 z `rz[i] = (v[i] - med[i]) / mad[i]`（mad 为 0 时置 null）
- 滚动分位 `pct[i]` = 最近 N 个点中 ≤ v[i] 的占比（0~100）
- 突破点：`z[i] >= k` 或 `z[i] <= -k`（在图上打红点）

## 3. `GET /api/data` 返回

```json
{
  "ok": true,
  "version": 1,
  "generated_at": "2026-10-20 21:12:03",
  "source": "上海证券交易所 · 股票期权每日统计",
  "source_url": "https://www.sse.com.cn/assortment/options/date/",
  "latest_trade_date": "2026-10-20",
  "days": 1641,
  "indices": [
    {
      "key": "hs300",
      "name": "沪深300",
      "code": "510300",
      "code_suffix": "510300.SH",
      "full_name": "华泰柏瑞沪深300ETF",
      "color": "#4fc3f7",
      "start": "2020-01-02",
      "end": "2026-10-20",
      "dates":   ["2020-01-02", "..."],
      "vol":     [0.5213, "..."],
      "oi":      [0.7534, "..."],
      "call_vol":[854202, "..."],
      "put_vol": [443736, "..."],
      "call_oi": [780781, "..."],
      "put_oi":  [587905, "..."]
    },
    { "key": "zz500", "name": "中证500", "code": "510500", "color": "#ffb74d", "...": "..." },
    { "key": "kc50",  "name": "科创50",  "code": "588000", "color": "#b388ff", "...": "..." }
  ],
  "extra_indices": [
    { "key": "sz50", "name": "上证50", "code": "510050", "color": "#8bc34a", "...": "同上结构" }
  ]
}
```

约定：

- `dates.length === vol.length === oi.length === call_vol.length ...`，日期升序，格式 `YYYY-MM-DD`（本地日，不含时区）。
- 各 index 的 `dates` **独立**（上市日不同），不要假设三个 index 等长或同日对齐。
- `vol` / `oi` 为 0~10 之间的浮点数，保留 4 位；缺失值用 `null`（不会出现在正常数据中）。
- 卡片与前端主图默认顺序：`hs300`、`zz500`、`kc50`（与 `indices` 数组顺序一致）。
- 颜色由后端下发，前端优先使用 `color` 字段。
- `extra_indices` 仅作参考（上证50），前端可不展示；但前端**不得**因该字段缺失而报错。

## 4. `POST /api/refresh`

后端行为：增量抓取缺失交易日（本地已缓存的日期不重复请求）→ 合并 `data/pcr_daily.csv`
→ 重新生成 `cache/dashboard.json`。同步执行，最长约 900 秒；并发请求返回 409。

成功：

```json
{ "ok": true, "elapsed": 3.4, "new_days": 1, "total_days": 1641,
  "latest_trade_date": "2026-10-20", "generated_at": "2026-10-20 21:12:03", "cached": false }
```

失败：`{ "ok": false, "error": "人能看懂的失败原因" }`，HTTP 500 或 409。
`409` 形如 `{ "ok": false, "busy": true, "running_seconds": 12.3, "error": "..." }`。

## 5. `GET /api/status`

```json
{ "ok": true, "exists": true, "mtime": "2026-10-20 21:12:03", "size_kb": 512.3,
  "building": { "active": false, "seconds": 0, "by": "" } }
```

## 6. 其它接口

- `GET /api/buildlog` → `{"ok":true,"exists":bool,"text":"最近约 6000 字符（约 6 KB）构建日志"}`
- `GET /favicon.ico` → 204
- 静态资源：`/`、`/assets/*`（no-cache）、`/vendor/*`（长缓存）

## 7. 前端自检挂钩（供自动化验证使用，不能省）

- `index.html` 里必须存在 `<div id="bootState" data-state="loading" data-msg=""></div>`
  （可 `display:none`）。页面初始化完成 → `data-state="ready"`；
  JS 运行期错误 → `data-state="error"` 且 `data-msg` 写错误摘要。
- `window.__PCR` 暴露：`{ready:bool, error:string|null, data:object|null, state:{index,metric,win,k}}`。
- URL hash 可复现界面状态，格式 `#idx=kc50&metric=oi&win=500&k=2&zoom=0.6,1`（zoom 为
  dataZoom start/end 百分比），刷新页面后状态一致。

---

# 期货升贴水看板（v2 增量，2026-10-20 追加）

> 同一页面内新增「期货升贴水」看板，数据独立走 `GET /api/futures`，与 `/api/data` 互不影响。
> 老接口的字段与语义**保持不变**。

## 8. 期货领域口径与数据来源

- 数据源：
  - 股指期货逐合约日线：新浪财经
    `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_{code}=/InnerFuturesNewService.getDailyKLine?symbol={code}`
    （已退市合约也能取到完整历史）。
  - 现货指数日线：新浪财经 `CN_MarketData.getKLineData`（000300 / 000905 / 000852 / 000016）。
  - 中金所产品目录与交割规则参考：`http://www.cffex.com.cn/sj/hqsj/rtj/`。
- **中金所目前只有 4 个股指期货品种：IF(沪深300) / IC(中证500) / IM(中证1000) / IH(上证50)，
  没有科创50 指数期货**。因此本看板不含科创50；页面必须显式说明这一点（不能默默少一个指数）。
- 合约代码 = 品种 + YYMM（`IF2611` = 沪深300 2026 年 11 月合约）；交割日 = 合约月第三个周五，
  遇节假日顺延到之后最近的交易日。
- 主力合约 = 当天有收盘价、未到期、剩余天数 ≥ 7 天的最近月合约；都不满足时取最近月未到期合约。
- 指标（每个品种、每个交易日，后端只给数值，前端算滚动统计）：

```
基差点数 basis      = 期货收盘 - 现货收盘                 （负 = 贴水）
基差率   basis_rate = (期货/现货 - 1) × 100               （%，负 = 贴水）
年化贴水 ann        = (现货 - 期货)/现货 × 365/剩余天数 × 100（%，正 = 贴水，负 = 升水）
```

> **历史章节**：本节对应早期「价位通道」口径，其中滚动窗口已由 §14（期货 v4：窗口 20/60/120、恒定到期 30 天年化）取代，仅供追溯。

滚动统计与 §2 完全一致：窗口 N ∈ {120,250,500}（已被 §14 的 20/60/120 取代），中枢 MA、总体标准差 σ、上/下轨 ±1.5σ/±2σ/±2.5σ、
`z`、稳健中枢/稳健 z、滚动分位、突破点判定规则不变（只是把 `vol/oi` 换成 `ann/basis_rate`）。

## 9. `GET /api/futures` 返回（`cache/futures.json`）

```json
{
  "ok": true, "version": 1,
  "generated_at": "2026-10-20 21:40:00",
  "source": "中国金融期货交易所 · 每日行情（合约日线，经新浪财经） + 现货指数日线（新浪财经）",
  "source_url": "http://www.cffex.com.cn/sj/hqsj/rtj/",
  "latest_trade_date": "2026-10-20",
  "first_trade_date": "2019-01-02",
  "days": 1523,
  "indices": [
    {
      "key": "hs300", "name": "沪深300", "color": "#4fc3f7",
      "product": "IF", "spot_code": "000300", "extra": false,
      "days": 1523, "start": "2019-01-02", "end": "2026-10-20",
      "dates": ["2019-01-02", "..."],
      "spot": [3016.0, "..."],
      "fut": [3021.4, "..."],
      "basis": [5.4, "..."],
      "basis_rate": [0.179, "..."],
      "ann": [-2.35, "..."],
      "latest": { "date": "2026-10-20", "spot": 4152.108, "fut": 4112.0,
                  "basis": -40.108, "basis_rate": -0.966, "ann": 11.38,
                  "code": "IF2611", "expiry": "2026-11-20", "dte": 31 }
    }
  ],
  "extra_keys": ["zz1000", "sz50"],
  "term_structure": {
    "trade_date": "2026-10-20",
    "indices": [
      { "key": "hs300", "name": "沪深300", "color": "#4fc3f7",
        "contracts": [
          { "code": "IF2611", "expiry": "2026-11-20", "dte": 31, "fut": 4112.0,
            "basis": -40.1, "basis_rate": -0.966, "ann": 11.38 }
        ] }
    ]
  },
  "notes": ["中金所目前只有 IF / IC / IM / IH …", "年化贴水率用日历天数年化 …"]
}
```

约定：
- `indices[].dates.length === spot.length === fut.length === basis.length === basis_rate.length === ann.length`，日期升序，`YYYY-MM-DD`。
- 各品种 `dates` 独立（IM 2022-07 才有），不要假设等长或同日对齐。
- `basis_rate` / `ann` 为百分比数值（如 `-0.966` 表示 -0.966%），保留 4 位小数；`basis` 为点数。
- 年化贴水 `ann = 0` 附近可能因剩余天数小而绝对值偏大；前端取景时按分位裁剪 y 轴即可。
- 数组顺序即卡片顺序：`hs300`、`zz500`、`zz1000`、`sz50`；`extra_keys` 标出「用户点名的 3 个之外」的品种。
- `term_structure.indices[].contracts` 按 `expiry` 升序，至少 1 个合约、最多 4 个。

## 10. `POST /api/refresh` 增加期货构建

- 刷新时后端依次执行：① `build_data.py --fetch`（期权 PCR，同 v1）② `fetch_futures.py`（增量抓指数 + 活跃合约）③ `build_futures.py`（重算 `cache/futures.json`）。
- 回包在 v1 字段基础上增加：

```json
{ "ok": true, "elapsed": 12.3, "new_days": 1, "total_days": 1641,
  "latest_trade_date": "2026-10-20", "generated_at": "…", "cached": false,
  "futures": { "ok": true, "elapsed": 6.8, "days": 1523, "latest_trade_date": "2026-10-20",
               "generated_at": "2026-10-20 21:40:00", "new_days": 1 } }
```

- 期货构建失败时：`ok` 仍可为 true（期权成功即可），但 `futures.ok=false` 且 `futures.error` 给中文原因；前端 toast 里合并展示。
- `GET /api/status` 增加 `"futures": {"exists": true, "mtime": "…", "size_kb": 322.1, "days": 1523}`。
- `GET /api/futures`（no-store）：存在返回 200 JSON；不存在返回 503 `{"ok":false,"error":"还没有期货数据，请点击「刷新数据」"}`。

---

# 期货口径 v3 修订：恒定到期（2026-10-21 追加）

> 原因：近月年化 `ann` 在剩余天数很少时被 `365/dte` 放大，且每次换月主力合约切换都会跳变
> （历史 95 次换月，跳变均值 6.6pp、中位数 5.3pp、最大 23.5pp），不适合直接做历史比较。
> 修法：增加「恒定到期 30 天」口径 `cm_*`，跟踪默认改用它；原始近月字段全部保留。

## 11. 新增口径与字段

```
恒定到期 30 天 cm_ann = 用相邻两个未到期合约的基差点数，按剩余日历天数线性插值到 30 天，再年化
                        ann_cm = -basis_cm / spot × 365/30 × 100      （%，正 = 贴水）
恒定到期基差率 cm_rate = basis_cm / spot × 100                        （%，负 = 贴水）
恒定到期基差点 cm_basis = 插值得到的基缺点数                          （点，负 = 贴水）

插值：tgt = 交易日 + 30 天；取 expiry <= tgt 的最近合约 lo 与 expiry >= tgt 的最近合约 hi：
   basis_cm = bas_lo + (bas_hi - bas_lo) × (30 - dte_lo) / (dte_hi - dte_lo)
   lo 与 hi 为同一合约（dte 恰为 30）时直接取该合约。
回退：当天所有合约剩余天数都 > 30（刚换月）时，若最近月剩余天数 <= 45，
   直接使用该最近月合约自身年化（mode="front"）；否则该日 cm_* 为 null。
```

- `cache/futures.json` 的 `version` 升到 **2**；顶层新增 `"cm_target": 30`。
- `indices[]` 新增（与 `dates` 等长的数组，算不出的日期为 `null`）：
  `"cm_days": 1831`、`"cm_basis": [...]`、`"cm_rate": [...]`、`"cm_ann": [...]`。
- `indices[].latest_cm` 新增对象（当天算不出时为 `null`）：

```json
{ "basis": -40.108, "basis_rate": -0.966, "ann": 11.3735,
  "mode": "front", "dte": 31, "lo": "", "hi": "IF2611",
  "lo_expiry": "", "hi_expiry": "2026-11-20" }
```

- 原字段 `dates/spot/fut/basis/basis_rate/ann/latest` **语义不变**，仍为近月主力合约口径。
- `data/futures_daily.csv` 新增三列 `cm_basis, cm_rate, cm_ann`（算不出留空）。
- `definition` 新增 `cm_ann` 说明；`notes` 新增：cm 口径解释、分红季季节性、极端行情日说明。
- 生产校核（2026-10-20）：IF 近月 ann=11.3735、cm30=11.3735（回退 mode=front，dte=31）；
  历史 50 日窗口内最大单日变化：cm30=4.6pp vs 近月 ann=5.1pp；更早窗口内差距更大。

## 12. 前端约定（v3）

- 期货指标切换为三档：`cm`（cm_ann，**默认**）、`ann`（近月年化）、`basis_rate`（近月基差率）。
- 卡片大数字、MA/σ/±kσ、Z、稳健 Z、滚动分位，全部基于**当前指标选中序列**计算（默认 cm_ann）。
- 卡片底行固定展示近月实况：`近月 {latest.code} · 基差 {latest.basis:+.1f} 点 · 剩余 {latest.dte} 天 · {latest.expiry} 到期`，
  并在其后再给 `30D 年化 {latest_cm.ann:+.2f}%`（选中非 cm 指标时也可见）。
- hash：`fm=cm|ann|basis_rate`（缺省 = cm；兼容旧的 `fm=ann`/`fm=basis_rate`）。

---

# 期货看板 v4：多周期矩阵 + 多均线主图（2026-10-21 追加）

> 用户诉求：不要在 20/60/120 与「年化/近月」之间频繁点击，固定 cm30 口径，把短/中/长周期的
> 历史位置（滚动分位、稳健 Z）一次平铺出来；主图叠加 MA20/60/120；期限结构增加短端斜率连线。
> 本版本**只改期货 tab 的前端交互**，数据契约仅在 `term_structure` 上做向后兼容的字段追加。

## 13. `term_structure` 字段追加（向后兼容，version 仍为 2）

`term_structure.indices[i]` 新增：

```json
{ "key": "hs300", "name": "沪深300", "color": "#4fc3f7",
  "oi_max": "IF2612",        // 当日持仓量最大的在交易合约（通常=主力，移仓期可能已是次月）
  "next_quarter": "IF2703",  // 「持仓量最大合约」之后的最近季月合约（到期月∈{3,6,9,12}，且与其不同）
  "contracts": [
    { "code": "IF2611", "expiry": "2026-11-20", "dte": 30, "fut": 4076.2,
      "basis": -35.733, "basis_rate": -0.869, "ann": 10.5729,
      "oi": 45768.0,            // 持仓量（新浪日线 p 字段），缺失为 null
      "is_next_quarter": false }
  ] }
```

- 前端可用 `oi_max` + `next_quarter` 两个 code 在 `contracts` 里定位端点，画「短端结构斜率」高亮连线；
  斜率的展示口径建议：`Δann / Δ剩余月数`（pp/月），并在 tooltip 里给出两端合约、dte、ann、oi。
- `oi` 为当日持仓量（手），不保证历史；`oi_max`/`next_quarter` 在数据缺失时为 `null`。

## 14. 期货 tab 前端 v4（固定口径，无窗口/指标点击）

- **删除** 期货 toolbar 的「滚动窗口」「指标切换」「带宽」三组按钮；固定 `cm_ann`（恒定到期 30D 年化）与 `±2σ`。
- **保留** 品种芯片（4 个 + 禁用「科创50 无期货」）作为「主图焦点品种」选择；点击矩阵行也可切换焦点。
- **矩阵卡片**（行=品种，列=周期）：
  - 行首：色点 + 名称 + 代码（IF/IC/IM/IH）；当前值大字（`cm_ann` 最新值，2 位小数 + `%`）。
  - 对每个周期 N ∈ {20, 60, 120} 显示两行：`滚动分位`（0~100%，1 位）与 `稳健Z`（2 位带符号）。
  - 高亮：分位 >90% → 深红底/红字；分位 <10% → 深绿底/绿字；其余中性。稳健 Z 按正负着色即可。
  - 矩阵右上角显示数据日期：默认最新交易日，鼠标悬停主图时切换为悬停日并加「悬停」标识。
- **主图**：焦点品种 `cm_ann` 折线 + MA20 / MA60 / MA120 三条均线（不同颜色）+ 120 日 ±2σ 通道阴影（stacked area 实现），
  突破点可保留（相对 120 日 ±2σ）；dataZoom inside+slider 保留；tooltip 同时给出当日 cm_ann、三条 MA、分位/Z（各周期）。
- **悬停联动**：`updateAxisPointer`/`showTip` 时用 dataIndex 对应的日期更新矩阵三列数值；`globalout` 恢复最新日。
- **期限结构**：保留原图；新增「短端斜率」高亮连线（`oi_max` → `next_quarter`），焦点品种加粗、其余品种细线淡色；
  tooltip 显示两端 code/dte/ann/oi 与 pp/月。
- **不做** 期货 tab 的 Z 值副图（Z 信息已在矩阵里），主图纵轴按稳健分位截断（复用 zDisplayMax 思路，给 cm_ann 单独实现）。
- PCR tab 保持 v3 现状，不动。

---

# 期权 PCR v5 聚合口径（2026-10-22 追加）

> 变更范围：**仅前端呈现层**。`/api/data`、`/api/futures`、`cache/*.json`、`data/*.csv` 的 schema 与字段语义**完全不变**，
> 服务端不需要任何改动；下列指标全部由浏览器从 `indices[].dates/vol/oi` 现算，因此不写入 JSON 契约。

## 15. 派生指标定义

```
N 日分位(t)      = (区间 [t-N+1, t] 内 <= 当前值的样本个数) / N × 100
                  （含当日、并列值全部计入 <=；与 v1 起既有的滚动分位实现一致；样本不足 N 个 → 无值，前端显示 "—"）
spread(t)        = 成交PCR(t) − 持仓PCR(t)
差值 Z(t)        = (spread(t) − MA60(spread)(t)) / σ60(spread)(t)   σ 为总体标准差（ddof=0）
差值上/下轨      = MA60(spread)(t) ± 2σ60(spread)(t)                 （60 日布林带，仅 ±2σ）
背离区           = 满足 |差值 Z| ≥ 2 的极大连续区间（长度 ≥ 2 个交易日才绘制）；
                   按 spread 符号着色：成交 > 持仓 → 红（情绪高于筹码），
                   成交 < 持仓 → 绿（情绪低于筹码）；文字标签只标长度 ≥ 4 天的区间
情绪极值黄灯     = 最新交易日 |差值 Z| ≥ 2
```

- 情绪分位 = **成交 PCR 的 20 日分位**；筹码分位 = **持仓 PCR 的 250 日分位**（两者刻意不同周期）。
- 矩阵着色阈值（与实现一致，含等号）：分位 **≥ 85 → 红**；分位 **≤ 15 → 绿**；其余中性。
- 状态判定（按情绪分位 vs 筹码分位，取值域 高 ≥85 / 低 ≤15 / 中 其余）：

| 情绪 | 筹码 | code | 标签 | 副文案 | 色 |
| --- | --- | --- | --- | --- | --- |
| 高 | 低 | danger | 危险背离 | 情绪高涨 · 筹码不跟 | `#ef5350` |
| 高 | 高 | resonance | 情绪共振 | 量仓同热 | `#ffb74d` |
| 高 | 中 | panic_unconfirmed | 恐慌未确认 | 成交极端 · 筹码未动 | `#ff8a65` |
| 低 | 高 | chips_press | 筹码压制 | 成交冷 · 筹码集中 | `#ba68c8` |
| 低 | 低 | optimism | 乐观共振 | 量仓同冷 | `#26a69a` |
| 中 | 高 | chips_defense | 筹码防御 | 筹码集中 · 成交温和 | `#b39ddb` |
| 中 | 低 | chips_light | 筹码偏轻 | 筹码涣散 · 成交温和 | `#64b5f6` |
| 低 | 中 | warm | 情绪偏暖 | 成交偏冷 | `#81c784` |
| 中 | 中 | neutral | 中性 | 未见明显背离 | `#8b95a7` |
| 无值 | 无值 | na | — | 样本不足 | `#5f6b7d` |

## 16. 前端暴露（自动化钩子）

`window.__PCR = { ready, error, data, state:{idx, zoom}, hoverDate, matrix:[{
  key, name, code, color,
  vol:{ 20:Number|null, 60:…, 250:… },     // 成交 PCR 三周期滚动分位（百分数）
  oi:{  20:…, 60:…, 250:… },               // 持仓 PCR 三周期滚动分位
  spread, spreadZ, extreme:bool,
  status:{code,label,sub,color}
}] }`

- `hoverDate`：`'YYYY-MM-DD' | null`；`null` = 最新交易日。鼠标悬停期权 PCR 主图/差值图时，`matrix` 变为该日的
  分位/状态/差值快照，`hoverDate` 同步该日；移出图表、切换品种或刷新数据后恢复 `null` 与最新日快照。
- hash 只保留 `#idx=hs300|zz500|kc50&zoom=start,end`；旧的 `metric/win/k` 解析时忽略且不报错。
- 板块 tab 保留（`期权 PCR` / `期货升贴水`），期货板块仍按 v4 契约（§13/§14）工作。
