import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeRadar, _internal } = require('../lib/scalp-radar.js');
const { pressureScore, decideVerdict } = _internal;

describe('pressureScore', () => {
  it('neutral inputs → score near 0', () => {
    expect(pressureScore({ book_imbalance: 1, cvd_velocity: 0, aggressor_buy_pct: 50, whale_skew: 0 })).toBe(0);
  });
  it('bullish stack → strongly positive', () => {
    const s = pressureScore({ book_imbalance: 2.0, cvd_velocity: 250_000, aggressor_buy_pct: 80, whale_skew: 0.8 });
    expect(s).toBeGreaterThan(60);
  });
  it('bearish stack → strongly negative', () => {
    const s = pressureScore({ book_imbalance: 0.5, cvd_velocity: -250_000, aggressor_buy_pct: 20, whale_skew: -0.8 });
    expect(s).toBeLessThan(-60);
  });
  it('clamps to ±100', () => {
    const s = pressureScore({ book_imbalance: 10, cvd_velocity: 5_000_000, aggressor_buy_pct: 100, whale_skew: 5 });
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe('decideVerdict', () => {
  it('returns WAIT when pressure is weak', () => {
    expect(decideVerdict(10, null)).toBe('WAIT');
    expect(decideVerdict(-15, null)).toBe('WAIT');
  });
  it('returns LONG_NOW above +40', () => {
    expect(decideVerdict(55, null)).toBe('LONG_NOW');
  });
  it('returns SHORT_NOW below -40', () => {
    expect(decideVerdict(-55, null)).toBe('SHORT_NOW');
  });
  it('fades a fresh long-liquidation cascade (buy the flush)', () => {
    const liq = { total_liq_usd: 1_000_000, dominant_side: 'LONGS_GOT_REKT', last_event_ago_sec: 5 };
    expect(decideVerdict(-60, liq)).toBe('FADE_SHORT');
  });
  it('fades a fresh short-squeeze (sell the pump)', () => {
    const liq = { total_liq_usd: 1_000_000, dominant_side: 'SHORTS_GOT_REKT', last_event_ago_sec: 10 };
    expect(decideVerdict(60, liq)).toBe('FADE_LONG');
  });
  it('ignores old liquidations (>30s ago)', () => {
    const liq = { total_liq_usd: 1_000_000, dominant_side: 'LONGS_GOT_REKT', last_event_ago_sec: 120 };
    expect(decideVerdict(-60, liq)).toBe('SHORT_NOW');
  });
});

describe('computeRadar — end-to-end', () => {
  const baseSnapshot = (mid, cvd, trades = []) => ({
    fetched_at: Date.now(),
    book: {
      mid, best_bid: mid - 0.5, best_ask: mid + 0.5,
      spread_pct: 0.001, imbalance_1pct: 1.0,
      bid_size_1pct: 100, ask_size_1pct: 100,
      bid_walls: [], ask_walls: []
    },
    flow: { cvd, buy_notional: 1000, sell_notional: 1000, cvd_pct_of_flow: 0 },
    trades_recent: trades
  });

  it('computes CVD velocity from two snapshots', () => {
    const t0 = Date.now() - 60_000;
    const prev = { ...baseSnapshot(78000, 100_000), fetched_at: t0 };
    const curr = baseSnapshot(78050, 200_000);
    const r = computeRadar({ prev, curr, liqSummary: null, liqClusters: [] });
    // Δcvd 100k over ~60s ≈ 100k/min (small Date.now drift is fine, ±0.1%)
    expect(r.cvd_velocity_usd_per_min).toBeGreaterThan(99_500);
    expect(r.cvd_velocity_usd_per_min).toBeLessThan(100_500);
  });

  it('computes aggressor split from last-60s trades', () => {
    const trades = [
      { side: 'BUY',  notional: 80_000, seconds_ago: 20, is_whale: false },
      { side: 'SELL', notional: 20_000, seconds_ago: 30, is_whale: false }
    ];
    const curr = baseSnapshot(78000, 0, trades);
    const r = computeRadar({ prev: null, curr, liqSummary: null, liqClusters: [] });
    expect(r.aggressor_pct.buy_pct).toBe(80);
    expect(r.aggressor_pct.sell_pct).toBe(20);
  });

  it('whale skew uses only whale trades', () => {
    const trades = [
      { side: 'BUY',  notional: 200_000, seconds_ago: 10, is_whale: true },
      { side: 'BUY',  notional: 1_000,   seconds_ago: 12, is_whale: false }, // ignored
      { side: 'SELL', notional: 100_000, seconds_ago: 20, is_whale: true }
    ];
    const curr = baseSnapshot(78000, 0, trades);
    const r = computeRadar({ prev: null, curr, liqSummary: null, liqClusters: [] });
    // (200k - 100k) / 300k = 0.333
    expect(r.whale_skew).toBeCloseTo(0.333, 2);
  });

  it('flags nearest magnet within 1% of mid and ignores far ones', () => {
    const clusters = [
      { zone_start: 78050, zone_end: 78060, side: 'SHORT_LIQ', notional_usd: 500_000, event_count: 3 },
      { zone_start: 80000, zone_end: 80050, side: 'LONG_LIQ',  notional_usd: 5_000_000, event_count: 30 } // too far
    ];
    const curr = baseSnapshot(78000, 0);
    const r = computeRadar({ prev: null, curr, liqSummary: null, liqClusters: clusters });
    expect(r.nearest_magnet).toBeTruthy();
    expect(Math.round(r.nearest_magnet.price)).toBe(78055);
  });

  it('emits a trap warning for small clusters within 0.3%', () => {
    const clusters = [
      { zone_start: 78050, zone_end: 78060, side: 'SHORT_LIQ', notional_usd: 250_000, event_count: 2 }
    ];
    const curr = baseSnapshot(78000, 0);
    const r = computeRadar({ prev: null, curr, liqSummary: null, liqClusters: clusters });
    expect(r.trap_warning).toMatch(/breakout fakeout/);
  });

  it('returns null when curr is null', () => {
    expect(computeRadar({ prev: null, curr: null, liqSummary: null, liqClusters: [] })).toBeNull();
  });
});
