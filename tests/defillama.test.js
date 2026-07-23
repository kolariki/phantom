import { describe, it, expect } from 'vitest';
import { formatForPrompt } from '../lib/defillama.js';

describe('defillama formatForPrompt', () => {
  it('returns empty for null', () => {
    expect(formatForPrompt(null)).toBe('');
    expect(formatForPrompt({ total_market_cap_usd: 0 })).toBe('');
  });

  it('renders strong inflow verdict', () => {
    const out = formatForPrompt({
      total_market_cap_usd: 200_000_000_000,
      delta_1d_usd: 1_500_000_000,
      delta_1d_pct: 0.75,
      delta_7d_pct: 2.1,
      delta_30d_pct: 5.5,
      breakdown: {
        Tether: { circulating: 120_000_000_000, delta_1d_pct: 0.4 },
        USDC:   { circulating: 50_000_000_000,  delta_1d_pct: 1.2 }
      }
    });
    expect(out).toContain('MACRO LIQUIDITY');
    expect(out).toContain('$200.00B');
    expect(out).toContain('+0.750%');
    expect(out).toContain('STRONG INFLOW');
    expect(out).toContain('Tether: $120.00B');
    expect(out).toContain('USDC: $50.00B');
  });

  it('renders strong outflow verdict', () => {
    const out = formatForPrompt({
      total_market_cap_usd: 195_000_000_000,
      delta_1d_pct: -0.55,
      delta_7d_pct: -1.2,
      delta_30d_pct: -3.5,
      breakdown: {}
    });
    expect(out).toContain('STRONG OUTFLOW');
    expect(out).toContain('-0.550%');
  });

  it('marks neutral when changes are tiny', () => {
    const out = formatForPrompt({
      total_market_cap_usd: 200_000_000_000,
      delta_1d_pct: 0.01,
      delta_7d_pct: 0,
      delta_30d_pct: 0,
      breakdown: {}
    });
    expect(out).toMatch(/Liquidity verdict.*neutral/i);
  });

  it('always appends interpretation rules', () => {
    const out = formatForPrompt({ total_market_cap_usd: 200e9, delta_1d_pct: 0.1, breakdown: {} });
    expect(out).toContain('MACRO INTERPRETATION');
  });
});
