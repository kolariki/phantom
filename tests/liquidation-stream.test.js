import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const liq = require('../lib/liquidation-stream.js');
const { handleMessage, buffer } = liq._internal;

function makeEvent({ symbol = 'BTCUSDT', side = 'SELL', price, qty }) {
  // Binance forceOrder payload shape (single object).
  return JSON.stringify({ o: { s: symbol, S: side, ap: String(price), q: String(qty) } });
}

describe('liquidation-stream — message handling', () => {
  beforeEach(() => { buffer.length = 0; });

  it('parses a SELL liquidation as LONG_LIQ (long got rekt)', () => {
    handleMessage(makeEvent({ side: 'SELL', price: 78000, qty: 0.5 }));
    expect(buffer).toHaveLength(1);
    expect(buffer[0].side).toBe('LONG_LIQ');
    expect(buffer[0].notional_usd).toBe(78000 * 0.5);
  });

  it('parses a BUY liquidation as SHORT_LIQ (short got rekt)', () => {
    handleMessage(makeEvent({ side: 'BUY', price: 78000, qty: 0.5 }));
    expect(buffer[0].side).toBe('SHORT_LIQ');
  });

  it('ignores malformed payloads silently', () => {
    handleMessage('not json');
    handleMessage(JSON.stringify({ no_o_field: true }));
    expect(buffer).toHaveLength(0);
  });
});

describe('liquidation-stream — clustering + summarize', () => {
  beforeEach(() => { buffer.length = 0; });

  it('clusters nearby prices and orders by notional', () => {
    handleMessage(makeEvent({ price: 78010, qty: 0.4 })); // ~31k LONG_LIQ
    handleMessage(makeEvent({ price: 78030, qty: 0.6 })); // ~46k LONG_LIQ
    handleMessage(makeEvent({ price: 78500, qty: 0.5 })); // ~39k LONG_LIQ
    const clusters = liq.clusterRecent('BTCUSDT', { refPrice: 78000, minClusterUsd: 30_000 });
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters[0].notional_usd).toBeGreaterThan(70_000);
  });

  it('summarize returns LONGS_GOT_REKT when longs dominate', () => {
    handleMessage(makeEvent({ side: 'SELL', price: 78000, qty: 2 }));   // 156k longs
    handleMessage(makeEvent({ side: 'BUY',  price: 78000, qty: 0.1 })); // 7.8k shorts
    const s = liq.summarize('BTCUSDT');
    expect(s.dominant_side).toBe('LONGS_GOT_REKT');
    expect(s.longs_liq_usd).toBeGreaterThan(s.shorts_liq_usd);
  });

  it('summarize returns null dominant side when nothing happened', () => {
    expect(liq.summarize('BTCUSDT').dominant_side).toBeNull();
  });
});
