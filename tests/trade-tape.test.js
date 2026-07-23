import { describe, it, expect } from 'vitest';
import { formatForPrompt, toBinanceSymbol, _internal } from '../lib/trade-tape.js';

const { buildVolumeProfile } = _internal;

describe('toBinanceSymbol', () => {
  it('normalizes various inputs', () => {
    expect(toBinanceSymbol('BTC/USDT')).toBe('BTCUSDT');
    expect(toBinanceSymbol('eth')).toBe('ETHUSDT');
    expect(toBinanceSymbol('SOLUSDC')).toBe('SOLUSDC');
  });
});

describe('buildVolumeProfile', () => {
  it('returns top bins sorted by total volume', () => {
    const trades = [
      // Heavy activity at $80,000
      { price: 80000, qty: 10, notional: 800_000, side: 'BUY',  time: 1 },
      { price: 80001, qty: 5,  notional: 400_000, side: 'SELL', time: 2 },
      { price: 80000, qty: 8,  notional: 640_000, side: 'BUY',  time: 3 },
      // Smaller pocket at $80,500
      { price: 80500, qty: 2,  notional: 161_000, side: 'BUY',  time: 4 },
      { price: 80501, qty: 1,  notional: 80_500,  side: 'SELL', time: 5 }
    ];
    const out = buildVolumeProfile(trades, 5);
    expect(out.length).toBeGreaterThanOrEqual(1);
    // The $80,000 cluster should be the top bin by total volume.
    expect(out[0].total_notional_usd).toBeGreaterThan(out[out.length - 1].total_notional_usd);
    expect(out[0].buy_notional_usd).toBeGreaterThan(0);
    expect(out[0].sell_notional_usd).toBeGreaterThan(0);
  });

  it('marks buy-dominant bias correctly', () => {
    const trades = [
      { price: 80000, qty: 10, notional: 800_000, side: 'BUY',  time: 1 },
      { price: 80000, qty: 1,  notional: 80_000,  side: 'SELL', time: 2 }
    ];
    const out = buildVolumeProfile(trades, 5);
    expect(out[0].bias).toBe('buy-dominant');
  });

  it('marks sell-dominant bias correctly', () => {
    const trades = [
      { price: 80000, qty: 1,  notional: 80_000,  side: 'BUY',  time: 1 },
      { price: 80000, qty: 10, notional: 800_000, side: 'SELL', time: 2 }
    ];
    const out = buildVolumeProfile(trades, 5);
    expect(out[0].bias).toBe('sell-dominant');
  });

  it('returns [] on empty', () => {
    expect(buildVolumeProfile([])).toEqual([]);
  });
});

describe('formatForPrompt', () => {
  it('returns empty for null', () => {
    expect(formatForPrompt(null)).toBe('');
  });

  it('renders strong net buying verdict', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      window_seconds: 300,
      trade_count: 800,
      buy_vol_coin: 20,
      sell_vol_coin: 10,
      buy_notional_usd: 1_600_000,
      sell_notional_usd: 800_000,
      cvd_notional_usd: 800_000,
      buy_sell_ratio: 2.0,
      whale_count: 3,
      whale_buy_notional_usd: 600_000,
      whale_sell_notional_usd: 100_000,
      whale_net_notional_usd: 500_000,
      top_whales: [
        { side: 'BUY', price: 80123.5, qty: 5.2, notional_usd: 416000, seconds_ago: 35 },
        { side: 'SELL', price: 80120.0, qty: 1.0, notional_usd: 80120, seconds_ago: 120 }
      ],
      volume_profile: [
        { price: 80100, total_notional_usd: 600_000, buy_notional_usd: 400_000, sell_notional_usd: 200_000, bias: 'buy-dominant' },
        { price: 80150, total_notional_usd: 350_000, buy_notional_usd: 175_000, sell_notional_usd: 175_000, bias: 'balanced' }
      ]
    });
    expect(out).toContain('TRADE TAPE');
    expect(out).toContain('STRONG NET BUYING');
    expect(out).toContain('+$800.00K');
    expect(out).toContain('WHALES NET BUYING');
    expect(out).toContain('🟢 BUY 5.200 @ $80123.5');
    expect(out).toContain('35s ago');
    expect(out).toContain('Volume profile');
    expect(out).toContain('$80100.00');
    expect(out).toContain('buyers dominant');
    expect(out).toContain('TRADE-TAPE INTERPRETATION');
  });

  it('renders strong net selling and 0 whales when applicable', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT',
      window_seconds: 180,
      trade_count: 400,
      buy_vol_coin: 1, sell_vol_coin: 5,
      buy_notional_usd: 100_000, sell_notional_usd: 500_000,
      cvd_notional_usd: -400_000,
      buy_sell_ratio: 0.2,
      whale_count: 0,
      whale_buy_notional_usd: 0,
      whale_sell_notional_usd: 0,
      whale_net_notional_usd: 0,
      top_whales: [],
      volume_profile: []
    });
    expect(out).toContain('STRONG NET SELLING');
    expect(out).toContain('-$400.00K');
    expect(out).toContain('Whale prints (≥$100k): 0');
    expect(out).toContain('retail-only flow');
  });

  it('reports minutes ago for older whale prints', () => {
    const out = formatForPrompt({
      symbol: 'BTCUSDT', window_seconds: 600, trade_count: 100,
      buy_vol_coin: 1, sell_vol_coin: 1,
      buy_notional_usd: 1, sell_notional_usd: 1, cvd_notional_usd: 0, buy_sell_ratio: 1,
      whale_count: 1,
      whale_buy_notional_usd: 250_000, whale_sell_notional_usd: 0, whale_net_notional_usd: 250_000,
      top_whales: [{ side: 'BUY', price: 80000, qty: 3, notional_usd: 240000, seconds_ago: 240 }],
      volume_profile: []
    });
    expect(out).toContain('4m ago');
  });
});
