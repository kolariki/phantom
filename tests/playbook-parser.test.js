import { describe, it, expect } from 'vitest';
import {
  parseNum, parseRange,
  parseConditionLine, parseConditionsBlock,
  evaluateCondition, evaluateAllConditions,
  attachNumericRanges, extractLevelsForChart
} from '../lib/playbook-parser.js';

describe('parseNum', () => {
  it('handles English thousands ($79,520)', () => {
    expect(parseNum('$79,520')).toBe(79520);
  });
  it('handles Spanish thousands ($79.520)', () => {
    expect(parseNum('$79.520')).toBe(79520);
  });
  it('handles decimals after thousands ($1,234,567.89)', () => {
    expect(parseNum('$1,234,567.89')).toBe(1234567.89);
  });
  it('handles plain decimals ($79.5)', () => {
    expect(parseNum('$79.5')).toBe(79.5);
  });
  it('handles cents ($0.05)', () => {
    expect(parseNum('$0.05')).toBe(0.05);
  });
  it('returns NaN for non-numeric strings', () => {
    expect(parseNum('size: 4% of capital')).toBeNaN();
  });
});

describe('parseRange', () => {
  it('parses a range string', () => {
    expect(parseRange('$79,520 - $79,560')).toEqual([79520, 79560]);
  });
  it('handles dashes of various widths', () => {
    expect(parseRange('$79.100–$79.150')).toEqual([79100, 79150]);
  });
  it('falls back to single price when no range', () => {
    expect(parseRange('$79,300')).toEqual([79300, 79300]);
  });
  it('returns null when nothing parseable', () => {
    expect(parseRange('N/A')).toBeNull();
  });
});

describe('parseConditionLine', () => {
  it('parses price_in range', () => {
    const c = parseConditionLine('- price_in:79100-79150');
    expect(c.op).toBe('price_in');
    expect(c.params).toEqual({ lo: 79100, hi: 79150 });
  });
  it('parses taker_5m_below', () => {
    const c = parseConditionLine('- taker_5m_below:0.85');
    expect(c.op).toBe('taker_5m_below');
    expect(c.params.value).toBe(0.85);
  });
  it('parses whale_sell_min_usd', () => {
    const c = parseConditionLine('- whale_sell_min_usd:300000');
    expect(c.op).toBe('whale_sell_min_usd');
    expect(c.params.value).toBe(300000);
  });
  it('parses negative cvd_below', () => {
    const c = parseConditionLine('- cvd_below:-1500000');
    expect(c.op).toBe('cvd_below');
    expect(c.params.value).toBe(-1500000);
  });
  it('returns null on unknown operator', () => {
    expect(parseConditionLine('- nonsense_op:42')).toBeNull();
  });
  it('returns null on malformed line', () => {
    expect(parseConditionLine('not a condition')).toBeNull();
  });
});

describe('parseConditionsBlock', () => {
  it('parses a multi-line block', () => {
    const block = `
      - price_in:79100-79150
      - taker_5m_below:0.85
      - whale_sell_min_usd:300000
      - candle_close_below:79080
    `;
    const out = parseConditionsBlock(block);
    expect(out).toHaveLength(4);
    expect(out[0].op).toBe('price_in');
    expect(out[3].op).toBe('candle_close_below');
  });
  it('silently ignores invalid lines', () => {
    const block = `
      - price_in:79100-79150
      - INVALID_OP:foo
      - taker_5m_below:0.85
    `;
    const out = parseConditionsBlock(block);
    expect(out).toHaveLength(2);
  });
});

describe('evaluateCondition', () => {
  const baseSnap = {
    mid: 79120,
    taker_5m: 0.42,
    taker_1h: 0.91,
    cvd: -2_270_000,
    whales_recent: [
      { side: 'SELL', notional_usd: 412000, seconds_ago: 35 },
      { side: 'BUY',  notional_usd: 90000,  seconds_ago: 70 }
    ],
    candle_5m_close: 79075,
    funding_pct: -0.05
  };

  it('price_in passes when mid is inside range', () => {
    const c = { op: 'price_in', params: { lo: 79100, hi: 79150 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(true);
  });
  it('price_in fails when mid is outside', () => {
    const c = { op: 'price_in', params: { lo: 79200, hi: 79300 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(false);
  });
  it('taker_5m_below passes when taker_5m < value', () => {
    const c = { op: 'taker_5m_below', params: { value: 0.85 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(true);
  });
  it('whale_sell_min_usd passes when a SELL whale ≥ threshold exists', () => {
    const c = { op: 'whale_sell_min_usd', params: { value: 300000 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(true);
  });
  it('whale_sell_min_usd fails when no sell whale meets threshold', () => {
    const c = { op: 'whale_sell_min_usd', params: { value: 500000 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(false);
  });
  it('whale_buy_min_usd reads BUY side only', () => {
    const c = { op: 'whale_buy_min_usd', params: { value: 80000 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(true);
  });
  it('candle_close_below passes when last close < value', () => {
    const c = { op: 'candle_close_below', params: { value: 79080 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(true);
  });
  it('cvd_below works for negative thresholds', () => {
    const c = { op: 'cvd_below', params: { value: -1_500_000 } };
    expect(evaluateCondition(c, baseSnap).passed).toBe(true);
  });
  it('returns observed value alongside passed flag', () => {
    const c = { op: 'taker_5m_below', params: { value: 0.85 } };
    const r = evaluateCondition(c, baseSnap);
    expect(r.observed).toBe('0.42');
  });
  it('returns passed:false + observed:— when data is missing', () => {
    const c = { op: 'taker_5m_below', params: { value: 0.85 } };
    const r = evaluateCondition(c, { mid: 79120 });
    expect(r.passed).toBe(false);
    expect(r.observed).toBe('—');
  });
});

describe('evaluateAllConditions — the all-or-nothing gate', () => {
  const snap = {
    mid: 79120, taker_5m: 0.42, cvd: -2_270_000,
    whales_recent: [{ side: 'SELL', notional_usd: 412000, seconds_ago: 12 }],
    candle_5m_close: 79075
  };

  it('returns all_passed=true ONLY when every condition is satisfied', () => {
    const conds = parseConditionsBlock(`
      - price_in:79100-79150
      - taker_5m_below:0.85
      - whale_sell_min_usd:300000
      - candle_close_below:79080
    `);
    const r = evaluateAllConditions(conds, snap);
    expect(r.all_passed).toBe(true);
    expect(r.results).toHaveLength(4);
    expect(r.results.every(x => x.passed)).toBe(true);
  });

  it('returns all_passed=false when even one condition fails', () => {
    const conds = parseConditionsBlock(`
      - price_in:79100-79150
      - taker_5m_below:0.85
      - whale_sell_min_usd:500000
      - candle_close_below:79080
    `);
    const r = evaluateAllConditions(conds, snap);
    expect(r.all_passed).toBe(false);
    // The failing one is whale_sell_min_usd:500000 (only 412k whale exists).
    expect(r.results.find(x => x.cond.op === 'whale_sell_min_usd').passed).toBe(false);
  });

  it('returns all_passed=false when there are no conditions at all', () => {
    expect(evaluateAllConditions([], snap).all_passed).toBe(false);
  });
});

describe('attachNumericRanges + extractLevelsForChart', () => {
  it('attaches numeric ranges and SL/TP values', () => {
    const s = { entry: '$79,100 - $79,145', sl: '$79,230', tp1: '$79,000', tp2: '$78,920', tp3: '$78,780' };
    const out = attachNumericRanges(s);
    expect(out.entry_range).toEqual([79100, 79145]);
    expect(out.sl_value).toBe(79230);
    expect(out.tp1_value).toBe(79000);
  });
  it('extractLevelsForChart includes both critical levels and scenario prices', () => {
    const scenarios = [attachNumericRanges({ name: 'rej', action: 'SHORT', entry: '$79,100 - $79,145', sl: '$79,230', tp1: '$79,000' })];
    const levels = extractLevelsForChart(scenarios, [{ price: '$79,500', role: 'major resistance' }]);
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.find(l => l.kind === 'level' && l.price === 79500)).toBeTruthy();
    expect(levels.find(l => l.kind === 'entry')).toBeTruthy();
    expect(levels.find(l => l.kind === 'sl' && l.price === 79230)).toBeTruthy();
  });
});
