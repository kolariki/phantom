import { describe, it, expect } from 'vitest';
import { formatForPrompt, toBinanceSymbol, _internal } from '../lib/orderflow.js';

const { analyzeOrderBook } = _internal;

describe('toBinanceSymbol', () => {
  it('normalizes various inputs', () => {
    expect(toBinanceSymbol('BTC/USDT')).toBe('BTCUSDT');
    expect(toBinanceSymbol('btc-usdt')).toBe('BTCUSDT');
    expect(toBinanceSymbol('ETH')).toBe('ETHUSDT');
    expect(toBinanceSymbol('SOLUSDT')).toBe('SOLUSDT');
    expect(toBinanceSymbol('SOLUSDC')).toBe('SOLUSDC');
    expect(toBinanceSymbol(null)).toBe('BTCUSDT');
  });
});

describe('analyzeOrderBook', () => {
  it('computes mid + spread', () => {
    const r = analyzeOrderBook({
      bids: [['80000', '1'], ['79999', '1']],
      asks: [['80010', '1'], ['80011', '1']]
    });
    expect(r.best_bid).toBe(80000);
    expect(r.best_ask).toBe(80010);
    expect(r.mid).toBe(80005);
    expect(r.spread_pct).toBeCloseTo(0.0125, 3);
  });

  it('computes 1% imbalance correctly (bid-heavy)', () => {
    const bids = Array.from({ length: 30 }, (_, i) => [(80000 - i * 5).toString(), '10']);
    const asks = Array.from({ length: 30 }, (_, i) => [(80010 + i * 5).toString(), '3']);
    const r = analyzeOrderBook({ bids, asks });
    expect(r.imbalance_1pct).toBeGreaterThan(1.3);
    expect(r.bid_size_1pct).toBeGreaterThan(r.ask_size_1pct);
  });

  it('detects bid wall when one level is much larger', () => {
    const bids = [
      ['80000', '5'], ['79995', '5'], ['79990', '5'],
      ['79985', '5'], ['79980', '5'], ['79975', '5'],
      ['79970', '200'],  // ← wall
      ['79965', '5'], ['79960', '5'], ['79955', '5']
    ];
    const asks = [['80010', '5'], ['80020', '5'], ['80030', '5'], ['80040', '5'], ['80050', '5'], ['80060', '5'], ['80070', '5']];
    const r = analyzeOrderBook({ bids, asks });
    expect(r.bid_wall).toBeTruthy();
    expect(r.bid_wall.price).toBe(79970);
    expect(r.bid_wall.multiple_of_median).toBeGreaterThanOrEqual(5);
  });

  it('returns null wall when no level stands out', () => {
    const bids = Array.from({ length: 20 }, (_, i) => [(80000 - i).toString(), '10']);
    const asks = Array.from({ length: 20 }, (_, i) => [(80010 + i).toString(), '10']);
    const r = analyzeOrderBook({ bids, asks });
    expect(r.bid_wall).toBe(null);
    expect(r.ask_wall).toBe(null);
  });
});

describe('formatForPrompt', () => {
  it('returns empty when nothing available', () => {
    expect(formatForPrompt(null)).toBe('');
    expect(formatForPrompt({ symbol: 'BTCUSDT', taker5m: null, taker1h: null, topTrader1h: null, book: null })).toBe('');
  });

  it('emits aggressive-buying verdict on high taker ratio', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      taker5m: { period: '5m', latest_ratio: 1.45, latest_buy_vol: 1200, latest_sell_vol: 830, avg_ratio_window: 1.30, samples: 12 },
      taker1h: null, topTrader1h: null, book: null
    });
    expect(out).toContain('AGGRESSIVE BUYING');
    expect(out).toContain('1.450');
    expect(out).toContain('last hour avg ratio');
  });

  it('emits aggressive-selling verdict on low taker ratio', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      taker5m: { period: '5m', latest_ratio: 0.65, latest_buy_vol: 500, latest_sell_vol: 770, avg_ratio_window: 0.80, samples: 12 },
      taker1h: null, topTrader1h: null, book: null
    });
    expect(out).toContain('AGGRESSIVE SELLING');
  });

  it('marks top trader bias and delta', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      taker5m: null, taker1h: null,
      topTrader1h: { period: '1h', long_pct: 62.0, short_pct: 38.0, long_short_ratio: 1.63, delta_long_pct: 2.1 },
      book: null
    });
    expect(out).toContain('LONG-biased');
    expect(out).toContain('62.0% long');
    expect(out).toContain('+2.10pp');
  });

  it('renders walls when present', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      taker5m: null, taker1h: null, topTrader1h: null,
      book: {
        best_bid: 80000, best_ask: 80010, mid: 80005, spread_pct: 0.012,
        bid_size_1pct: 200, ask_size_1pct: 150, imbalance_1pct: 1.33,
        bid_size_2pct: 400, ask_size_2pct: 300, imbalance_2pct: 1.33,
        bid_wall: { price: 79500, size: 250, multiple_of_median: 8.2, distance_pct: -0.63 },
        ask_wall: null
      }
    });
    expect(out).toContain('BID wall at $79500');
    expect(out).toContain('strong support');
    expect(out).toContain('BID-heavy');
  });

  it('always appends interpretation rules', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      taker5m: { period: '5m', latest_ratio: 1.0, latest_buy_vol: 100, latest_sell_vol: 100, avg_ratio_window: 1.0, samples: 12 },
      taker1h: null, topTrader1h: null, book: null
    });
    expect(out).toContain('ORDER-FLOW INTERPRETATION');
    expect(out).toContain('absorption pattern');
  });
});
