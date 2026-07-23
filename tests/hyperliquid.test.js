import { describe, it, expect } from 'vitest';
import { formatForPrompt, toHLSymbol, KNOWN_WHALES } from '../lib/hyperliquid.js';

describe('toHLSymbol', () => {
  it('strips pair suffixes', () => {
    expect(toHLSymbol('BTC/USDT')).toBe('BTC');
    expect(toHLSymbol('ETHUSD')).toBe('ETH');
    expect(toHLSymbol('SOL-PERP')).toBe('SOL');
    expect(toHLSymbol('btcusdc')).toBe('BTC');
    expect(toHLSymbol(null)).toBe('BTC');
  });
});

describe('KNOWN_WHALES', () => {
  it('has at least one whale and valid ETH-style addresses', () => {
    expect(KNOWN_WHALES.length).toBeGreaterThanOrEqual(1);
    for (const w of KNOWN_WHALES) {
      expect(w.address).toMatch(/^0x[a-f0-9]{40}$/i);
      expect(w.label).toBeTruthy();
    }
  });
});

describe('formatForPrompt', () => {
  it('returns empty when nothing usable', () => {
    expect(formatForPrompt(null)).toBe('');
    expect(formatForPrompt({ symbol: 'BTC', ctx: null, whales: null })).toBe('');
  });

  it('renders asset context with premium verdict', () => {
    const out = formatForPrompt({
      symbol: 'BTC',
      ctx: {
        mark_price: 81000, oracle_price: 80900, premium_pct: 0.123,
        funding_rate_annualized_pct: 12.5, open_interest_usd: 1_200_000_000, day_volume_usd: 2_500_000_000
      },
      whales: null
    });
    expect(out).toContain('HYPERLIQUID DEX DATA');
    expect(out).toContain('HL premium');
    expect(out).toContain('+0.1230%');
    expect(out).toContain('+12.50%');
    expect(out).toContain('longs pay shorts');
    expect(out).toContain('$1200.0M');
  });

  it('renders whales with net long and biggest list', () => {
    const out = formatForPrompt({
      symbol: 'BTC',
      ctx: null,
      whales: {
        total_whales_in_position: 3, longs: 2, shorts: 1,
        long_size_coin: 12.5, short_size_coin: 3.0, net_size_coin: 9.5,
        biggest: [
          { label: 'James Wynn', side: 'LONG', size_coin: 10, entry_price: 80500, account_equity_usd: 25_000_000, unrealized_pnl_usd: 5000 }
        ],
        sample_size: 5
      }
    });
    expect(out).toContain('3/5 whales');
    expect(out).toContain('NET LONG');
    expect(out).toContain('James Wynn: LONG 10.00');
    expect(out).toContain('uPnL +$5000');
  });

  it('marks negative funding correctly', () => {
    const out = formatForPrompt({
      symbol: 'BTC',
      ctx: { funding_rate_annualized_pct: -3.2, mark_price: 100, oracle_price: 100 },
      whales: null
    });
    expect(out).toContain('shorts pay longs');
    expect(out).toContain('-3.20%');
  });
});
