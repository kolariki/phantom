/**
 * Playbook scenario parser — turns the AI's freeform text fields like
 * "$79.520 - $79.560" or "$1,234.50" into numeric ranges the trigger watcher
 * can compare against the live mid price.
 *
 * Handles BOTH English (`,` thousands) and Spanish (`.` thousands) formats.
 * Used by:
 *   • Renderer's playbook trigger watcher
 *   • Renderer's SVG mini-chart that plots levels
 *   • Tests (this is the single source of truth so we can verify reliably)
 *
 * Browser-loadable (no Node deps).
 */

/**
 * Parse a price string into a number.
 *
 *   parseNum("$79,520")      → 79520    (English thousands)
 *   parseNum("$79.520")      → 79520    (Spanish thousands)
 *   parseNum("$1,234,567.89")→ 1234567.89
 *   parseNum("$79.5")        → 79.5     (decimal)
 *   parseNum("$0.05")        → 0.05
 *   parseNum("4% of capital")→ NaN
 */
function parseNum(s) {
  if (s == null) return NaN;
  const str = String(s).replace(/[\$\s]/g, '');

  // Pattern: leading 1-3 digits, then one or more groups of (sep + 3 digits),
  // optionally followed by a decimal (sep + 1-2 digits).
  //   "79.520"         → 79520
  //   "1,234,567.89"   → 1234567.89
  const grouped = str.match(/^(-?\d{1,3})((?:[.,]\d{3})+)([.,]\d{1,2})?$/);
  if (grouped) {
    const integer = grouped[1] + grouped[2].replace(/[.,]/g, '');
    const decimal = grouped[3] ? '.' + grouped[3].slice(1) : '';
    const n = parseFloat(integer + decimal);
    return isNaN(n) ? NaN : n;
  }

  // Plain number, possibly with a single comma → strip commas.
  return parseFloat(str.replace(/,/g, ''));
}

/**
 * Parse a "range" string like "$79,520 - $79,560" → [79520, 79560].
 * If only one price is given, returns [n, n].
 * Returns null if no number could be extracted.
 */
function parseRange(s) {
  if (!s) return null;
  const str = String(s);
  // Try range first.
  const r = str.match(/(\$?[\d.,]+)\s*[-–—]\s*(\$?[\d.,]+)/);
  if (r) {
    const a = parseNum(r[1]);
    const b = parseNum(r[2]);
    if (!isNaN(a) && !isNaN(b)) return [Math.min(a, b), Math.max(a, b)];
  }
  // Fall back to single price.
  const single = str.match(/\$[\d.,]+|(?:^|\s)[\d.,]+/);
  if (single) {
    const n = parseNum(single[0]);
    if (!isNaN(n)) return [n, n];
  }
  return null;
}

/**
 * Given a scenario object from the playbook parser, attach numeric ranges
 * for entry / SL / TPs so the watcher can use them.
 */
function attachNumericRanges(scenario) {
  return {
    ...scenario,
    entry_range: parseRange(scenario.entry),
    sl_value:    parseNum(scenario.sl),
    tp1_value:   parseNum(scenario.tp1),
    tp2_value:   parseNum(scenario.tp2),
    tp3_value:   parseNum(scenario.tp3)
  };
}

/**
 * Decide whether `mid` is inside a scenario's entry zone.
 * Adds a small tolerance (0.05% of mid) so the watcher doesn't miss the
 * trigger by a single tick on either side.
 */
function isEntryHit(scenario, mid) {
  if (!scenario || !scenario.entry_range) return false;
  const [lo, hi] = scenario.entry_range;
  const tol = mid * 0.0005;
  return mid >= (lo - tol) && mid <= (hi + tol);
}

/**
 * Build a list of "all interesting levels" (entry midpoints, SLs, TPs) so
 * the SVG mini-chart can plot them.
 */
function extractLevelsForChart(scenarios, criticalLevels) {
  const out = [];
  if (Array.isArray(criticalLevels)) {
    for (const lv of criticalLevels) {
      const n = parseNum(lv.price);
      if (!isNaN(n)) out.push({ price: n, role: lv.role || '', kind: 'level' });
    }
  }
  if (Array.isArray(scenarios)) {
    for (const s of scenarios) {
      const sn = (s.name || 'scn').slice(0, 16);
      const side = (s.action || '').toLowerCase();
      if (s.entry_range) {
        const mid = (s.entry_range[0] + s.entry_range[1]) / 2;
        out.push({ price: mid, role: sn + ' entry', kind: 'entry', side });
      }
      if (!isNaN(s.sl_value)) out.push({ price: s.sl_value, role: sn + ' SL',  kind: 'sl',  side });
      if (!isNaN(s.tp1_value))out.push({ price: s.tp1_value,role: sn + ' TP1', kind: 'tp',  side });
      if (!isNaN(s.tp2_value))out.push({ price: s.tp2_value,role: sn + ' TP2', kind: 'tp',  side });
      if (!isNaN(s.tp3_value))out.push({ price: s.tp3_value,role: sn + ' TP3', kind: 'tp',  side });
    }
  }
  return out;
}

/**
 * Parse a structured CONDITIONS block from the AI response. Each condition
 * is a line like:
 *   price_in:79100-79150
 *   taker_5m_below:0.85
 *   whale_sell_min_usd:300000
 *   candle_close_below:79080
 *   cvd_below:-1000000
 *
 * Returns an array of { op, params, label } objects ready for evaluation.
 */
function parseConditionLine(line) {
  if (!line) return null;
  const m = String(line).trim().match(/^-?\s*([a-z_0-9]+)\s*:\s*(.+)$/i);
  if (!m) return null;
  const op = m[1].toLowerCase();
  const rawParams = m[2].trim();
  // Range like "79100-79150"
  if (op === 'price_in' || op === 'price_between') {
    const r = rawParams.match(/(-?\$?[\d.,]+)\s*[-–—]\s*(-?\$?[\d.,]+)/);
    if (r) {
      const a = parseNum(r[1]); const b = parseNum(r[2]);
      if (!isNaN(a) && !isNaN(b)) return { op: 'price_in', params: { lo: Math.min(a, b), hi: Math.max(a, b) }, label: `Price ∈ $${Math.min(a, b)}-$${Math.max(a, b)}` };
    }
    return null;
  }
  // Single-number ops
  const n = parseNum(rawParams);
  if (isNaN(n)) return null;
  const labels = {
    price_above:         `Price > $${n}`,
    price_below:         `Price < $${n}`,
    taker_5m_above:      `Taker 5m > ${n}`,
    taker_5m_below:      `Taker 5m < ${n}`,
    taker_1h_above:      `Taker 1h > ${n}`,
    taker_1h_below:      `Taker 1h < ${n}`,
    cvd_above:           `CVD > $${n}`,
    cvd_below:           `CVD < $${n}`,
    whale_sell_min_usd:  `Whale SELL ≥ $${n}`,
    whale_buy_min_usd:   `Whale BUY ≥ $${n}`,
    candle_close_above:  `5m close > $${n}`,
    candle_close_below:  `5m close < $${n}`,
    funding_above:       `Funding > ${n}%`,
    funding_below:       `Funding < ${n}%`
  };
  if (!labels[op]) return null;
  return { op, params: { value: n }, label: labels[op] };
}

function parseConditionsBlock(text) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .map(parseConditionLine)
    .filter(Boolean);
}

/**
 * Evaluate one parsed condition against a market snapshot.
 * Returns { passed: bool, observed: string } so the UI can render ✓/✗ + actual value.
 *
 * snapshot shape:
 *   {
 *     mid:            number,           // current price
 *     taker_5m:       number,           // latest taker buy/sell ratio (5m)
 *     taker_1h:       number,
 *     cvd:            number,           // current CVD in USD
 *     whales_recent:  [{ side, notional_usd, seconds_ago }],
 *     candle_5m_close:number,           // close of the most recent COMPLETED 5m candle
 *     funding_pct:    number            // current funding rate (%)
 *   }
 */
function evaluateCondition(cond, s) {
  if (!cond || !s) return { passed: false, observed: '—' };
  const fmt = (v, p) => v == null || isNaN(v) ? '—' : (typeof p === 'number' ? v.toFixed(p) : '$' + Math.round(v));
  switch (cond.op) {
    case 'price_in': {
      const { lo, hi } = cond.params;
      if (s.mid == null) return { passed: false, observed: '—' };
      return { passed: s.mid >= lo && s.mid <= hi, observed: fmt(s.mid) };
    }
    case 'price_above':       return s.mid == null ? { passed: false, observed: '—' } : { passed: s.mid > cond.params.value,  observed: fmt(s.mid) };
    case 'price_below':       return s.mid == null ? { passed: false, observed: '—' } : { passed: s.mid < cond.params.value,  observed: fmt(s.mid) };
    case 'taker_5m_above':    return s.taker_5m == null ? { passed: false, observed: '—' } : { passed: s.taker_5m > cond.params.value, observed: fmt(s.taker_5m, 2) };
    case 'taker_5m_below':    return s.taker_5m == null ? { passed: false, observed: '—' } : { passed: s.taker_5m < cond.params.value, observed: fmt(s.taker_5m, 2) };
    case 'taker_1h_above':    return s.taker_1h == null ? { passed: false, observed: '—' } : { passed: s.taker_1h > cond.params.value, observed: fmt(s.taker_1h, 2) };
    case 'taker_1h_below':    return s.taker_1h == null ? { passed: false, observed: '—' } : { passed: s.taker_1h < cond.params.value, observed: fmt(s.taker_1h, 2) };
    case 'cvd_above':         return s.cvd == null ? { passed: false, observed: '—' } : { passed: s.cvd > cond.params.value, observed: fmt(s.cvd) };
    case 'cvd_below':         return s.cvd == null ? { passed: false, observed: '—' } : { passed: s.cvd < cond.params.value, observed: fmt(s.cvd) };
    case 'whale_sell_min_usd':{
      if (!Array.isArray(s.whales_recent)) return { passed: false, observed: '—' };
      const hit = s.whales_recent.find(w => w.side === 'SELL' && w.notional_usd >= cond.params.value);
      return { passed: !!hit, observed: hit ? '$' + Math.round(hit.notional_usd) : 'no whale' };
    }
    case 'whale_buy_min_usd': {
      if (!Array.isArray(s.whales_recent)) return { passed: false, observed: '—' };
      const hit = s.whales_recent.find(w => w.side === 'BUY' && w.notional_usd >= cond.params.value);
      return { passed: !!hit, observed: hit ? '$' + Math.round(hit.notional_usd) : 'no whale' };
    }
    case 'candle_close_above':return s.candle_5m_close == null ? { passed: false, observed: '—' } : { passed: s.candle_5m_close > cond.params.value, observed: fmt(s.candle_5m_close) };
    case 'candle_close_below':return s.candle_5m_close == null ? { passed: false, observed: '—' } : { passed: s.candle_5m_close < cond.params.value, observed: fmt(s.candle_5m_close) };
    case 'funding_above':     return s.funding_pct == null ? { passed: false, observed: '—' } : { passed: s.funding_pct > cond.params.value, observed: s.funding_pct.toFixed(3) + '%' };
    case 'funding_below':     return s.funding_pct == null ? { passed: false, observed: '—' } : { passed: s.funding_pct < cond.params.value, observed: s.funding_pct.toFixed(3) + '%' };
    default: return { passed: false, observed: '—' };
  }
}

/** Returns { all_passed, results: [{cond, passed, observed}] } */
function evaluateAllConditions(conditions, snapshot) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { all_passed: false, results: [] };
  }
  const results = conditions.map(c => {
    const r = evaluateCondition(c, snapshot);
    return { cond: c, passed: r.passed, observed: r.observed };
  });
  return { all_passed: results.every(r => r.passed), results };
}

const api = {
  parseNum, parseRange, attachNumericRanges, isEntryHit, extractLevelsForChart,
  parseConditionLine, parseConditionsBlock, evaluateCondition, evaluateAllConditions
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.PlaybookParser = api;
