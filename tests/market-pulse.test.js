import { describe, it, expect } from 'vitest';
import { toBinanceSymbol, _internal } from '../lib/market-pulse.js';

const { topWallZones, inferZoneSize } = _internal;

describe('toBinanceSymbol', () => {
  it('normalizes', () => {
    expect(toBinanceSymbol('btc/usdt')).toBe('BTCUSDT');
    expect(toBinanceSymbol('eth')).toBe('ETHUSDT');
    expect(toBinanceSymbol('SOLUSDC')).toBe('SOLUSDC');
  });
});

describe('inferZoneSize', () => {
  it('picks a sensible zone width tuned for scalping with intermediates (~0.05-0.25% of price)', () => {
    expect(inferZoneSize(80000)).toBe(50);     // BTC → $50 zones (sees $79,050 + $79,100 + $79,150)
    expect(inferZoneSize(50000)).toBe(50);
    expect(inferZoneSize(15000)).toBe(25);     // mid-cap → $25
    expect(inferZoneSize(3000)).toBe(2.5);     // ETH → $2.50 zones
    expect(inferZoneSize(100)).toBe(0.25);     // SOL → $0.25 zones
    expect(inferZoneSize(25)).toBe(0.05);      // small alt → $0.05
    expect(inferZoneSize(1)).toBe(0.01);       // dollar token → $0.01
    expect(inferZoneSize(0.05)).toBe(0.0001);  // micro token
  });

  it('returns 1 on zero / missing input', () => {
    expect(inferZoneSize(0)).toBe(1);
    expect(inferZoneSize(null)).toBe(1);
  });
});

describe('topWallZones', () => {
  it('aggregates clustered levels into a single zone', () => {
    // Six bid levels all inside the $79,950-$79,999 zone, each 5 coins.
    // With zoneSize=50, they all bucket together → total 30 coins in one zone.
    const bids = [
      [79999.0, 5], [79995.5, 5], [79990.2, 5],
      [79985.1, 5], [79975.0, 5], [79960.0, 5],
      // Other zones with small sizes for context (so median is low)
      [79900.0, 1], [79850.0, 1], [79800.0, 1], [79750.0, 1],
      [79700.0, 1], [79650.0, 1]
    ];
    const zones = topWallZones('bid', bids, 80020, { zoneSize: 50, minMult: 2 });
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].zone_start).toBe(79950);
    expect(zones[0].zone_end).toBe(80000);
    expect(zones[0].total_size).toBeCloseTo(30, 5);
    expect(zones[0].level_count).toBe(6);
    expect(zones[0].dist_pct).toBeLessThan(0);
  });

  it('always returns top zones (no min-mult gate by default)', () => {
    // Even when all zones are similar in size, the top N are still useful:
    // they ARE the densest liquidity zones. Trader still wants to see them.
    const asks = Array.from({ length: 20 }, (_, i) => [(80050 + i * 5), 5]);
    const zones = topWallZones('ask', asks, 80000, { zoneSize: 50, topN: 3 });
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.length).toBeLessThanOrEqual(3);
  });

  it('still supports opt-in minMult gate when explicitly requested', () => {
    const asks = Array.from({ length: 20 }, (_, i) => [(80050 + i * 5), 5]);
    const zones = topWallZones('ask', asks, 80000, { zoneSize: 50, minMult: 3 });
    expect(zones).toEqual([]);
  });

  it('skips zones outside the distance window', () => {
    const asks = Array.from({ length: 20 }, (_, i) => [(80050 + i * 5), 5]);
    asks.push([90000, 9999]); // outside ±3%
    const zones = topWallZones('ask', asks, 80000, { zoneSize: 50, maxDistPct: 3 });
    expect(zones.find(z => z.zone_start === 90000)).toBeUndefined();
  });

  it('respects topN cap', () => {
    // Build many "wall" zones (each one 100x bigger than baseline).
    const bids = [];
    for (let i = 0; i < 10; i++) bids.push([80000 - i * 50 - 1, 100]); // 10 distinct zones of 100
    for (let i = 0; i < 30; i++) bids.push([79500 - i, 1]);             // background noise
    const zones = topWallZones('bid', bids, 80010, { zoneSize: 50, topN: 3, minMult: 2 });
    expect(zones.length).toBeLessThanOrEqual(3);
  });
});

describe('prompt-shape stability for Market Pulse UI', () => {
  it('renderer.js exposes the marketpulse setup', async () => {
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const src = readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'renderer/renderer.js'), 'utf8');
    expect(src).toMatch(/setupMarketPulse/);
    expect(src).toMatch(/phantom\.marketpulse\.fetch/);
    expect(src).toMatch(/POLL_MS\s*=\s*5000/);
    expect(src).toMatch(/setupTradingStandaloneView/);
    expect(src).toMatch(/view=trading|params\.get\('view'\)/);
  });

  it('preload exposes marketpulse + openTrading', async () => {
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const src = readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'preload.js'), 'utf8');
    expect(src).toMatch(/marketpulse:\s*\{/);
    expect(src).toMatch(/openTrading:/);
  });
});
