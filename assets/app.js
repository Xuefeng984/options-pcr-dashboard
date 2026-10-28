/* 期权 PCR 观测 · 期货升贴水 —— 前端逻辑（入口）
 *
 * 数据契约：DATA_CONTRACT.md（GET /api/data、GET /api/futures、POST /api/refresh、§7/§9/§10）
 * 视觉规格：docs/UI_SPEC.md（v1 §1–§6、v2 §7.1–§7.8）
 *
 * 设计要点：
 *  - 两个看板（期权 PCR / 期货升贴水）共用同一套滚动统计、图表配置、卡片与缩放联动代码；
 *    切换 tab 只切显示区块与 hash，不重载页面；两套数据各自缓存在内存。
 *  - /api/data 首屏必载；/api/futures 首次进入期货 tab 时懒加载（503 显示引导，不做离线 mock）。
 *  - 所有滚动统计（均值/总体标准差/z/中位数/MAD 稳健 z/滚动分位/突破点）都在浏览器端计算，
 *    切换指标、窗口、带宽、焦点时「零请求」。
 *  - 数据只在首次加载和点击「刷新数据」时请求。
 *  - mock 仅供期权 PCR 兜底（/api/data 不可用或 ?mock=1），真实数据加载成功后不渲染 mock。
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */
  var FONT = '"NotoSansSC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif';
  var COL = {
    up: '#ef5350',
    down: '#26a69a',
    blue: '#4fc3f7',
    orange: '#ffb74d',
    text: '#8b95a7',
    dim: '#5f6b7d',
    line: '#1f2633',
    lineSoft: 'rgba(31,38,51,0.7)',
    textMain: '#e8edf5',
    brk: '#ff5252'
  };
  // v5（UI_SPEC §10）：期权 PCR 板块取消指标/窗口/带宽切换，矩阵平铺 20/60/250 日滚动分位，
  // 主图双轨（成交PCR 快变量 + 持仓PCR 慢变量）+ 背离区，副图为差值布林通道。
  var PCR_WINS = [20, 60, 250];
  var PCR_MA_FAST = 20;        // 成交 PCR 的 MA20
  var PCR_MA_SLOW = 60;        // 持仓 PCR 的 MA60
  var PCR_SPREAD_WIN = 60;     // 差值 z 的窗口
  var PCR_DIV_Z = 2;           // |z| ≥ 2 的连续区间（≥2 个交易日）= 背离区；每个区间最多标 8 个文字标签
  var PCR_EXTREME_Z = 2;       // |z| ≥ 2 = 情绪极值（黄灯）
  var PCR_FAST_COLOR = { hs300: '#4fc3f7', zz500: '#ffb74d', kc50: '#b39ddb' };
  var PCR_SLOW_COLOR = '#b0bec5';   // 持仓 PCR（慢变量）：细实线，保证几千个日点下仍读得出连续走势
  var PCR_SLOW_MA_COLOR = '#607d8b';
  var PCR_SPREAD_COLOR = '#ffd54f';
  var PCR_DIV_RED = 'rgba(239,83,80,.15)';
  var PCR_DIV_GREEN = 'rgba(38,166,154,.14)';
  // v4（契约 §13/§14）：期货 tab 固定「恒定到期 30D 年化」口径 + 120 日 ±2σ 通道，
  // 不再提供指标/窗口/带宽切换；20/60/120 三周期的历史位置在矩阵里平铺。
  var FUT_WIN = 120;
  var FUT_K = 2;
  var FUT_MATRIX_WINS = [20, 60, 120];
  var FUT_METRIC = {
    label: '恒定到期 30D 年化', dp: 2, field: 'cm_ann',
    axis: '恒定到期 30D 年化 %（正=贴水）',
    note: '固定口径：相邻两合约基差按剩余日历天数插值到 30 天再年化（正=贴水）'
  };
  var FUT_NOTE = '中金所目前只有 IF / IC / IM / IH 四个股指期货品种，暂无科创50 指数期货，无法计算升贴水。';
  var FOOT_PCR = '口径：成交PCR = 认沽成交量 / 认购成交量（快变量）；持仓PCR = 认沽持仓量 / 认购持仓量（慢变量） · 上交所单市场口径 · 分位 = 最近 N 个交易日内 <= 当前值的样本占比（含当日） · 差值 z = (成交PCR − 持仓PCR − 60日中枢) / 60日标准差';
  var FOOT_FUT = '口径：恒定到期 30 天年化贴水 = 相邻两合约基差按剩余日历天数插值到 30 天再年化（正=贴水） · 基差 = 期货收盘 - 现货收盘；基差率 = (期货/现货 - 1) × 100% · 矩阵给出 20/60/120 日滚动分位与稳健 Z（中位数 + 1.4826×MAD） · 主图固定 120 日 ±2σ 通道 · 期限结构高亮「持仓量最大 → 下一季月」短端斜率';

  /* --------------------------------------------------------------- 运行时状态 */
  var state = {          // 期权 PCR 看板状态（v5：只剩焦点品种与缩放；__PCR.state = {idx, zoom}）
    index: '',
    zoom: [0, 100],
    refreshing: false,
    sample: false
  };
  var futState = {       // 期货 v4：固定 cm_ann + 120 日 ±2σ；只剩焦点品种、缩放与悬停日
    fidx: '',
    zoom: [0, 100],
    hoverDate: null,     // 主图悬停日（null = 最新交易日）
    hoverIdx: null
  };
  var pcrHoverDate = null; // 期权 PCR：主图/差值图悬停日（null = 最新交易日），同步进 __PCR.hoverDate
  var tab = 'pcr';       // 当前看板：pcr | fut

  var DATA = null;             // /api/data 完整对象
  var IDX = Object.create(null);        // PCR key -> index
  var statCache = Object.create(null);  // key|metric|win
  var seriesCache = Object.create(null);

  var FUTDATA = null;          // /api/futures 完整对象
  var FUTIDX = Object.create(null);
  var futStatCache = Object.create(null);
  var futSeriesCache = Object.create(null);
  var futLoading = null;
  var futError = null;
  var futPendingFidx = '';
  var futHashApplied = false;

  var charts = { main: null, spread: null, fut: null, term: null };
  var el = {};
  var syncing = false;
  var compactView = false;   // 窄屏/矮屏紧凑模式（1366x768 等）：压缩图表留白与坐标轴刻度
  var hashApplied = false;
  var hashTimer = null;
  var resizeTimer = null;
  var toastTimer = null;
  var loadingShown = false;
  var fontsRerendered = false;

  /* --------------------------------------------------------------- 基础工具 */
  function $(id) { return document.getElementById(id); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function fmt(v, dp) { return isNum(v) ? v.toFixed(dp == null ? 3 : dp) : '—'; }

  function fmtSigned(v, dp) {
    if (!isNum(v)) return '—';
    var s = v.toFixed(dp == null ? 2 : dp);
    return v > 0 ? '+' + s : s;
  }

  function fmtPct(v) { return isNum(v) ? v.toFixed(1) + '%' : '—'; }

  function round(v, dp) {
    var m = Math.pow(10, dp == null ? 4 : dp);
    return Math.round(v * m) / m;
  }

  // 坐标轴「漂亮刻度」：取 1/2/2.5/5×10^k 中最接近 raw 的档位
  function niceStep(raw) {
    if (!(raw > 0) || !isFinite(raw)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / p;
    var cands = [1, 2, 2.5, 5, 10];
    var best = cands[0], bestD = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var d = Math.abs(Math.log(cands[i] / f));
      if (d < bestD) { bestD = d; best = cands[i]; }
    }
    return best * p;
  }

  // 下一个更大的「漂亮刻度」（1 → 2 → 2.5 → 5 → 10 → …），用于把刻度格数压到上限内
  function niceStepUp(step) {
    if (!(step > 0) || !isFinite(step)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(step) / Math.LN10 + 1e-9));
    var f = Math.round((step / p) * 100) / 100;
    var seq = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < seq.length; i++) {
      if (seq[i] > f + 1e-9) return seq[i] * p;
    }
    return 10 * p;
  }

  // 紧凑模式：窄屏或矮屏（1366x768 等），压缩图表留白与刻度数量，保证一屏无纵向滚动
  function isCompactView() {
    if (typeof window === 'undefined') return false;
    var w = window.innerWidth || 1600;
    var h = window.innerHeight || 1000;
    return w <= 1440 || h <= 820;
  }

  function zColor(v) {
    if (!isNum(v)) return COL.text;
    return v >= 0 ? COL.up : COL.down;
  }


  function kLabel(k) { return String(k); }

  function errMsg(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function monthLabel(v) {
    if (v == null) return '';
    var d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v).replace(' ', 'T'));
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function sliderLabel(v) {
    if (typeof v === 'number') return monthLabel(v);
    if (typeof v === 'string' && v.length >= 7 && v.charAt(4) === '-') return v.slice(0, 7);
    return '';
  }

  function mmdd(dateStr) {
    return typeof dateStr === 'string' && dateStr.length >= 10 ? dateStr.slice(5) : String(dateStr || '');
  }

  /* --------------------------------------------------- §7：bootState / __PCR / __FUT */
  function syncPCR() {
    var p = window.__PCR;
    if (!p) { p = window.__PCR = { ready: false, error: null, data: null, state: {} }; }
    var st = el.boot ? el.boot.getAttribute('data-state') : 'loading';
    p.ready = st === 'ready';
    p.error = st === 'error' ? (el.boot.getAttribute('data-msg') || '') : null;
    p.data = DATA;
    p.state = { idx: state.index, zoom: state.zoom.slice() };
    p.matrix = pcrMatrixSnapshot(pcrHoverDate);
    p.hoverDate = pcrHoverDate;
    return p;
  }

  function syncFUT() {
    var f = window.__FUT;
    if (!f) { f = window.__FUT = { ready: false, error: null, data: null, state: {}, matrix: null, hoverDate: null }; }
    var st = el.boot ? el.boot.getAttribute('data-state') : 'loading';
    f.ready = !!FUTDATA && st === 'ready';
    f.error = futError || null;
    f.data = FUTDATA;
    f.state = { fidx: futState.fidx, date: latestFutDate() };
    f.matrix = futMatrixAt(futState.hoverDate || null);
    f.hoverDate = futState.hoverDate || null;
    return f;
  }

  function latestFutDate() {
    if (!FUTDATA || !FUTIDX[futState.fidx]) return null;
    var s = futSeriesOf(futState.fidx);
    return s && s.dates.length ? s.dates[s.dates.length - 1] : null;
  }

  function setBoot(st, msg) {
    if (!el.boot) return;
    el.boot.setAttribute('data-state', st);
    el.boot.setAttribute('data-msg', msg == null ? '' : String(msg));
    syncPCR();
    syncFUT();
  }

  /* --------------------------------------------------------------- 提示 / 遮罩 */
  function setLoading(on) {
    if (!el.loading) return;
    loadingShown = !!on;
    el.loading.classList.toggle('hide', !on);
  }

  function toast(msg, isErr) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.toggle('err', !!isErr);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, isErr ? 6000 : 3800);
  }

  function showToast(msg) { toast(msg, false); }

  function setBtnBusy(busy) {
    if (!el.btnRefresh) return;
    el.btnRefresh.disabled = !!busy;
    el.btnRefresh.classList.toggle('busy', !!busy);
    var txt = el.btnRefresh.querySelector('.txt');
    if (txt) txt.textContent = busy ? '刷新中…' : '刷新数据';
  }

  function showBootHint(html) {
    if (!el.bootHint) return;
    el.bootHint.innerHTML = html;
    el.bootHint.classList.remove('hide');
  }

  function hideBootHint() {
    if (el.bootHint) el.bootHint.classList.add('hide');
  }

  function showFutGuide(msg, isErr) {
    if (!el.futGuide) return;
    el.futGuide.innerHTML = '<b>' + esc(msg) + '</b>' +
      '<button type="button" class="mini-btn" data-action="refresh">立即刷新</button>';
    el.futGuide.classList.toggle('fut-err', !!isErr);
    el.futGuide.classList.remove('hide');
  }

  function hideFutGuide() {
    if (el.futGuide) el.futGuide.classList.add('hide');
  }

  /* --------------------------------------------------------------- 数据容器
   * 通用：seriesOf / statsOf / latestOf / lastValOf 同时服务期权（vol/oi）与期货（ann/basis_rate），
   * 字段名与指标名一致，因此不需要两套实现。
   */
  function seriesOf(idxMap, cache, key, metric, field) {
    var id = key + '|' + metric;
    var cached = cache[id];
    if (cached) return cached;
    var it = idxMap[key] || {};
    var dates = Array.isArray(it.dates) ? it.dates : [];
    var raw = it[field || metric];
    var outDates = [];
    var outVals = [];
    for (var i = 0; i < dates.length; i++) {
      var v = Array.isArray(raw) ? raw[i] : null;
      // cm 口径的历史缺失值（null）直接跳过：不画点、不当 0，统计只在有效值上滚动
      if (isNum(v)) { outDates.push(dates[i]); outVals.push(v); }
    }
    var s = { dates: outDates, vals: outVals, it: it };
    cache[id] = s;
    return s;
  }

  function baseSeries(key, metric) { return seriesOf(IDX, seriesCache, key, metric); }

  function lastVal(key, metric) {
    var b = baseSeries(key, metric);
    return b.vals.length ? b.vals[b.vals.length - 1] : null;
  }

  // 期货 v4：固定 cm_ann 序列；metric 参数仅为兼容旧调用（统一映射到 cm_ann）
  function futSeries(key, metric) { return seriesOf(FUTIDX, futSeriesCache, key, 'cm', 'cm_ann'); }
  function futSeriesOf(key) { return futSeries(key, 'cm'); }

  function futLastVal(key, metric) {
    var b = futSeries(key, metric);
    return b.vals.length ? b.vals[b.vals.length - 1] : null;
  }

  /* ------------------------------------------------------------------ 滚动统计
   * 窗口 N：均值 ma、总体标准差 sd、z=(v-ma)/sd、中位数 med、MAD=median|x-med|*1.4826、
   * 稳健 z=(v-med)/MAD、滚动分位 pct=最近 N 点中 <= v 的占比（0~100）。
   * 窗口内不足 N 点时对应值为 null（不画线、卡片显示 —）。
   */
  function rollingStats(vals, win) {
    var n = vals.length;
    var out = {
      ma: new Array(n), sd: new Array(n), z: new Array(n),
      med: new Array(n), mad: new Array(n), rz: new Array(n), pct: new Array(n)
    };
    for (var t = 0; t < n; t++) {
      out.ma[t] = null; out.sd[t] = null; out.z[t] = null;
      out.med[t] = null; out.mad[t] = null; out.rz[t] = null; out.pct[t] = null;
    }
    if (!n || !win || win < 2) return out;

    var q = [];
    var sum = 0, sum2 = 0;
    for (var i = 0; i < n; i++) {
      var v = vals[i];
      q.push(v); sum += v; sum2 += v * v;
      if (q.length > win) {
        var old = q.shift();
        sum -= old; sum2 -= old * old;
      }
      if (q.length < win) continue;

      var mean = sum / win;
      var variance = sum2 / win - mean * mean;
      var sd = variance > 1e-12 ? Math.sqrt(variance) : 0;
      out.ma[i] = mean;
      out.sd[i] = sd;
      out.z[i] = sd > 0 ? (v - mean) / sd : null;

      // 中位数 / MAD：窗口排序一次
      var s = q.slice().sort(function (a, b) { return a - b; });
      var med = (win % 2) ? s[(win - 1) >> 1] : (s[win / 2 - 1] + s[win / 2]) / 2;
      out.med[i] = med;
      var dev = new Array(win);
      for (var j = 0; j < win; j++) dev[j] = Math.abs(s[j] - med);
      dev.sort(function (a, b) { return a - b; });
      var mad = (win % 2) ? dev[(win - 1) >> 1] : (dev[win / 2 - 1] + dev[win / 2]) / 2;
      mad *= 1.4826;
      out.mad[i] = mad;
      out.rz[i] = mad > 0 ? (v - med) / mad : null;

      // 滚动分位：sorted 数组里 <= v 的个数（upper bound）
      var lo = 0, hi = win;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (s[mid] <= v) lo = mid + 1; else hi = mid;
      }
      out.pct[i] = lo / win * 100;
    }
    return out;
  }

  function statsOf(idxMap, seriesCacheObj, statCacheObj, key, metric, win, field) {
    var ck = key + '|' + metric + '|' + win;
    var st = statCacheObj[ck];
    if (st) return st;
    var b = seriesOf(idxMap, seriesCacheObj, key, metric, field);
    st = rollingStats(b.vals, win);
    st.dates = b.dates;
    st.vals = b.vals;
    st.it = b.it;
    statCacheObj[ck] = st;
    return st;
  }

  function latestOf(idxMap, seriesCacheObj, statCacheObj, key, metric, win, field) {
    var st = statsOf(idxMap, seriesCacheObj, statCacheObj, key, metric, win, field);
    var n = st.vals.length;
    if (!n) return null;
    var i = n - 1;
    return {
      i: i,
      date: st.dates[i],
      v: st.vals[i],
      ma: st.ma[i],
      sd: st.sd[i],
      z: st.z[i],
      med: st.med[i],
      mad: st.mad[i],
      rz: st.rz[i],
      pct: st.pct[i]
    };
  }

  function getStats(key, metric, win) { return statsOf(IDX, seriesCache, statCache, key, metric, win); }
  function latestStats(key, metric, win) { return latestOf(IDX, seriesCache, statCache, key, metric, win); }
  function futStats(key) { return statsOf(FUTIDX, futSeriesCache, futStatCache, key, 'cm', FUT_WIN, 'cm_ann'); }
  function futStatsWin(key, win) { return statsOf(FUTIDX, futSeriesCache, futStatCache, key, 'cm', win, 'cm_ann'); }

  /* 周期矩阵数据：每品种 {cm, p20, z20, p60, z60, p120, z120}；date=null 取最新，
   * 各品种交易日长度不同，按日期定位（取 <= date 的最后一个交易日）。 */
  function futMatrixAt(date) {
    var out = Object.create(null);
    var keys = futKeys();
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var base = futSeriesOf(key);
      var i = date ? idxAtOrBefore(base.dates, date) : base.vals.length - 1;
      var row = { cm: null, p20: null, z20: null, p60: null, z60: null, p120: null, z120: null };
      (function (row2, i2, key2) {
        if (i2 >= 0 && i2 < base.vals.length) row2.cm = base.vals[i2];
        FUT_MATRIX_WINS.forEach(function (w) {
          var st = futStatsWin(key2, w);
          if (i2 >= 0 && i2 < st.vals.length && st.rz[i2] != null) {
            row2['p' + w] = st.pct[i2];
            row2['z' + w] = st.rz[i2];
          }
        });
      })(row, i, key);
      out[key] = row;
    }
    return out;
  }

  function idxAtOrBefore(dates, date) {
    var lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (dates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function futMatrixSnapshot() {
    if (!FUTDATA) return null;
    return futMatrixAt(null);
  }

  function latestFutIdx() {
    var b = futSeriesOf(futState.fidx);
    return b && b.vals.length ? b.vals.length - 1 : null;
  }

  function futKeys() { return (FUTDATA && FUTDATA.indices ? FUTDATA.indices : []).map(function (x) { return x.key; }); }

  /* ---------------------------------------------------------------- URL hash
   * 期权：#idx=kc50&metric=oi&win=500&k=2&zoom=0.6,1
   * 期货：#tab=fut&fidx=hs300&fm=cm&win=250&k=2.5&zoom=0.6,1（fm=cm|ann|basis_rate，缺省 cm）
   * （zoom 为 dataZoom start/end 百分比）
   */
  function readHash() {
    var raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    var q = Object.create(null);
    raw.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i <= 0) return;
      try {
        q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
      } catch (e) { /* 忽略非法编码 */ }
    });
    return q;
  }

  function parseZoom(raw) {
    if (!raw) return null;
    var parts = String(raw).split(',');
    var a = parseFloat(parts[0]);
    var b = parseFloat(parts[1]);
    if (!isNum(a) || !isNum(b)) return null;
    if (a <= 1 && b <= 1) { a *= 100; b *= 100; }
    a = Math.max(0, Math.min(100, a));
    b = Math.max(0, Math.min(100, b));
    return (b - a >= 1) ? [a, b] : null;
  }

  function applyHashState() {
    if (hashApplied) return;
    hashApplied = true;
    var q = readHash();
    if (!q) return;
    if (q.idx && IDX[q.idx]) state.index = q.idx;
    // v5：旧 hash 的 metric / win / k 一律忽略（不报错），只保留焦点与缩放
    if (q.tab === 'fut') return;
    var z = parseZoom(q.zoom);
    if (z) state.zoom = z;
  }

  function applyFutHashState(q0) {
    if (futHashApplied) return;
    futHashApplied = true;
    var q = q0 || readHash();
    if (!q || q.tab !== 'fut') return;
    if (q.fidx) { futPendingFidx = q.fidx; futState.fidx = q.fidx; }
    // v4：旧 hash 的 fm / win / k 一律忽略（不报错），只保留 fidx 与 zoom
    var z = parseZoom(q.zoom);
    if (z) futState.zoom = z;
  }

  function scheduleHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 220);
  }

  function writeHash() {
    hashTimer = null;
    var h;
    if (tab === 'fut') {
      h = '#tab=fut' +
        '&fidx=' + encodeURIComponent(futState.fidx || '') +
        '&zoom=' + zoomStr(futState.zoom);
    } else {
      h = '#idx=' + encodeURIComponent(state.index) +
        '&zoom=' + zoomStr(state.zoom);
    }
    if (location.hash === h) return;
    try {
      history.replaceState(null, '', h);
    } catch (e) {
      // file:// 等环境 history API 不可用，退化成直接改 hash
      location.hash = h;
    }
  }

  function zoomStr(z) {
    return String(+(z[0] / 100).toFixed(2)) + ',' + String(+(z[1] / 100).toFixed(2));
  }

  /* ------------------------------------------------------------------ 图表配置 */
  function insideZoom(zoom) {
    return {
      type: 'inside',
      xAxisIndex: 0,
      start: zoom[0],
      end: zoom[1],
      throttle: 50,
      zoomOnMouseWheel: true,
      moveOnMouseMove: true,
      moveOnMouseWheel: false
    };
  }

  function sliderZoom(zoom, bottom, height) {
    return {
      type: 'slider',
      xAxisIndex: 0,
      start: zoom[0],
      end: zoom[1],
      bottom: bottom,
      height: height,
      left: 6,
      right: 58,
      borderColor: COL.line,
      backgroundColor: '#141a26',
      fillerColor: 'rgba(79,195,247,0.08)',
      handleStyle: { color: '#4fc3f7', borderColor: '#2f6d8f' },
      handleSize: '100%',
      moveHandleSize: 6,
      moveHandleStyle: { color: '#2c3e55' },
      dataBackground: {
        lineStyle: { color: '#243044', width: 1 },
        areaStyle: { color: 'rgba(36,48,68,0.5)' }
      },
      selectedDataBackground: {
        lineStyle: { color: '#3f6d8f', width: 1 },
        areaStyle: { color: 'rgba(63,109,143,0.18)' }
      },
      textStyle: { color: COL.dim, fontSize: 10 },
      labelFormatter: sliderLabel,
      brushSelect: false
    };
  }

  function ttRow(label, val, color) {
    return '<div style="display:flex;justify-content:space-between;gap:26px;line-height:20px;font-size:12px">' +
      '<span style="color:' + COL.text + '">' + label + '</span>' +
      '<span style="color:' + (color || COL.textMain) + ';font-variant-numeric:tabular-nums">' + val + '</span>' +
      '</div>';
  }

  function ttTitle(date) {
    return '<div style="font-size:11px;color:' + COL.dim + ';margin-bottom:4px;letter-spacing:.3px">' + date + '</div>';
  }

  function emptyOption(msg) {
    return {
      animation: false,
      title: {
        text: msg || '暂无数据',
        left: 'center',
        top: 'middle',
        textStyle: { color: COL.dim, fontSize: 13, fontWeight: 400, fontFamily: FONT }
      },
      xAxis: { show: false },
      yAxis: { show: false },
      series: []
    };
  }

  /* -------------------------------------------- v5：期权 PCR 板块构造器
   * 主图：成交 PCR（快变量，品种色实线）+ 持仓 PCR（慢变量，灰虚线）
   *       叠加 MA20（成交）/ MA60（持仓），并把「差值 z」的 |z|≥2 且连续 ≥2 日的区间涂成背离区
   * 副图：差值 = 成交 PCR − 持仓 PCR，附 MA20 与 ±2σ 布林通道；|差值 z| ≥ 2 为情绪极值（黄灯）
   */

  function pcrKeyColor(it) {
    var key = it && it.key;
    return PCR_FAST_COLOR[key] || (it && it.color) || COL.blue;
  }

  function pcrStats(key, metric, win) {
    return statsOf(IDX, seriesCache, statCache, key, metric, win);
  }

  // 当前值在最近 win 个交易日里的分位（upper-bound：窗口内 <= 当前值的样本数 / win × 100）
  function pctAtIndex(vals, i, win) {
    if (!isNum(i) || i < win - 1) return null;
    var v = vals[i];
    if (!isNum(v)) return null;
    var cnt = 0, from = i - win + 1;
    for (var j = from; j <= i; j++) if (isNum(vals[j]) && vals[j] <= v) cnt++;
    return cnt / win * 100;
  }

  // 成交 PCR 与持仓 PCR 的差值序列（两字段日期应完全一致；缺失值一律跳过）
  function pcrSpreadSeries(key) {
    var sv = baseSeries(key, 'vol');
    var so = baseSeries(key, 'oi');
    var mapOi = Object.create(null);
    var i;
    for (i = 0; i < so.dates.length; i++) mapOi[so.dates[i]] = so.vals[i];
    var dates = [], vol = [], oi = [], spread = [];
    for (i = 0; i < sv.dates.length; i++) {
      var d = sv.dates[i], a = sv.vals[i], b = mapOi[d];
      if (!isNum(a) || !isNum(b)) continue;
      dates.push(d); vol.push(a); oi.push(b);
      spread.push(round(a - b, 4));
    }
    return { dates: dates, vol: vol, oi: oi, spread: spread };
  }

  function pctOf(key, metric, win) {
    var st = pcrStats(key, metric, win);
    var n = st.pct.length;
    return n ? st.pct[n - 1] : null;
  }

  // 状态决策表（UI_SPEC §10.1）：分位阈值 85% / 15%
  function pcrStatus(vp, op) {
    var V = isNum(vp) ? vp : null;
    var O = isNum(op) ? op : null;
    if (V == null || O == null) return { code: 'na', label: '—', sub: '样本不足', color: COL.dim };
    if (V >= 85 && O <= 15) return { code: 'danger', label: '危险背离', sub: '情绪高涨 · 筹码不跟', color: COL.up };
    if (V >= 85 && O >= 85) return { code: 'resonance', label: '情绪共振', sub: '量仓同热', color: COL.orange };
    if (V >= 85) return { code: 'panic_unconfirmed', label: '恐慌未确认', sub: '成交极端 · 筹码未动', color: '#ff8a65' };
    if (V <= 15 && O >= 85) return { code: 'chips_press', label: '筹码压制', sub: '成交冷 · 筹码集中', color: '#ba68c8' };
    if (V <= 15 && O <= 15) return { code: 'optimism', label: '乐观共振', sub: '量仓同冷', color: COL.down };
    if (O >= 85) return { code: 'chips_defense', label: '筹码防御', sub: '筹码集中 · 成交温和', color: COL.purple };
    if (O <= 15) return { code: 'chips_light', label: '筹码偏轻', sub: '筹码涣散 · 成交温和', color: '#64b5f6' };
    if (V <= 15) return { code: 'warm', label: '情绪偏暖', sub: '成交偏冷', color: '#81c784' };
    return { code: 'neutral', label: '中性', sub: '未见明显背离', color: COL.text };
  }

  // 指定交易日的滚动分位（date=null → 最新日；窗口内样本不足返回 null，与最新日口径一致）
  function pctAt(key, metric, win, date) {
    var st = pcrStats(key, metric, win);
    var n = st.vals.length;
    if (!n) return null;
    var i = date ? idxAtOrBefore(st.dates, date) : n - 1;
    return (i >= 0 && isNum(st.pct[i])) ? st.pct[i] : null;
  }

  // 矩阵数据快照（同时供渲染与 window.__PCR.matrix 使用）：当前值、三周期分位、差值 z、状态
  // date=null 取最新交易日；否则取悬停日（各指标按自己的交易日序列定位到 <= date 的最后一天）
  function pcrMatrixSnapshot(date) {
    if (!DATA) return [];
    return (DATA.indices || []).filter(function (it) { return it && it.key; }).map(function (it) {
      var row = {
        key: it.key, name: it.name || it.key, code: it.code_suffix || '',
        color: pcrKeyColor(it), vol: {}, oi: {},
        spread: null, spreadZ: null, extreme: false
      };
      PCR_WINS.forEach(function (w) {
        row.vol[w] = pctAt(it.key, 'vol', w, date);
        row.oi[w] = pctAt(it.key, 'oi', w, date);
      });
      var sp = pcrSpreadSeries(it.key);
      var z = rollingStats(sp.spread, PCR_SPREAD_WIN).z;
      var iSp = sp.spread.length ? (date ? idxAtOrBefore(sp.dates, date) : sp.spread.length - 1) : -1;
      var lastZ = iSp >= 0 ? z[iSp] : null;
      row.spread = iSp >= 0 ? sp.spread[iSp] : null;
      row.spreadZ = isNum(lastZ) ? lastZ : null;
      row.extreme = isNum(lastZ) && Math.abs(lastZ) >= PCR_EXTREME_Z;
      row.status = pcrStatus(row.vol[PCR_WINS[0]], row.oi[PCR_WINS[2]]);
      return row;
    });
  }

  // 差值 z 的连续区间（|z| ≥ PCR_DIV_Z），返回区间下标与方向（1=情绪高于筹码 / -1=低于）
  function pcrDivergences(key, minLen) {
    var need = minLen == null ? 1 : minLen;
    var sp = pcrSpreadSeries(key);
    var z = rollingStats(sp.spread, PCR_SPREAD_WIN).z;
    var regs = [], i = 0;
    while (i < z.length) {
      if (isNum(z[i]) && Math.abs(z[i]) >= PCR_DIV_Z) {
        var dir = sp.spread[i] >= 0 ? 1 : -1;
        var j = i;
        while (j + 1 < z.length && isNum(z[j + 1]) && Math.abs(z[j + 1]) >= PCR_DIV_Z &&
               (sp.spread[j + 1] >= 0 ? 1 : -1) === dir) j++;
        if (j - i + 1 >= need) regs.push({ i0: i, i1: j, dir: dir });
        i = j + 1;
      } else i++;
    }
    return { sp: sp, z: z, regions: regs };
  }

  // 标签规则：每个背离区顶部标一次「背离 / 反向背离」，最多 8 个（避免长历史里标签互相压住）
  function pcrDivLabelSet(regions) {
    var set = Object.create(null), count = 0;
    for (var i = 0; i < regions.length; i++) {
      if (count < 8) { set[i] = 1; count++; }
    }
    return set;
  }

  /* 主图：成交 PCR + 持仓 PCR 双轨，MA20/MA60，背离区阴影 */
  function pcrMainOption() {
    var it = IDX[state.index] || {};
    var sv = baseSeries(state.index, 'vol');
    var so = baseSeries(state.index, 'oi');
    if (!sv.vals.length || !so.vals.length) return emptyOption('该指数暂无成交 / 持仓 PCR 数据');

    var color = pcrKeyColor(it);
    var volData = [], oiData = [], ma20Data = [], ma60Data = [];
    var mapVol = Object.create(null), mapOi = Object.create(null);
    var i;
    for (i = 0; i < sv.vals.length; i++) {
      mapVol[sv.dates[i]] = i;
      volData.push([sv.dates[i], round(sv.vals[i], 4)]);
    }
    for (i = 0; i < so.vals.length; i++) {
      mapOi[so.dates[i]] = i;
      oiData.push([so.dates[i], round(so.vals[i], 4)]);
    }
    var ma20 = movingAvg(sv.vals, PCR_MA_FAST);
    for (i = 0; i < ma20.length; i++) if (ma20[i] != null) ma20Data.push([sv.dates[i], round(ma20[i], 4)]);
    var ma60 = movingAvg(so.vals, PCR_MA_SLOW);
    for (i = 0; i < ma60.length; i++) if (ma60[i] != null) ma60Data.push([so.dates[i], round(ma60[i], 4)]);

    var dv = pcrDivergences(state.index, 2);
    var divName = '背离区 |z|≥' + PCR_DIV_Z;
    var labelSet = pcrDivLabelSet(dv.regions);
    // 自定义系列在 time 轴上必须用毫秒时间戳（传 'YYYY-MM-DD' 字符串会被映射到 1970 年，图形画出画布外）；
    // 另外 echarts 5.x custom series 的 params.data 不可靠（实测为 undefined），区间信息用 dataIndex 闭包取。
    var divRegions = dv.regions.slice();
    var divLabState = { di: -1, lastX: null, flip: 0, count: 0 };
    var tsOf = Object.create(null);
    (function () {
      var all = dv.sp.dates;
      for (var k = 0; k < all.length; k++) {
        var t = Date.parse(all[k] + 'T00:00:00');
        tsOf[all[k]] = isFinite(t) ? t : new Date(all[k]).getTime();
      }
    })();
    var divData = dv.regions.map(function (r) {
      // [时间戳, 成交PCR, i0, i1, dir]：前两维给坐标系，后三维供快照/自测读取区间信息
      return [tsOf[dv.sp.dates[r.i0]], round(dv.sp.vol[r.i0], 4), r.i0, r.i1, r.dir];
    });

    function renderDivisions(params, api) {
      var r = divRegions[params.dataIndex];
      if (!r) return null;
      // 标签避让状态：renderItem 每次重绘会按 dataIndex 递增调用，遇到回退即视为新的一轮
      if (params.dataIndex <= divLabState.di) {
        divLabState.di = -1; divLabState.lastX = null; divLabState.flip = 0; divLabState.count = 0;
      }
      divLabState.di = params.dataIndex;
      var sp = dv.sp, pts = [], m, c;
      for (m = r.i0; m <= r.i1; m++) {
        c = api.coord([tsOf[sp.dates[m]], sp.vol[m]]);
        if (c && isFinite(c[0]) && isFinite(c[1])) pts.push(c);
      }
      for (m = r.i1; m >= r.i0; m--) {
        c = api.coord([tsOf[sp.dates[m]], sp.oi[m]]);
        if (c && isFinite(c[0]) && isFinite(c[1])) pts.push(c);
      }
      if (pts.length < 3) return null;
      var children = [{
        type: 'polygon',
        shape: { points: pts },
        style: { fill: r.dir > 0 ? PCR_DIV_RED : PCR_DIV_GREEN, stroke: 'none' },
        silent: true
      }];
      // 只给 ≥4 个交易日的区间加标签；相邻标签水平距离 <48px 跳过；上下交替错位；最多 8 个
      var rlen = r.i1 - r.i0 + 1;
      if (rlen >= 4 && divLabState.count < 8) {
        var mid = Math.floor((r.i0 + r.i1) / 2);
        var top = Math.max(sp.vol[mid], sp.oi[mid]);
        var cm = api.coord([tsOf[sp.dates[mid]], top]);
        if (cm && isFinite(cm[0]) && isFinite(cm[1]) &&
            (divLabState.lastX == null || Math.abs(cm[0] - divLabState.lastX) >= 48)) {
          var above = (divLabState.flip % 2) === 0;
          divLabState.flip++;
          divLabState.count++;
          divLabState.lastX = cm[0];
          children.push({
            type: 'text',
            x: cm[0],
            y: above ? cm[1] - 6 : cm[1] + 6,
            style: {
              text: r.dir > 0 ? '背离' : '反向背离',
              fill: r.dir > 0 ? '#ff8a80' : '#5fd3c4',
              opacity: 0.85,
              font: '600 9px ' + FONT,
              align: 'center',
              verticalAlign: above ? 'bottom' : 'top'
            },
            silent: true
          });
        }
      }
      return { type: 'group', children: children };
    }

    var endBase = {
      show: true,
      distance: 6,
      fontSize: 11,
      fontWeight: 700,
      borderRadius: 4,
      padding: [3, 6],
      backgroundColor: '#1b2433',
      opacity: 1,
      textStyle: { color: '#f5f9ff', fontSize: 11, fontWeight: 700 }
    };

    // 主图 y 轴：显式 interval（nice 步长），保证 5~6 格且不重叠
    var mainVals = sv.vals.concat(so.vals);
    var mnM = Math.min.apply(null, mainVals);
    var mxM = Math.max.apply(null, mainVals);
    if (!isFinite(mnM) || !isFinite(mxM)) { mnM = 0; mxM = 1; }
    if (mxM - mnM < 1e-6) { mnM -= 0.5; mxM += 0.5; }
    var stepMain = niceStep((mxM - mnM) / 5);
    var yMinMain = round(Math.floor(mnM / stepMain) * stepMain, 4);
    var yMaxMain = round(Math.ceil(mxM / stepMain) * stepMain, 4);
    if ((yMaxMain - yMinMain) / stepMain < 3) {
      stepMain = niceStep((mxM - mnM) / 4);
      yMinMain = round(Math.floor(mnM / stepMain) * stepMain, 4);
      yMaxMain = round(Math.ceil(mxM / stepMain) * stepMain, 4);
    }

    var legendNames = ['成交 PCR', '持仓 PCR（慢变量）',
      'MA' + PCR_MA_FAST + '（成交）', 'MA' + PCR_MA_SLOW + '（持仓）', divName];

    var series = [
      {
        name: '成交 PCR',
        type: 'line',
        data: volData,
        showSymbol: false,
        smooth: false,
        connectNulls: false,
        lineStyle: { width: 2.2, color: color },
        itemStyle: { color: color },
        z: 5,
        endLabel: {
          show: true, distance: 6, fontSize: 11, fontWeight: 700, borderRadius: 4, padding: [3, 6],
          color: '#f5f9ff',
          backgroundColor: '#1b2433', borderColor: color, borderWidth: 1, opacity: 1,
          textStyle: { color: '#f5f9ff', fontSize: 11, fontWeight: 700 },
          formatter: function (p) { return fmt(p.value[1], 3); }
        }
      },
      {
        name: '持仓 PCR（慢变量）',
        type: 'line',
        data: oiData,
        showSymbol: false,
        smooth: false,
        connectNulls: false,
        sampling: 'lttb',
        lineStyle: { width: 1.6, color: PCR_SLOW_COLOR, opacity: 0.95 },
        itemStyle: { color: PCR_SLOW_COLOR },
        z: 4,
        endLabel: {
          show: true, distance: 6, fontSize: 11, fontWeight: 700, borderRadius: 4, padding: [3, 6],
          color: '#f5f9ff',
          backgroundColor: '#1b2433', borderColor: PCR_SLOW_COLOR, borderWidth: 1, opacity: 1,
          textStyle: { color: '#f5f9ff', fontSize: 11, fontWeight: 700 },
          formatter: function (p) { return fmt(p.value[1], 3); }
        }
      },
      {
        name: legendNames[2],
        type: 'line',
        data: ma20Data,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 1.2, color: color, opacity: 0.55 },
        itemStyle: { color: color },
        z: 3,
        silent: true
      },
      {
        name: legendNames[3],
        type: 'line',
        data: ma60Data,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 1.2, color: PCR_SLOW_MA_COLOR, type: [5, 4] },
        itemStyle: { color: PCR_SLOW_MA_COLOR },
        z: 3,
        silent: true
      },
      {
        name: divName,
        type: 'custom',
        renderItem: renderDivisions,
        data: divData,
        encode: { x: 0, y: 1 },
        clip: true,
        z: 1,
        silent: true,
        tooltip: { show: false }
      }
    ];

    function tooltipHtml(date) {
      var si = mapVol[date], sj = mapOi[date];
      var html = ttTitle(date);
      if (si != null) {
        var v = sv.vals[si];
        var s = pcrSpreadSeries(state.index);
        var spIdx = -1;
        for (var q = 0; q < s.dates.length; q++) if (s.dates[q] === date) { spIdx = q; break; }
        html += ttRow('成交 PCR', fmt(v, 3), color);
        if (sj != null) html += ttRow('持仓 PCR', fmt(so.vals[sj], 3), PCR_SLOW_COLOR);
        if (spIdx >= 0) {
          var zz = rollingStats(s.spread, PCR_SPREAD_WIN).z[spIdx];
          html += ttRow('差值（成交−持仓）', fmtSigned(s.spread[spIdx], 3), zColor(s.spread[spIdx]));
          if (isNum(zz)) html += ttRow('差值 Z', fmtSigned(zz, 2), zColor(zz));
        }
        PCR_WINS.forEach(function (w) {
          var pv = pctAtIndex(sv.vals, si, w);
          var po = pctAtIndex(so.vals, sj, w);
          html += ttRow('分位 成交/持仓 · ' + w + '日', fmtPct(pv) + ' / ' + fmtPct(po), COL.textMain);
        });
        var status = pcrStatus(pctAtIndex(sv.vals, si, PCR_WINS[0]), pctAtIndex(so.vals, sj, PCR_WINS[2]));
        html += ttRow('状态', status.label + (status.sub ? '（' + status.sub + '）' : ''), status.color);
      }
      return html;
    }

    return {
      animation: true,
      animationDuration: 220,
      animationDurationUpdate: 160,
      textStyle: { fontFamily: FONT, color: COL.text, fontSize: 12 },
      grid: compactView
        ? { left: 6, right: 50, top: 20, bottom: 26, containLabel: true }
        : { left: 6, right: 58, top: 30, bottom: 46, containLabel: true },
      legend: {
        data: legendNames,
        top: 0,
        right: 6,
        itemWidth: 14,
        itemHeight: 2,
        itemGap: 12,
        icon: 'roundRect',
        textStyle: { color: COL.text, fontSize: 11 },
        inactiveColor: '#39424f'
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#161c28',
        borderColor: '#2c3e55',
        borderWidth: 1,
        padding: [8, 11],
        textStyle: { color: COL.textMain, fontSize: 12 },
        axisPointer: {
          type: 'cross',
          crossStyle: { color: '#3a4a60', type: 'dashed' },
          lineStyle: { color: '#3a4a60', type: 'dashed' },
          label: { backgroundColor: '#1d2a3b', color: COL.textMain, fontSize: 11, borderColor: '#2c3e55' }
        },
        formatter: function (ps) {
          for (var i2 = 0; i2 < ps.length; i2++) {
            var v2 = ps[i2].value;
            if (v2 && v2.length === 2 && ps[i2].seriesType !== 'custom') return tooltipHtml(v2[0]);
          }
          return '';
        }
      },
      xAxis: {
        type: 'time',
        min: sv.dates[0],
        max: sv.dates[sv.dates.length - 1],
        boundaryGap: [0, 0],
        axisLine: { lineStyle: { color: COL.line } },
        axisTick: { show: false },
        axisLabel: { color: COL.text, fontSize: 11, hideOverlap: true, formatter: monthLabel },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: false,
        min: yMinMain,
        max: yMaxMain,
        interval: stepMain,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: COL.text, fontSize: compactView ? 10 : 11, formatter: function (v) { return v.toFixed(2); } },
        splitLine: { lineStyle: { color: COL.lineSoft } }
      },
      dataZoom: compactView
        ? [insideZoom(state.zoom), sliderZoom(state.zoom, 4, 12)]
        : [insideZoom(state.zoom), sliderZoom(state.zoom, 8, 22)],
      series: series
    };
  }

  /* 副图：差值（成交 PCR − 持仓 PCR）+ MA20 + ±2σ 布林通道；情绪极值黄灯 */
  function pcrSpreadOption() {
    var sp = pcrSpreadSeries(state.index);
    var n = sp.spread.length;
    if (!n) return emptyOption('该指数暂无差值数据');

    var color = PCR_SPREAD_COLOR;
    var ma = movingAvg(sp.spread, PCR_MA_FAST);
    var st = rollingStats(sp.spread, PCR_SPREAD_WIN);
    var map = Object.create(null);
    var data = [], maData = [], upData = [], dnData = [], absAll = [];
    var i;
    for (i = 0; i < n; i++) {
      map[sp.dates[i]] = i;
      data.push([sp.dates[i], round(sp.spread[i], 4)]);
      absAll.push(Math.abs(sp.spread[i]));
      if (ma[i] != null) maData.push([sp.dates[i], round(ma[i], 4)]);
      if (st.ma[i] != null && isNum(st.sd[i])) {
        var up = st.ma[i] + 2 * st.sd[i], dn = st.ma[i] - 2 * st.sd[i];
        upData.push([sp.dates[i], round(up, 4)]);
        dnData.push([sp.dates[i], round(dn, 4)]);
        absAll.push(Math.abs(up), Math.abs(dn));
      }
    }
    absAll.sort(function (a, b) { return a - b; });
    var p995 = absAll.length ? absAll[Math.min(absAll.length - 1, Math.ceil(0.995 * (absAll.length - 1)))] : 0.1;
    var yMax = Math.max(0.05, round(p995 * 1.1, 4));
    // 差值图 y 轴对称 + 显式 interval：目标 4~5 格，yMax 向上取到 step 的整数倍；
    // 若格数 > 5，则 step 升档（1/2/2.5/5×10^k 阶梯）直到格数落回 3~5
    var stepSp = niceStep((2 * yMax) / 4);
    if (!(stepSp > 0)) stepSp = 0.1;
    var yMaxSp = round(Math.ceil(yMax / stepSp) * stepSp, 4);
    for (var gi = 0; gi < 6; gi++) {
      var ivSp = Math.round((2 * yMaxSp) / stepSp);
      if (ivSp <= 5) break;
      stepSp = niceStepUp(stepSp);
      yMaxSp = round(Math.ceil(yMax / stepSp) * stepSp, 4);
    }
    if (!(yMaxSp > 0)) yMaxSp = 0.1;

    var areas = pcrDivergences(state.index, 2).regions.map(function (r) {
      return [{ xAxis: sp.dates[r.i0] }, { xAxis: sp.dates[r.i1] }];
    });

    var spreadName = '差值（成交−持仓）';
    var upName = '上轨 +2σ';
    var dnName = '下轨 -2σ';
    var maName = 'MA' + PCR_MA_FAST;

    return {
      animation: true,
      animationDuration: 220,
      animationDurationUpdate: 160,
      textStyle: { fontFamily: FONT, color: COL.text, fontSize: 12 },
      grid: compactView
        ? { left: 6, right: 50, top: 18, bottom: 22, containLabel: true }
        : { left: 6, right: 58, top: 26, bottom: 42, containLabel: true },
      legend: {
        data: [spreadName, maName, upName, dnName],
        top: 0,
        right: 6,
        itemWidth: 14,
        itemHeight: 2,
        itemGap: 12,
        icon: 'roundRect',
        textStyle: { color: COL.text, fontSize: 11 },
        inactiveColor: '#39424f'
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#161c28',
        borderColor: '#2c3e55',
        borderWidth: 1,
        padding: [8, 11],
        textStyle: { color: COL.textMain, fontSize: 12 },
        axisPointer: {
          type: 'cross',
          crossStyle: { color: '#3a4a60', type: 'dashed' },
          lineStyle: { color: '#3a4a60', type: 'dashed' },
          label: { backgroundColor: '#1d2a3b', color: COL.textMain, fontSize: 11, borderColor: '#2c3e55' }
        },
        formatter: function (ps) {
          var p0 = null;
          for (var i3 = 0; i3 < ps.length; i3++) {
            if (ps[i3].value && ps[i3].value.length === 2 && ps[i3].seriesName === spreadName) { p0 = ps[i3]; break; }
          }
          if (!p0) return '';
          var date = p0.value[0];
          var si = map[date];
          if (si == null) return ttTitle(date);
          var html = ttTitle(date);
          html += ttRow(spreadName, fmtSigned(sp.spread[si], 4), color);
          if (isNum(ma[si])) html += ttRow(maName, fmt(ma[si], 4), COL.text);
          if (isNum(st.ma[si]) && isNum(st.sd[si])) {
            html += ttRow(upName, fmt(st.ma[si] + 2 * st.sd[si], 4), COL.up);
            html += ttRow(dnName, fmt(st.ma[si] - 2 * st.sd[si], 4), COL.down);
          }
          var zz = st.z[si];
          html += ttRow('差值 Z', fmtSigned(zz, 2), zColor(zz));
          html += ttRow('状态', isNum(zz) && Math.abs(zz) >= PCR_EXTREME_Z ? '情绪极值' : (isNum(zz) && Math.abs(zz) >= PCR_DIV_Z ? '背离区' : '正常'),
            isNum(zz) && Math.abs(zz) >= PCR_EXTREME_Z ? COL.orange : COL.textMain);
          return html;
        }
      },
      xAxis: {
        type: 'time',
        min: sp.dates[0],
        max: sp.dates[n - 1],
        boundaryGap: [0, 0],
        axisLine: { lineStyle: { color: COL.line } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: false,
        min: -yMaxSp,
        max: yMaxSp,
        interval: stepSp,
        axisLine: { show: false },
        axisTick: { show: false },
        name: '差值（成交PCR − 持仓PCR）',
        nameLocation: 'end',
        nameGap: 8,
        nameTextStyle: { color: COL.dim, fontSize: 11, align: 'left' },
        axisLabel: {
          color: COL.text, fontSize: compactView ? 10 : 11,
          formatter: function (v) { return (v > 0 ? '+' : '') + v.toFixed(2); }
        },
        splitLine: { lineStyle: { color: COL.lineSoft } }
      },
      dataZoom: compactView
        ? [insideZoom(state.zoom), sliderZoom(state.zoom, 2, 10)]
        : [insideZoom(state.zoom), sliderZoom(state.zoom, 4, 18)],
      series: [
        {
          name: spreadName,
          type: 'line',
          data: data,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 2, color: color },
          itemStyle: { color: color },
          z: 5,
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: COL.dim, type: 'dashed', opacity: 0.6 },
            label: { show: false },
            data: [{ yAxis: 0 }]
          },
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(255,213,79,.10)' },
            data: areas
          }
        },
        {
          name: maName,
          type: 'line',
          data: maData,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 1.2, color: COL.text },
          itemStyle: { color: COL.text },
          z: 3,
          silent: true
        },
        {
          name: upName,
          type: 'line',
          data: upData,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 1.3, color: '#ef5350', type: [4, 3], opacity: 0.9 },
          itemStyle: { color: '#ef5350' },
          z: 2,
          silent: true
        },
        {
          name: dnName,
          type: 'line',
          data: dnData,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 1.3, color: '#26a69a', type: [4, 3], opacity: 0.9 },
          itemStyle: { color: '#26a69a' },
          z: 2,
          silent: true
        }
      ]
    };
  }

  /* ------------------------------------------- 期货升贴水：主图 / Z 图 option 组装 */
  function futRawAt(key, date) {
    var it = FUTIDX[key];
    if (!it || !Array.isArray(it.dates)) return null;
    var i = it.dates.indexOf(date);
    if (i < 0) return null;
    var isLatest = i === it.dates.length - 1;
    var latest = it.latest || {};
    return {
      basis: Array.isArray(it.basis) ? it.basis[i] : null,
      basis_rate: Array.isArray(it.basis_rate) ? it.basis_rate[i] : null,
      ann: Array.isArray(it.ann) ? it.ann[i] : null,
      cm_basis: Array.isArray(it.cm_basis) ? it.cm_basis[i] : null,
      cm_rate: Array.isArray(it.cm_rate) ? it.cm_rate[i] : null,
      cm_ann: Array.isArray(it.cm_ann) ? it.cm_ann[i] : null,
      code: isLatest ? (latest.code || '') : '',
      isLatest: isLatest
    };
  }

  function movingAvg(vals, n) {
    var out = [], sum = 0;
    for (var i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      out.push(i >= n - 1 ? sum / n : null);
    }
    return out;
  }

  function mainOptionFUT() {
    var it = FUTIDX[futState.fidx] || {};
    var focus = futSeriesOf(futState.fidx);
    if (!focus.vals.length) return emptyOption('该品种暂无恒定到期 30D 数据');
    var st = futStats(futState.fidx);
    var color = it.color || COL.blue;
    var dp = FUT_METRIC.dp;
    var dates = focus.dates, vals = focus.vals;
    var ma20 = movingAvg(vals, 20), ma60 = movingAvg(vals, 60), ma120 = st.ma;
    var upData = [], dnData = [], bandData = [], brkData = [], brkZ = [];
    for (var i = 0; i < vals.length; i++) {
      if (isNum(st.ma[i]) && isNum(st.sd[i])) {
        var u = st.ma[i] + FUT_K * st.sd[i], d = st.ma[i] - FUT_K * st.sd[i];
        upData.push([dates[i], round(u, 4)]);
        dnData.push([dates[i], round(d, 4)]);
        bandData.push([dates[i], round(u - d, 4)]);
        if (isNum(st.z[i]) && Math.abs(st.z[i]) >= FUT_K) {
          brkData.push([dates[i], round(vals[i], 4)]);
          brkZ.push(round(st.z[i], 3));
        }
      }
    }
    // 纵轴稳健截断：焦点序列 p0.5~p99.5 + 8% padding（极端行情不压扁通道）
    var yMin = null, yMax = null;
    if (vals.length > 24) {
      var sorted = vals.slice().sort(function (a, b) { return a - b; });
      function qAt(p) {
        var x = (sorted.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
        return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
      }
      var qLo = qAt(0.005), qHi = qAt(0.995);
      qLo = Math.min(qLo, vals[vals.length - 1]);
      qHi = Math.max(qHi, vals[vals.length - 1]);
      var pad = (qHi - qLo) * 0.08 || 0.5;
      yMin = round(qLo - pad, 4);
      yMax = round(qHi + pad, 4);
    }

    function pctRow(si) {
      var html = '';
      FUT_MATRIX_WINS.forEach(function (w) {
        var sw = futStatsWin(futState.fidx, w);
        if (si < sw.vals.length) {
          html += ttRow(w + '日 分位', fmtPct(sw.pct[si]), COL.textMain);
          html += ttRow(w + '日 稳健Z', fmtSigned(sw.rz[si], 2), zColor(sw.rz[si]));
        }
      });
      return html;
    }

    var legendData = [
      (it.name || futState.fidx) + ' ' + FUT_METRIC.label,
      'MA20', 'MA60', 'MA120',
      '±' + FUT_K + 'σ 通道（' + FUT_WIN + '日）',
      '突破点 |z|≥' + FUT_K
    ];

    return {
      backgroundColor: 'transparent',
      animation: false,
      textStyle: { fontFamily: FONT, color: COL.text },
      grid: { left: 6, right: 58, top: 34, bottom: 46, containLabel: true },
      legend: {
        data: legendData, top: 0, right: 6, itemWidth: 14, itemHeight: 2, itemGap: 12,
        icon: 'roundRect', textStyle: { color: COL.text, fontSize: 11 }, inactiveColor: '#39424f'
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross', crossStyle: { color: '#3a4a60' }, label: { backgroundColor: '#1d2a3b' } },
        backgroundColor: '#161c28', borderColor: COL.line, borderWidth: 1, padding: [8, 10],
        textStyle: { color: COL.textMain, fontSize: 12, fontFamily: FONT },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var si = ps[0].dataIndex;
          var date = dates[si];
          if (!date) return '';
          var html = ttTitle(date);
          html += ttRow(FUT_METRIC.label + ' %', fmt(vals[si], dp), color);
          html += ttRow('MA20', fmt(ma20[si], dp) + '%', '#b39ddb');
          html += ttRow('MA60', fmt(ma60[si], dp) + '%', '#ffb74d');
          html += ttRow('MA120', fmt(ma120[si], dp) + '%', '#81c784');
          html += '<div style="height:1px;background:' + COL.line + ';margin:4px 0"></div>';
          html += pctRow(si);
          return html;
        }
      },
      xAxis: {
        type: 'time', min: dates[0], max: dates[dates.length - 1], boundaryGap: [0, 0],
        axisLine: { lineStyle: { color: COL.line } }, axisTick: { show: false },
        axisLabel: { hideOverlap: true, fontSize: 11, color: COL.text, formatter: monthLabel },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value', name: FUT_METRIC.axis, scale: true, min: yMin, max: yMax, splitNumber: 5,
        nameTextStyle: { color: COL.dim, fontSize: 11, align: 'left' },
        axisLabel: { fontSize: 11, color: COL.text, formatter: function (v) { return v.toFixed(2); } },
        splitLine: { lineStyle: { color: COL.lineSoft } },
        axisLine: { show: false }, axisTick: { show: false }
      },
      dataZoom: [insideZoom(futState.zoom), sliderZoom(futState.zoom, 8, 22)],
      series: [
        {
          name: legendData[0], type: 'line', data: dates.map(function (d, k) { return [d, round(vals[k], 4)]; }),
          showSymbol: false, symbolSize: 5, lineStyle: { width: 1.6, color: color }, itemStyle: { color: color },
          z: 5, connectNulls: false,
          endLabel: {
            show: true, distance: 6, formatter: function (p) { return fmt(p.value[1], dp) + '%'; },
            color: COL.textMain, fontSize: 11, fontWeight: 700, backgroundColor: '#12161f',
            borderColor: color, borderWidth: 1, borderRadius: 4, padding: [3, 6]
          }
        },
        { name: 'MA20', type: 'line', data: dates.map(function (d, k) { return ma20[k] == null ? null : [d, round(ma20[k], 4)]; }), showSymbol: false, connectNulls: false, lineStyle: { width: 1.3, color: '#b39ddb' }, z: 3 },
        { name: 'MA60', type: 'line', data: dates.map(function (d, k) { return ma60[k] == null ? null : [d, round(ma60[k], 4)]; }), showSymbol: false, connectNulls: false, lineStyle: { width: 1.3, color: '#ffb74d' }, z: 3 },
        { name: 'MA120', type: 'line', data: dates.map(function (d, k) { return ma120[k] == null ? null : [d, round(ma120[k], 4)]; }), showSymbol: false, connectNulls: false, lineStyle: { width: 1.3, color: '#81c784' }, z: 4 },
        {
          name: '通道下界', type: 'line', stack: 'futband', data: dnData, showSymbol: false, silent: true,
          lineStyle: { width: 0, opacity: 0 }, areaStyle: { color: 'transparent' }, tooltip: { show: false }, z: 1
        },
        {
          name: '±' + FUT_K + 'σ 通道（' + FUT_WIN + '日）', type: 'line', stack: 'futband', data: bandData,
          showSymbol: false, silent: true, lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: 'rgba(239,83,80,0.17)' }, z: 1
        },
        { name: '上轨 +' + FUT_K + 'σ', type: 'line', data: upData, showSymbol: false, silent: true, lineStyle: { width: 1, type: 'dashed', color: COL.up, opacity: 0.55 }, z: 2 },
        { name: '下轨 -' + FUT_K + 'σ', type: 'line', data: dnData, showSymbol: false, silent: true, lineStyle: { width: 1, type: 'dashed', color: COL.up, opacity: 0.55 }, z: 2 },
        { name: '突破点 |z|≥' + FUT_K, type: 'scatter', data: brkData, symbolSize: 6, itemStyle: { color: COL.brk }, z: 6, tooltip: { show: false } }
      ]
    };
  }

  /* ------------------------------------------------- 期限结构图（贴水 vs 到期月） */
  function buildTermOption() {
    var ts = FUTDATA && FUTDATA.term_structure;
    if (!ts || !Array.isArray(ts.indices) || !ts.indices.length) return emptyOption('暂无期限结构数据');

    // 4 个品种的到期日并集（同年同月按日升序 → 字符串升序即可）
    var expirySet = Object.create(null);
    var labelAt = Object.create(null);   // 每个到期日取一个合约代码做轴标签
    ts.indices.forEach(function (ix) {
      (ix.contracts || []).forEach(function (c) {
        if (!c || !c.expiry) return;
        expirySet[c.expiry] = 1;
        if (!labelAt[c.expiry]) labelAt[c.expiry] = c.code || '';
      });
    });
    var cats = Object.keys(expirySet).sort();
    if (!cats.length) return emptyOption('暂无期限结构数据');
    var catIndex = Object.create(null);
    cats.forEach(function (c, i) { catIndex[c] = i; });

    var series = [];
    ts.indices.forEach(function (ix) {
      var byExp = Object.create(null);
      (ix.contracts || []).forEach(function (c) { if (c && c.expiry) byExp[c.expiry] = c; });
      var data = cats.map(function (exp) {
        var c = byExp[exp];
        if (!c || !isNum(c.ann)) return null;
        return {
          value: round(c.ann, 4),
          code: c.code, expiry: c.expiry, dte: c.dte,
          fut: c.fut, basis: c.basis, basis_rate: c.basis_rate, ann: c.ann,
          name: ix.name || ix.key, key: ix.key, color: ix.color || COL.blue
        };
      });
      series.push({
        name: ix.name || ix.key,
        type: 'line',
        data: data,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 7,
        smooth: false,
        connectNulls: false,
        clip: true,
        lineStyle: { width: 2, color: ix.color || COL.blue },
        itemStyle: { color: ix.color || COL.blue },
        emphasis: { disabled: true },
        z: 3
      });
    });

    // 短端斜率：持仓量最大合约 → 下一季月（焦点品种加粗 + 端点标签）
    var slopeName = '短端斜率（持仓量最大 → 下一季月）';
    var slopeData = [];
    ts.indices.forEach(function (ix) {
      var a = null, b = null;
      (ix.contracts || []).forEach(function (c) {
        if (!c) return;
        if (c.code === ix.oi_max) a = c;
        if (c.code === ix.next_quarter) b = c;
      });
      if (!a || !b || !isNum(a.ann) || !isNum(b.ann)) return;
      if (catIndex[a.expiry] == null || catIndex[b.expiry] == null) return;
      var months = (b.dte - a.dte) / 30.44;
      if (!(months > 0)) return;
      slopeData.push({
        value: [catIndex[a.expiry], a.ann, catIndex[b.expiry], b.ann],
        name: ix.name || ix.key,
        key: ix.key,
        focus: ix.key === futState.fidx,
        color: ix.color || COL.blue,
        fromCode: a.code, fromExpiry: a.expiry, fromDte: a.dte, fromAnn: a.ann, fromOi: a.oi,
        toCode: b.code, toExpiry: b.expiry, toDte: b.dte, toAnn: b.ann, toOi: b.oi,
        deltaAnn: b.ann - a.ann,
        deltaMonths: months,
        perMonth: (b.ann - a.ann) / months
      });
    });
    if (slopeData.length) {
      series.push({
        name: slopeName,
        type: 'custom',
        clip: true,
        z: 6,
        emphasis: { disabled: true },
        data: slopeData,
        renderItem: function (params, api) {
          var d = slopeData[params.dataIndex];
          if (!d) return null;
          var p1 = api.coord([d.value[0], d.value[1]]);
          var p2 = api.coord([d.value[2], d.value[3]]);
          if (!p1 || !p2) return null;
          var w = d.focus ? 2.4 : 1.2;
          var op = d.focus ? 0.95 : 0.42;
          var children = [{
            type: 'line',
            shape: { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] },
            style: { stroke: d.color, lineWidth: w, opacity: op },
            silent: true
          }];
          [p1, p2].forEach(function (p) {
            children.push({
              type: 'circle',
              shape: { cx: p[0], cy: p[1], r: d.focus ? 4 : 2.6 },
              style: { fill: d.color, opacity: d.focus ? 1 : 0.5 },
              silent: true
            });
          });
          if (d.focus) {
            var oiText = function (v) {
              return isNum(v) ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—';
            };
            children.push({
              type: 'text',
              style: {
                x: p1[0] - 8, y: p1[1] - 11,
                text: d.fromCode + ' · oi ' + oiText(d.fromOi),
                fill: d.color,
                font: '700 10px ' + FONT,
                textAlign: 'right'
              },
              silent: true
            });
            children.push({
              type: 'text',
              style: {
                x: p2[0] + 8, y: p2[1] - 11,
                text: d.toCode + ' · oi ' + oiText(d.toOi),
                fill: d.color,
                font: '700 10px ' + FONT,
                textAlign: 'left'
              },
              silent: true
            });
            children.push({
              type: 'text',
              style: {
                x: (p1[0] + p2[0]) / 2, y: (p1[1] + p2[1]) / 2 - 10,
                text: fmtSigned(d.perMonth, 2) + ' pp/月',
                fill: d.color,
                font: '700 10px ' + FONT,
                textAlign: 'center'
              },
              silent: true
            });
          }
          return { type: 'group', children: children };
        }
      });
    }

    // 0 线：升水 / 贴水分界
    if (series.length) {
      series[0].markLine = {
        silent: true,
        symbol: 'none',
        animation: false,
        data: [{
          yAxis: 0,
          lineStyle: { color: COL.dim, type: 'dashed', opacity: 0.75, width: 1 },
          label: { show: true, position: 'end', formatter: '0（升水 / 贴水分界）', color: COL.text, fontSize: 10 }
        }]
      };
    }

    return {
      animation: true,
      animationDuration: 220,
      textStyle: { fontFamily: FONT, color: COL.text, fontSize: 12 },
      grid: { left: 6, right: 58, top: 34, bottom: 34, containLabel: true },
      legend: {
        data: ts.indices.map(function (ix) { return ix.name || ix.key; }).concat(slopeData.length ? [slopeName] : []),
        top: 0,
        right: 6,
        itemWidth: 14,
        itemHeight: 2,
        itemGap: 12,
        icon: 'roundRect',
        textStyle: { color: COL.text, fontSize: 11 },
        inactiveColor: '#39424f'
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#161c28',
        borderColor: '#2c3e55',
        borderWidth: 1,
        padding: [8, 11],
        textStyle: { color: COL.textMain, fontSize: 12 },
        axisPointer: {
          type: 'line',
          lineStyle: { color: '#3a4a60', type: 'dashed' },
          label: { backgroundColor: '#1d2a3b', color: COL.textMain, fontSize: 11, borderColor: '#2c3e55' }
        },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var cat = ps[0].axisValue;
          var html = ttTitle(cat + ' 到期');
          var slopeShown = Object.create(null);
          ps.forEach(function (pt) {
            var raw = pt.data;
            if (raw && raw.fromCode && !slopeShown[raw.key]) {
              // 短端斜率：以端点行呈现（同一品种只显示一次）
              slopeShown[raw.key] = 1;
              var cc = raw.color || COL.text;
              html += '<div style="margin-top:6px;font-size:12px">' +
                '<span style="color:' + cc + '">' + esc(raw.name || '') + ' 短端斜率</span>' +
                '<span style="color:' + COL.dim + '"> · ' + esc(raw.fromCode) + ' → ' + esc(raw.toCode) + '</span></div>' +
                '<div style="font-size:11px;line-height:18px;color:' + COL.text + '">' +
                fmt(raw.fromDte, 0) + 'd ' + fmtSigned(raw.fromAnn, 2) + '%（持仓 ' + fmt(raw.fromOi, 0) + ' 手）→ ' +
                fmt(raw.toDte, 0) + 'd ' + fmtSigned(raw.toAnn, 2) + '%（持仓 ' + fmt(raw.toOi, 0) + ' 手）' +
                '<br>Δ年化 ' + fmtSigned(raw.deltaAnn, 2) + 'pp · 斜率 ' + fmtSigned(raw.perMonth, 2) + ' pp/月</div>';
              return;
            }
            var d = pt.value;
            if (!d || typeof d !== 'object') return;
            var c = d.color || COL.text;
            html += '<div style="margin-top:5px;font-size:12px">' +
              '<span style="color:' + c + '">' + esc(pt.seriesName) + ' ' + esc(d.code || '') + '</span>' +
              '<span style="color:' + COL.dim + '"> · 剩余 ' + (isNum(d.dte) ? d.dte : '—') + ' 天</span></div>' +
              '<div style="font-size:11px;line-height:18px;color:' + COL.text + '">' +
              '期货 ' + fmt(d.fut, 1) + ' · 基差 ' + fmtSigned(d.basis, 1) + ' 点 · 基差率 ' + fmtSigned(d.basis_rate, 3) + '% · 年化贴水 ' + fmtSigned(d.ann, 2) + '%' +
              '</div>';
          });
          return html;
        }
      },
      xAxis: {
        type: 'category',
        data: cats,
        boundaryGap: true,
        axisLine: { lineStyle: { color: COL.line } },
        axisTick: { show: false },
        axisLabel: {
          color: COL.text,
          fontSize: 10,
          interval: 0,
          lineHeight: 14,
          formatter: function (cat) {
            return (labelAt[cat] || '') + '\n' + mmdd(cat);
          }
        },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitNumber: 5,
        name: '年化贴水率 %（正=贴水）',
        nameLocation: 'end',
        nameGap: 10,
        nameTextStyle: { color: COL.text, fontSize: 11, align: 'left' },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: COL.text, fontSize: 11, formatter: function (v) { return v.toFixed(2); } },
        splitLine: { lineStyle: { color: COL.lineSoft } }
      },
      series: series
    };
  }

  /* ------------------------------------------------------------- 期权 PCR 渲染 */
  function renderTabs() {
    if (!el.tabs || !DATA) return;
    var html = (DATA.indices || []).map(function (it) {
      if (!it || !it.key) return '';
      var on = it.key === state.index ? ' class="on"' : '';
      var tip = it.name + ' ' + (it.code_suffix || it.code || '') + (it.full_name ? ' · ' + it.full_name : '');
      return '<button type="button" data-key="' + esc(it.key) + '" title="' + esc(tip) + '"' + on + '>' +
        '<span class="swatch" style="background:' + esc(pcrKeyColor(it)) + '"></span>' +
        esc(it.name || it.key) +
        '</button>';
    }).join('');
    el.tabs.innerHTML = html;
  }

  function pcrPctHtml(key, metric, win, v) {
    var cls = '';
    if (isNum(v)) { if (v >= 85) cls = ' hot'; else if (v <= 15) cls = ' cold'; }
    var txt = isNum(v) ? Math.round(v) + '%' : '—';
    return '<span class="pm-pct' + cls + '" data-key="' + esc(key + '|' + metric + '|' + win) + '">' + txt + '</span>';
  }

  // 周期矩阵：3 行（品种）× [状态 pill | 成交 20/60/250 | 持仓 20/60/250 | 差值 z]
  function renderPcrMatrix() {
    if (!el.pcrMatrix || !DATA) return;
    var rows = pcrMatrixSnapshot(pcrHoverDate);
    var html = '<div class="pm-row pm-group">' +
        '<div class="pm-cell pm-idx">指数</div>' +
        '<div class="pm-cell pm-st">状态</div>' +
        '<div class="pm-cell pm-span3">成交 PCR 分位（快变量）</div>' +
        '<div class="pm-cell pm-span3">持仓 PCR 分位（慢变量）</div>' +
        '<div class="pm-cell pm-diff">差值 / 差值 Z</div>' +
      '</div>' +
      '<div class="pm-row pm-sub">' +
        '<div class="pm-cell"></div><div class="pm-cell"></div>' +
        PCR_WINS.map(function (w) { return '<div class="pm-cell">' + w + '日</div>'; }).join('') +
        PCR_WINS.map(function (w) { return '<div class="pm-cell">' + w + '日</div>'; }).join('') +
        '<div class="pm-cell"></div>' +
      '</div>';
    rows.forEach(function (r) {
      var st = r.status;
      html += '<div class="pm-row pm-body' + (r.key === state.index ? ' on' : '') +
          '" data-key="' + esc(r.key) + '" style="--c:' + esc(r.color) + '">' +
        '<div class="pm-cell pm-idx"><span class="dot"></span><b>' + esc(r.name) + '</b>' +
          '<span class="pm-code">' + esc(r.code) + '</span></div>' +
        '<div class="pm-cell pm-st"><span class="st-pill st-' + st.code + '" data-key="' +
          esc(r.key + '|status') + '">' + esc(st.label) + '</span>' +
          '<span class="pm-sub2">' + esc(st.sub) + '</span></div>' +
        PCR_WINS.map(function (w) {
          return '<div class="pm-cell">' + pcrPctHtml(r.key, 'vol', w, r.vol[w]) + '</div>';
        }).join('') +
        PCR_WINS.map(function (w) {
          return '<div class="pm-cell">' + pcrPctHtml(r.key, 'oi', w, r.oi[w]) + '</div>';
        }).join('') +
        '<div class="pm-cell pm-diff" data-key="' + esc(r.key + '|diff') + '">' +
          fmtSigned(r.spread, 3) + ' / ' + fmtSigned(r.spreadZ, 2) +
          (r.extreme ? ' <span class="pm-warn" title="情绪极值：|差值 z| ≥ ' + PCR_EXTREME_Z + '">⚠</span>' : '') +
        '</div>' +
      '</div>';
    });
    el.pcrMatrix.innerHTML = html;
    if (el.pcrMatrixDate) {
      var latest = (DATA && DATA.latest_trade_date) || '—';
      el.pcrMatrixDate.textContent = pcrHoverDate ? '悬停 ' + pcrHoverDate : '数据日期 ' + latest;
      el.pcrMatrixDate.classList.toggle('hover', !!pcrHoverDate);
    }
  }

  // 期权 PCR 悬停联动：矩阵分位/状态/差值跟随悬停日，移出恢复最新（与期货 v4 §9.2 行为一致）
  function onPcrHover(date) {
    if ((pcrHoverDate || null) === (date || null)) return;
    pcrHoverDate = date || null;
    renderPcrMatrix();
    syncPCR();
  }

  function renderPcrHead() {
    var it = IDX[state.index] || {};
    var sv = baseSeries(state.index, 'vol');
    var so = baseSeries(state.index, 'oi');
    var n = Math.max(sv.vals.length, so.vals.length);
    if (el.mainTitle) {
      el.mainTitle.textContent = (it.name || state.index) + ' · 成交 PCR vs 持仓 PCR（双轨背离）';
    }
    if (el.mainHint) {
      if (!n) {
        el.mainHint.textContent = '该指数暂无数据';
      } else {
        el.mainHint.textContent = '样本 ' + sv.dates[0] + ' ~ ' + sv.dates[sv.dates.length - 1] +
          '，共 ' + n + ' 个交易日 · 粗实线=成交 PCR（快变量），细实线=持仓 PCR（慢变量），MA20/MA60 为各自中枢；' +
          '红色阴影=情绪高于筹码 · 青色阴影=情绪低于筹码（差值 z 的 |z|≥' + PCR_DIV_Z + ' 连续区间，顶部标「背离 / 反向背离」）';
      }
    }
    if (el.spreadHint) {
      el.spreadHint.textContent = '差值 = 成交 PCR − 持仓 PCR · 黄灯 = |差值 z| ≥ ' + PCR_EXTREME_Z +
        '（窗口 ' + PCR_SPREAD_WIN + ' 日）· 与上图共享缩放';
    }
  }

  function initPCRCharts() {
    if (!charts.main && el.chartPcr) {
      charts.main = echarts.init(el.chartPcr, null, { renderer: 'canvas' });
      charts.main.on('datazoom', function (p) { onZoomEvent('pcr', 'main', p); });
      charts.main.on('updateAxisPointer', function (e) {
        var info = e && e.axesInfo && e.axesInfo[0];
        if (!info) return;
        var date = tsToDate(info.value);
        if (date) onPcrHover(date);
      });
      charts.main.on('showTip', function (e) {
        if (e && e.dataIndex != null) {
          var b = baseSeries(state.index, 'vol');
          var d = (e.dataIndex >= 0 && e.dataIndex < b.dates.length) ? b.dates[e.dataIndex] : null;
          if (d) onPcrHover(d);
        }
      });
      charts.main.on('globalout', function () { onPcrHover(null); });
    }
    if (!charts.spread && el.chartSpread) {
      charts.spread = echarts.init(el.chartSpread, null, { renderer: 'canvas' });
      charts.spread.on('datazoom', function (p) { onZoomEvent('pcr', 'spread', p); });
      charts.spread.on('updateAxisPointer', function (e) {
        var info = e && e.axesInfo && e.axesInfo[0];
        if (!info) return;
        var date = tsToDate(info.value);
        if (date) onPcrHover(date);
      });
      charts.spread.on('showTip', function (e) {
        if (e && e.dataIndex != null) {
          var sp = pcrSpreadSeries(state.index);
          var d = (e.dataIndex >= 0 && e.dataIndex < sp.dates.length) ? sp.dates[e.dataIndex] : null;
          if (d) onPcrHover(d);
        }
      });
      charts.spread.on('globalout', function () { onPcrHover(null); });
    }
  }

  function updateExtremeBadge(on) {
    if (!el.spreadBadge) return;
    if (on) {
      el.spreadBadge.textContent = '情绪极值 · |差值 z| ≥ ' + PCR_EXTREME_Z;
      el.spreadBadge.classList.remove('hide');
    } else {
      el.spreadBadge.textContent = '';
      el.spreadBadge.classList.add('hide');
    }
  }

  function renderPCRCharts() {
    if (!DATA) return;
    initPCRCharts();
    if (!charts.main || !charts.spread) return;
    compactView = isCompactView();
    var sv = baseSeries(state.index, 'vol');
    if (!sv.vals.length) {
      charts.main.setOption(emptyOption('该指数暂无数据'), true);
      charts.spread.setOption(emptyOption('该指数暂无数据'), true);
      updateExtremeBadge(false);
      return;
    }
    charts.main.setOption(pcrMainOption(), true);
    charts.spread.setOption(pcrSpreadOption(), true);
    var sp = pcrSpreadSeries(state.index);
    var z = rollingStats(sp.spread, PCR_SPREAD_WIN).z;
    var last = z.length ? z[z.length - 1] : null;
    updateExtremeBadge(isNum(last) && Math.abs(last) >= PCR_EXTREME_Z);
    fitCharts();
  }

  // 分段控件选中态：统一按「状态 → DOM」重写一次 class 字符串。
  // 不用 classList.toggle 的原因是它在异步渲染/深链恢复等路径上容易与静态默认态打架，
  // 直接写 class 属性可以保证无论渲染顺序如何，按钮高亮始终与 state 一致。
  function setSegOn(segId, attr, isOn) {
    var btns = document.querySelectorAll('#' + segId + ' button[' + attr + ']');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var on = !!isOn(b);
      var cs = String(b.getAttribute('class') || '').split(/\s+/);
      var kept = [];
      for (var j = 0; j < cs.length; j++) {
        if (cs[j] && cs[j] !== 'on') kept.push(cs[j]);
      }
      if (on) kept.push('on');
      b.setAttribute('class', kept.join(' '));
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderAll() {
    if (!DATA) return;
    updateHeader();
    renderTabs();
    renderPcrMatrix();
    renderPcrHead();
    renderPCRCharts();
    syncPCR();
    scheduleHash();
  }

  /* --------------------------------------------------------- 期货升贴水渲染 */
  function renderFutChips() {
    if (!el.futChips || !FUTDATA) return;
    var html = (FUTDATA.indices || []).map(function (it) {
      if (!it || !it.key) return '';
      var on = it.key === futState.fidx ? ' class="on"' : '';
      var tip = (it.name || it.key) + ' ' + (it.product || '') +
        (it.spot_code ? ' · 现货 ' + it.spot_code : '');
      return '<button type="button" data-fkey="' + esc(it.key) + '" title="' + esc(tip) + '"' + on + '>' +
        '<span class="swatch" style="background:' + esc(it.color || COL.blue) + '"></span>' +
        esc(it.name || it.key) +
        '<span class="sub">' + esc(it.product || '') + '</span>' +
        '</button>';
    }).join('');
    html += '<button type="button" class="off" disabled title="' + esc(FUT_NOTE) + '">科创50 无期货</button>';
    el.futChips.innerHTML = html;
  }

  /* v4 周期矩阵：4 行品种 × [当前值 cm_ann + 20/60/120 日的 分位 / 稳健Z] */
  function renderFutMatrix(date) {
    if (!el.futMatrix || !FUTDATA) return;
    var rows = futMatrixAt(date || null);
    var keys = (FUTDATA.indices || []).map(function (x) { return x.key; });
    var html = '<div class="m-row m-head">' +
      '<span class="m-name">品种</span>' +
      '<span class="m-cur-hd">当前值</span>' +
      FUT_MATRIX_WINS.map(function (w) { return '<span class="m-hd">' + w + '日</span>'; }).join('') +
      '</div>' +
      '<div class="m-row m-head m-sub">' +
      '<span class="m-name"></span>' +
      '<span class="m-cur-hd">30D 年化</span>' +
      FUT_MATRIX_WINS.map(function () { return '<span class="m-hd">分位 · 稳健Z</span>'; }).join('') +
      '</div>';
    (FUTDATA.indices || []).forEach(function (it) {
      if (!it || !it.key) return;
      var key = it.key;
      var r = rows[key] || {};
      var on = key === futState.fidx ? ' on' : '';
      html += '<div class="m-row' + on + '" data-key="' + esc(key) + '" style="--c:' + esc(it.color || COL.blue) + '">' +
        '<span class="m-name"><i class="dot" style="background:' + esc(it.color || COL.blue) + '"></i>' +
        esc(it.name || key) + '<span class="m-code">' + esc(it.product || '') + '</span></span>' +
        '<span class="m-cur" data-key="' + esc(key) + '|cm">' +
        (isNum(r.cm) ? fmtSigned(r.cm, FUT_METRIC.dp) + '%' : '—') + '</span>';
      FUT_MATRIX_WINS.forEach(function (w) {
        var p = r['p' + w], z = r['z' + w];
        var cls = 'm-cell';
        if (isNum(p)) { if (p > 90) cls += ' hot'; else if (p < 10) cls += ' cold'; }
        html += '<span class="' + cls + '">' +
          '<span class="m-pct" data-key="' + esc(key) + '|' + w + '|pct">' + fmtPct(p) + '</span>' +
          '<span class="m-rz ' + (isNum(z) ? (z >= 0 ? 'pos' : 'neg') : '') + '" data-key="' +
          esc(key) + '|' + w + '|rz">' + fmtSigned(z, 2) + '</span>' +
          '</span>';
      });
      html += '</div>';
    });
    el.futMatrix.innerHTML = html;
    if (el.matrixDate) {
      var latest = latestFutDate() || (FUTDATA.latest_trade_date || '—');
      el.matrixDate.textContent = date ? '悬停 ' + date : '数据日期 ' + latest;
      el.matrixDate.classList.toggle('hover', !!date);
    }
  }

  function futDateAt(i) {
    var b = futSeriesOf(futState.fidx);
    return (b && i >= 0 && i < b.dates.length) ? b.dates[i] : null;
  }

  function onFutHover(date) {
    if ((futState.hoverDate || null) === (date || null)) return;
    futState.hoverDate = date || null;
    renderFutMatrix(futState.hoverDate);
    syncFUT();
  }

  // 时间轴坐标（毫秒时间戳或 'YYYY-MM-DD' 字符串）→ 'YYYY-MM-DD'（本地时区）
  function tsToDate(ts) {
    if (typeof ts === 'string') return ts.slice(0, 10);
    if (!isNum(ts)) return null;
    var d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function renderFutHead() {
    if (!FUTDATA) return;
    var it = FUTIDX[futState.fidx] || {};
    var st = futStats(futState.fidx);
    var n = st.vals.length;
    if (el.futMainTitle) {
      el.futMainTitle.textContent = (it.name || futState.fidx) +
        ' · 恒定到期 30D 年化贴水通道（MA20/60/120，±' + FUT_K + 'σ@' + FUT_WIN + '日）';
    }
    if (el.futMainHint) {
      if (!n) {
        el.futMainHint.textContent = '该品种暂无恒定到期 30D 数据（旧缓存可能未包含）；点右上角刷新数据。';
      } else {
        var txt = '样本 ' + st.dates[0] + ' ~ ' + st.dates[n - 1] + '，共 ' + n + ' 个交易日 · ' +
          FUT_METRIC.note + ' · 悬停主图可查看历史位置，移出恢复最新';
        el.futMainHint.textContent = txt;
      }
    }
    if (el.futNote) el.futNote.title = FUT_NOTE;
  }

  function initFutCharts() {
    if (!charts.fut && el.chartFut) {
      charts.fut = echarts.init(el.chartFut, null, { renderer: 'canvas' });
      charts.fut.on('datazoom', function (p) { onZoomEvent('fut', 'main', p); });
      charts.fut.on('updateAxisPointer', function (e) {
        var info = e && e.axesInfo && e.axesInfo[0];
        if (!info) return;
        var date = tsToDate(info.value);
        if (date) onFutHover(date);
      });
      charts.fut.on('showTip', function (e) {
        if (e && e.dataIndex != null) {
          var d = futDateAt(e.dataIndex);
          if (d) onFutHover(d);
        }
      });
      charts.fut.on('globalout', function () { onFutHover(null); });
    }
  }

  function renderFutCharts() {
    if (!FUTDATA) return;
    initFutCharts();
    var st = futStats(futState.fidx);
    if (charts.fut) {
      charts.fut.setOption(st.vals.length ? mainOptionFUT() : emptyOption('该品种暂无恒定到期 30D 数据'), true);
    }
    if (!charts.term && el.chartTerm) {
      charts.term = echarts.init(el.chartTerm, null, { renderer: 'canvas' });
    }
    if (charts.term) charts.term.setOption(buildTermOption(), true);

    if (el.termTitle) {
      var td = (FUTDATA.term_structure && FUTDATA.term_structure.trade_date) || FUTDATA.latest_trade_date || '';
      el.termTitle.textContent = '贴水 vs 到期月' + (td ? ' · ' + td : '');
    }
    if (el.termHint) {
      var cnt = 0;
      (FUTDATA.term_structure && FUTDATA.term_structure.indices || []).forEach(function (ix) {
        cnt += (ix.contracts || []).length;
      });
      el.termHint.textContent = '横轴=到期时间，纵轴=年化贴水率%（正=贴水）；每个点是一个在交易合约（共 ' +
        cnt + ' 个）。高亮连线 = 短端斜率「持仓量最大 → 下一季月」，焦点品种加粗';
    }
  }

  function syncFutControls() {
    if (!el.futChips) return;
    var btns = el.futChips.querySelectorAll('button[data-fkey]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-fkey') === futState.fidx;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderFutAll() {
    if (!FUTDATA) return;
    updateHeader();
    renderFutChips();
    renderFutMatrix(futState.hoverDate);
    renderFutHead();
    renderFutCharts();
    syncFutControls();
    syncFUT();
    scheduleHash();
  }

  /* ------------------------------------------------------- 顶部信息 / 页脚 / tab */
  function updateHeader() {
    if (tab === 'fut') {
      if (el.srcLine) {
        el.srcLine.textContent = FUTDATA
          ? '数据来源：' + (FUTDATA.source || '中国金融期货交易所 · 每日行情')
          : '数据来源：中金所股指期货 · 合约日线 + 现货指数日线';
        if (FUTDATA && FUTDATA.source_url) el.srcLine.title = FUTDATA.source_url;
      }
      if (el.updated) {
        if (!FUTDATA) {
          el.updated.textContent = '期货数据加载中…';
        } else {
          var fp = [];
          fp.push('数据更新至 ' + (FUTDATA.latest_trade_date || '—'));
          if (FUTDATA.generated_at) fp.push('生成 ' + FUTDATA.generated_at);
          if (isNum(FUTDATA.days)) fp.push('共 ' + FUTDATA.days + ' 个交易日');
          el.updated.textContent = fp.join(' · ');
        }
      }
      return;
    }
    if (!DATA) return;
    if (el.srcLine) {
      el.srcLine.textContent = state.sample
        ? '数据来源：内置样例数据（实时接口不可用，勿作分析依据）'
        : '数据来源：' + (DATA.source || '上海证券交易所 · 股票期权每日统计');
      if (DATA.source_url && !state.sample) el.srcLine.title = DATA.source_url;
    }
    if (el.updated) {
      var parts = [];
      if (state.sample) parts.push('样例数据 · 非实时');
      else parts.push('数据更新至 ' + (DATA.latest_trade_date || '—'));
      if (DATA.generated_at && !state.sample) parts.push('生成 ' + DATA.generated_at);
      if (isNum(DATA.days)) parts.push('共 ' + DATA.days + ' 个交易日');
      el.updated.textContent = parts.join(' · ');
    }
  }

  function updateFootNote() {
    if (el.footNote) el.footNote.textContent = tab === 'fut' ? FOOT_FUT : FOOT_PCR;
  }

  function syncTabs() {
    if (!el.mainTabs) return;
    var btns = document.querySelectorAll('#mainTabs button[data-tab]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-tab') === tab;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function showPanes() {
    if (el.pcrPane) el.pcrPane.classList.toggle('hide', tab !== 'pcr');
    if (el.futPane) el.futPane.classList.toggle('hide', tab !== 'fut');
    syncTabs();
    syncFutControls();
    updateFootNote();
  }

  function resizeAll() {
    ['main', 'spread', 'fut', 'term'].forEach(function (key) {
      if (charts[key]) charts[key].resize();
    });
  }

  // 一屏自适应：先把两张图压到最小，量出剩余视口高度，再按 7:3 分配给主图 / 差值图。
  // 目的：1600×1000 / 1366×768 下矩阵 + 主图 + 差值图 + 页脚不出现纵向滚动条；
  // 更高视口自动长高（普通上限 440/260，紧凑上限 340/210）。
  // 内容底边（footer 底）：body 有 min-height:100vh，bodyHeight 恒等于视口，不能用来判断是否填满
  function contentBottom() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return 0;
    var f = document.getElementById('foot');
    if (!f && typeof document.querySelector === 'function') f = document.querySelector('footer');
    if (!f || typeof f.getBoundingClientRect !== 'function') return 0;
    var r = f.getBoundingClientRect();
    var b = r && r.bottom;
    return typeof b === 'number' && isFinite(b) ? b : 0;
  }

  function fitCharts() {
    var mainEl = el.chartPcr, spreadEl = el.chartSpread;
    if (!mainEl || !spreadEl || tab !== 'pcr') return;
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
    if (!(vh > 400)) return;
    var compact = isCompactView();
    // 目标：footer 底边 >= innerHeight - 6（1600x1000 填满），且 <= innerHeight - 6（1366x768 不出现滚动条）
    // 起始高度故意取上限附近：留出充足的「收缩」余量（1366x768 需压到主图 ~206）
    var START_MAIN = compact ? 300 : 340;
    var START_SPREAD = compact ? 170 : 180;
    var FLOOR_MAIN = compact ? 206 : 250;
    var FLOOR_SPREAD = compact ? 100 : 150;
    var MAX_MAIN = compact ? 300 : 440;
    var MAX_SPREAD = compact ? 170 : 260;
    var mainH = START_MAIN, spreadH = START_SPREAD;
    function apply() {
      mainEl.style.height = mainH + 'px';
      spreadEl.style.height = spreadH + 'px';
      resizeAll();
    }
    apply();
    var target = vh - 6;
    var last = contentBottom();
    // 没有真实布局（测试桩 / SSR）时不做像素拟合，保留初始高度
    if (!(last > 0)) return;
    for (var pass = 0; pass < 12; pass++) {
      last = contentBottom();
      var diff = target - last;
      if (Math.abs(diff) <= 2) break;
      if (diff > 0) {
        // 富余：按 7:3 长高，撞上限后把额度转给另一张
        var grow = Math.min(diff, (MAX_MAIN - mainH) + (MAX_SPREAD - spreadH));
        if (grow <= 0) break;
        var dMain = Math.min(Math.round(grow * 0.7), MAX_MAIN - mainH);
        var dSpread = Math.min(grow - dMain, MAX_SPREAD - spreadH);
        if (dSpread < grow - dMain) {
          var rest = Math.min(grow - dMain - dSpread, MAX_MAIN - mainH - dMain);
          if (rest > 0) dMain += rest;
        }
        if (dMain === 0 && dSpread === 0) break;
        mainH += dMain;
        spreadH += dSpread;
      } else {
        // 超高：紧凑模式先压差值图再压主图，直到 footer 进视口
        var over = -diff;
        var cutS = Math.min(over, spreadH - FLOOR_SPREAD);
        if (cutS > 0) { spreadH -= cutS; over -= cutS; }
        if (over > 0) {
          var cutM = Math.min(over, mainH - FLOOR_MAIN);
          if (cutM > 0) { mainH -= cutM; over -= cutM; }
        }
        if (cutS <= 0 && over > 0) break;
      }
      apply();
    }
    if (typeof console !== 'undefined' && console.log) {
      console.log('[PCR fit] innerHeight=' + vh + ' last=' + Math.round(contentBottom()) +
        ' target=' + target + ' mainH=' + mainH + ' spreadH=' + spreadH +
        ' compact=' + (compact ? '1' : '0'));
    }
  }

  function setTab(next) {
    if (next !== 'pcr' && next !== 'fut') return;
    if (next === tab) return;
    tab = next;
    showPanes();
    updateHeader();
    if (tab === 'fut') {
      if (!FUTDATA) {
        setLoading(true);
        loadFutures({ first: true }).then(function (ok) {
          setLoading(false);
          if (ok) { renderFutAll(); resizeAll(); }
        });
      } else {
        renderFutAll();
        resizeAll();
      }
    } else {
      resizeAll();
      fitCharts();
    }
    scheduleHash();
  }

  /* ------------------------------------------------------------------ 交互事件 */
  function onZoomEvent(kind, role, p) {
    if (syncing) return;
    var pair = kind === 'fut' ? [charts.fut, null] : [charts.main, charts.spread];
    var chart = role === 'spread' ? pair[1] : pair[0];
    var other = role === 'spread' ? pair[0] : pair[1];
    var zs = kind === 'fut' ? futState : state;
    if (!chart) return;
    var start = null, end = null;
    if (p && isNum(p.start) && isNum(p.end)) {
      start = p.start; end = p.end;
    } else {
      var opt = chart.getOption();
      var dz = opt && opt.dataZoom;
      if (!dz) return;
      for (var i = 0; i < dz.length; i++) {
        if (isNum(dz[i].start) && isNum(dz[i].end)) { start = dz[i].start; end = dz[i].end; break; }
      }
    }
    if (!isNum(start) || !isNum(end) || end <= start) return;
    if (Math.abs(zs.zoom[0] - start) < 0.01 && Math.abs(zs.zoom[1] - end) < 0.01) return;
    zs.zoom = [start, end];
    syncing = true;
    try {
      if (other) other.dispatchAction({ type: 'dataZoom', start: start, end: end });
    } finally {
      syncing = false;
    }
    scheduleHash();
  }

  function setPCRState(patch) {
    if (patch.index == null || !IDX[patch.index] || patch.index === state.index) return;
    state.index = patch.index;
    pcrHoverDate = null;   // 切品种后回到最新日
    renderAll();
  }

  function setFutState(patch) {
    var changed = false;
    if (patch.fidx != null && FUTIDX[patch.fidx] && patch.fidx !== futState.fidx) {
      futState.fidx = patch.fidx; changed = true;
    }
    if (!changed) return;
    futState.hoverDate = null;
    renderFutAll();
  }

  function onClickSeg(ev, attr, parse, apply) {
    var t = ev.target;
    var b = t && t.closest ? t.closest('button[' + attr + ']') : null;
    if (!b) return;
    var raw = b.getAttribute(attr);
    var val = parse ? parse(raw) : raw;
    var patch = {};
    patch[attr === 'data-metric' ? 'metric' :
      attr === 'data-fmetric' ? 'metric' :
      attr === 'data-win' ? 'win' : 'k'] = val;
    apply(patch);
  }

  function bindUI() {
    // tab 切换
    if (el.mainTabs) {
      el.mainTabs.addEventListener('click', function (ev) {
        var t = ev.target;
        var b = t && t.closest ? t.closest('button[data-tab]') : null;
        if (b) setTab(b.getAttribute('data-tab'));
      });
    }
    // 期权 PCR
    if (el.tabs) {
      el.tabs.addEventListener('click', function (ev) {
        var t = ev.target;
        var b = t && t.closest ? t.closest('button[data-key]') : null;
        if (b) setPCRState({ index: b.getAttribute('data-key') });
      });
    }
    if (el.pcrMatrix) {
      el.pcrMatrix.addEventListener('click', function (ev) {
        var t = ev.target;
        var r = t && t.closest ? t.closest('.pm-row[data-key]') : null;
        if (r) setPCRState({ index: r.getAttribute('data-key') });
      });
    }
    // 期货升贴水 v4：芯片选焦点；矩阵行同样选焦点
    if (el.futChips) {
      el.futChips.addEventListener('click', function (ev) {
        var t = ev.target;
        var b = t && t.closest ? t.closest('button[data-fkey]') : null;
        if (b) setFutState({ fidx: b.getAttribute('data-fkey') });
      });
    }
    if (el.futMatrix) {
      el.futMatrix.addEventListener('click', function (ev) {
        var t = ev.target;
        var r = t && t.closest ? t.closest('.m-row[data-key]') : null;
        if (r) setFutState({ fidx: r.getAttribute('data-key') });
      });
    }
    // 引导块里的「立即刷新」（事件委托，避免 innerHTML 后重新绑定）
    if (el.futGuide) {
      el.futGuide.addEventListener('click', function (ev) {
        var t = ev.target;
        var b = t && t.closest ? t.closest('.mini-btn') : null;
        if (b) onRefreshClick();
      });
    }
    if (el.btnRefresh) el.btnRefresh.addEventListener('click', onRefreshClick);
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
      var wantCompact = isCompactView();
      if (wantCompact !== compactView) { compactView = wantCompact; renderPCRCharts(); }
      fitCharts();
      resizeAll();
    }, 160);
    });
  }

  /* ------------------------------------------------------------------ 数据加载 */
  function loadMockData() {
    return new Promise(function (resolve, reject) {
      if (window.__PCR_MOCK) return resolve(window.__PCR_MOCK);
      var s = document.createElement('script');
      s.src = 'assets/mock-data.js';
      s.onload = function () {
        if (window.__PCR_MOCK) resolve(window.__PCR_MOCK);
        else reject(new Error('mock 数据为空'));
      };
      s.onerror = function () { reject(new Error('mock 文件 assets/mock-data.js 不存在')); };
      document.head.appendChild(s);
    });
  }

  function showDataError(e) {
    var msg = errMsg(e);
    setLoading(false);
    setBoot('error', msg);
    showBootHint(
      '<b>未能加载数据：' + esc(msg) + '</b><br>' +
      '请确认后端服务已启动（在项目目录运行 <b>python serve.py</b>，默认 http://127.0.0.1:8788/），' +
      '然后点击右上角「刷新数据」重试。<br>' +
      '若只想预览前端样式，可在地址后加 <b>?mock=1</b> 使用内置样例数据。'
    );
    toast('数据加载失败：' + msg, true);
  }

  function markReady() {
    setLoading(false);
    setBoot('ready', '');
    // 首屏/深链恢复的最后一道同步：无论异步数据到达顺序如何，控件高亮都与当前 state 对齐
    if (DATA) renderTabs();
    if (FUTDATA) syncFutControls();
  }

  function onData(j) {
    if (!j || !Array.isArray(j.indices) || !j.indices.length) {
      showDataError(new Error('返回数据缺少 indices'));
      return;
    }
    DATA = j;
    IDX = Object.create(null);
    statCache = Object.create(null);
    seriesCache = Object.create(null);
    pcrHoverDate = null;   // 新数据到达后回到最新日
    j.indices.forEach(function (it) { if (it && it.key) IDX[it.key] = it; });
    var keys = Object.keys(IDX);
    if (!keys.length) { showDataError(new Error('indices 为空')); return; }

    applyHashState();
    if (!IDX[state.index]) state.index = keys[0];
    if (state.metric !== 'oi' && state.metric !== 'vol') state.metric = 'vol';

    try {
      renderAll();
      hideBootHint();
    } catch (e) {
      showDataError(e);
      return;
    }

    if (tab === 'fut' && !FUTDATA) {
      // 首屏就落在期货 tab：等期货数据就绪再置 ready，让 bootState 语义覆盖两个数据源
      loadFutures({ first: true }).then(function (ok) {
        if (ok) markReady(); else setLoading(false);
      });
    } else {
      markReady();
    }
  }

  function loadData(opt) {
    opt = opt || {};
    if (!opt.silent) setLoading(true);
    var mockParam = /[?&]mock=1(&|$)/.test(location.search);

    if (mockParam) {
      return loadMockData().then(function (j) {
        state.sample = true;
        onData(j);
        toast('已加载内置样例数据（?mock=1 仅用于前端预览）', true);
      }).catch(function (e) {
        showDataError(e);
      }).then(function () { setLoading(false); });
    }

    return fetch('/api/data', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '接口返回 ok=false');
        if (!Array.isArray(j.indices) || !j.indices.length) throw new Error('返回数据缺少 indices');
        state.sample = false;
        onData(j);
      })
      .catch(function (e) {
        // 真实接口失败才回落 mock（console.warn + 页面可见标记，避免掩盖接口问题）
        console.warn('[PCR] /api/data 不可用，尝试回落内置样例数据：' + errMsg(e));
        return loadMockData().then(function (j) {
          state.sample = true;
          onData(j);
          toast('实时接口不可用，已回落到内置样例数据', true);
        }).catch(function () {
          showDataError(e);
        });
      })
      .then(function () { setLoading(false); });
  }

  /* ------------------------------------------------------------ 期货数据加载 */
  function loadFutures(opt) {
    opt = opt || {};
    if (FUTDATA && !opt.force) {
      if (tab === 'fut') renderFutAll();
      return Promise.resolve(true);
    }
    if (futLoading) return futLoading;

    futLoading = fetch('/api/futures', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 503) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            var e = new Error((j && j.error) || '还没有期货数据，请点击「刷新数据」');
            e.notReady = true;
            throw e;
          });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '接口返回 ok=false');
        if (!Array.isArray(j.indices) || !j.indices.length) throw new Error('返回数据缺少 indices');
        onFutData(j);
        return true;
      })
      .catch(function (e) {
        futError = errMsg(e);
        syncFUT();
        if (e && e.notReady) {
          showFutGuide(futError, false);
        } else {
          showFutGuide('期货数据加载失败：' + futError + '。请点击右上角「刷新数据」重试。', true);
          if (tab === 'fut') setBoot('error', futError);
        }
        return false;
      })
      .then(function (ok) {
        futLoading = null;
        return ok;
      });
    return futLoading;
  }

  function onFutData(j) {
    FUTDATA = j;
    FUTIDX = Object.create(null);
    futSeriesCache = Object.create(null);
    futStatCache = Object.create(null);
    futError = null;
    j.indices.forEach(function (it) { if (it && it.key) FUTIDX[it.key] = it; });
    var keys = Object.keys(FUTIDX);
    if (!keys.length) {
      showFutGuide('期货数据缺少 indices，请点击右上角「刷新数据」重试。', true);
      return;
    }
    applyFutHashState();
    if (!FUTIDX[futState.fidx]) {
      futState.fidx = (futPendingFidx && FUTIDX[futPendingFidx]) ? futPendingFidx : keys[0];
    }
    futState.hoverDate = null;
    hideFutGuide();
    renderFutAll();
    updateHeader();
    if (tab === 'fut') setBoot('ready', '');
    scheduleHash();
  }

  /* ------------------------------------------------------------------ 刷新数据 */
  function formatRefreshMsg(j, futInfo) {
    if (!futInfo) {
      var newDays = isNum(j.new_days) ? j.new_days : 0;
      var latest = j.latest_trade_date || (DATA && DATA.latest_trade_date) || '—';
      var elapsed = isNum(j.elapsed) ? j.elapsed.toFixed(1) : '?';
      return '刷新成功：新增 ' + newDays + ' 个交易日 · 最新 ' + latest + ' · 用时 ' + elapsed + 's';
    }
    var parts = [];
    parts.push('期权：新增 ' + (isNum(j.new_days) ? j.new_days : 0) + ' 日' +
      (isNum(j.total_days) ? '（共 ' + j.total_days + '）' : ''));
    if (futInfo.ok === false) {
      parts.push('期货：' + (futInfo.error || '构建失败'));
    } else {
      parts.push('期货：新增 ' + (isNum(futInfo.new_days) ? futInfo.new_days : 0) + ' 日' +
        (isNum(futInfo.days) ? '（共 ' + futInfo.days + '）' : ''));
    }
    if (isNum(j.elapsed)) parts.push('用时 ' + j.elapsed.toFixed(1) + 's');
    return parts.join(' · ');
  }

  function reloadFutures() {
    if (typeof fetch !== 'function') return Promise.resolve(false);
    return loadFutures({ force: true, quiet: true });
  }

  function onRefreshClick() {
    if (state.refreshing) return;
    state.refreshing = true;
    setBtnBusy(true);
    fetch('/api/refresh', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () {
          throw new Error('HTTP ' + res.status + '（响应不是 JSON）');
        }).then(function (j) {
          j.__status = res.status;
          return j;
        });
      })
      .then(function (j) {
        if (j && (j.busy || j.__status === 409)) {
          var txt = '数据正在后台构建' +
            (isNum(j.running_seconds) ? '（已运行 ' + j.running_seconds.toFixed(1) + ' 秒）' : '') +
            '，请稍后再试。';
          toast(txt, true);
          return;
        }
        if (!j || j.ok !== true) {
          throw new Error((j && j.error) || ('HTTP ' + (j && j.__status)));
        }
        var futInfo = j.futures || null;
        var msg = formatRefreshMsg(j, futInfo);
        var isErr = !!(futInfo && futInfo.ok === false);
        if (isErr) msg += ' · 期货：' + (futInfo.error || '构建失败，详见服务端日志');
        var jobs = [loadData({ silent: true })];
        if (FUTDATA || tab === 'fut') jobs.push(reloadFutures());
        return Promise.all(jobs).then(function () {
          toast(msg, isErr);
        });
      })
      .catch(function (e) {
        toast('刷新失败：' + errMsg(e), true);
      })
      .then(function () {
        state.refreshing = false;
        setBtnBusy(false);
      });
  }

  /* ------------------------------------------------------------------ 启动 */
  function rerenderForFonts() {
    if (fontsRerendered) return;
    fontsRerendered = true;
    fitCharts();
    resizeAll();
  }

  function init() {
    el = {
      boot: $('bootState'),
      bootHint: $('bootHint'),
      mainTabs: $('mainTabs'),
      pcrPane: $('pcrPane'),
      futPane: $('futPane'),
      tabs: $('tabs'),
      pcrMatrix: $('pcrMatrix'),
      pcrMatrixDate: $('pcrMatrixDate'),
      mainTitle: $('mainTitle'),
      mainHint: $('mainHint'),
      spreadHint: $('spreadHint'),
      spreadBadge: $('spreadBadge'),
      chartPcr: $('chartPcr'),
      chartSpread: $('chartSpread'),
      futChips: $('futChips'),
      futMatrix: $('futMatrix'),
      matrixDate: $('matrixDate'),
      futMainTitle: $('futMainTitle'),
      futMainHint: $('futMainHint'),
      chartFut: $('chartFut'),
      chartTerm: $('chartTerm'),
      termTitle: $('termTitle'),
      termHint: $('termHint'),
      futGuide: $('futGuide'),
      futNote: $('futNote'),
      footNote: $('footNote'),
      srcLine: $('srcLine'),
      updated: $('updated'),
      btnRefresh: $('btnRefresh'),
      toast: $('toast'),
      loading: $('loading')
    };

    window.__PCR = window.__PCR || { ready: false, error: null, data: null, state: {} };
    window.__FUT = window.__FUT || { ready: false, error: null, data: null, state: {} };
    syncPCR();
    syncFUT();
    setBoot('loading', '');

    var q0 = readHash();
    if (q0 && q0.tab === 'fut') {
      tab = 'fut';
      applyFutHashState(q0);
    }
    showPanes();
    updateHeader();

    setLoading(true);
    bindUI();
    loadData({ first: true });

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(rerenderForFonts).catch(function () {});
    }
  }

  window.addEventListener('error', function (ev) {
    setBoot('error', ev && (ev.message || ev.error) ? errMsg(ev.message || ev.error) : '脚本运行错误');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    setBoot('error', errMsg(ev && ev.reason));
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
