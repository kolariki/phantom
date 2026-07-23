import { describe, it, expect } from 'vitest';
import {
  evaluatePrevious,
  classifyChange,
  buildGuidance,
  buildContinuity,
  _internal
} from '../lib/continuity.js';

function prevAlert(overrides = {}) {
  return {
    id: 'abc',
    created_at: new Date(Date.now() - 30 * 60000).toISOString(), // 30 min ago
    asset: 'BTC/USDT',
    ai_decision: 'SHORT',
    ai_confluence: '3/4',
    ai_setup_short: {
      entry: '$79,500 - $79,700',
      sl: '$80,200',
      tp1: '$78,800',
      tp2: '$78,200',
      tp3: '$77,500',
      size: '1.5% of capital'
    },
    user_action: null,
    user_entry: null,
    outcome: null,
    ...overrides
  };
}

describe('parseFirstPrice', () => {
  it('handles "$79,500 - $79,700"', () => {
    expect(_internal.parseFirstPrice('$79,500 - $79,700')).toBe(79500);
  });
  it('handles plain number', () => {
    expect(_internal.parseFirstPrice('78800')).toBe(78800);
  });
  it('returns null on garbage', () => {
    expect(_internal.parseFirstPrice('not a price')).toBe(null);
    expect(_internal.parseFirstPrice(null)).toBe(null);
  });
});

describe('classifyChange', () => {
  it('detects reversal LONG → SHORT', () => {
    expect(classifyChange('LONG', 'SHORT')).toBe('reversal');
  });
  it('detects same direction', () => {
    expect(classifyChange('SHORT', 'SHORT')).toBe('same');
  });
  it('treats WAIT transitions as shifts', () => {
    expect(classifyChange('LONG', 'WAIT')).toBe('shift');
    expect(classifyChange('WAIT', 'SHORT')).toBe('shift');
  });
  it('returns "first" when previous missing', () => {
    expect(classifyChange(null, 'LONG')).toBe('first');
  });
});

describe('evaluatePrevious', () => {
  it('computes pnl for SHORT in profit', () => {
    const ev = evaluatePrevious(prevAlert(), 78900); // SHORT @ 79,500 → now 78,900 → +0.75%
    expect(ev.decision).toBe('SHORT');
    expect(ev.entry_price).toBe(79500);
    expect(ev.pnl_if_entered_pct).toBeCloseTo(0.7547, 2);
    expect(ev.hit_tp1).toBe(false);
    expect(ev.hit_sl).toBe(false);
  });

  it('flags TP1 hit on SHORT when price <= TP1', () => {
    const ev = evaluatePrevious(prevAlert(), 78700);
    expect(ev.hit_tp1).toBe(true);
    expect(ev.pnl_if_entered_pct).toBeGreaterThan(0);
  });

  it('flags SL hit on SHORT when price >= SL', () => {
    const ev = evaluatePrevious(prevAlert(), 80300);
    expect(ev.hit_sl).toBe(true);
    expect(ev.pnl_if_entered_pct).toBeLessThan(0);
  });

  it('computes pnl for LONG correctly', () => {
    const prev = prevAlert({
      ai_decision: 'LONG',
      ai_setup_short: null,
      ai_setup_long: { entry: '$78,000', sl: '$77,200', tp1: '$79,500' }
    });
    const ev = evaluatePrevious(prev, 79800); // LONG @ 78,000 → 79,800 → +2.31%
    expect(ev.pnl_if_entered_pct).toBeCloseTo(2.307, 2);
    expect(ev.hit_tp1).toBe(true);
  });

  it('returns null on null prev', () => {
    expect(evaluatePrevious(null, 50000)).toBe(null);
  });
});

describe('buildGuidance', () => {
  it('returns first-alert text when no previous', () => {
    const g = buildGuidance(null, 'LONG');
    expect(g.kind).toBe('first');
  });

  it('warns about reversal when user already entered', () => {
    const ev = evaluatePrevious(prevAlert({ user_action: 'short', outcome: 'open' }), 79000);
    const g = buildGuidance(ev, 'LONG');
    expect(g.kind).toBe('reversal');
    expect(g.text).toMatch(/INVIRTIÓ|reversed|cerrar/i);
  });

  it('tells user to hold same-direction setup', () => {
    const ev = evaluatePrevious(prevAlert({ user_action: 'short', outcome: 'open' }), 79000);
    const g = buildGuidance(ev, 'SHORT');
    expect(g.kind).toBe('same');
    expect(g.text).toMatch(/sigue vivo|plan original/i);
  });

  it('mentions TP1 hit explicitly in the body', () => {
    const ev = evaluatePrevious(prevAlert(), 78600); // hits TP1 of 78,800
    const g = buildGuidance(ev, 'SHORT');
    expect(g.text).toMatch(/take-profit|TOCÓ/i);
  });
});

describe('buildContinuity', () => {
  it('returns null when there is no previous trade', () => {
    expect(buildContinuity([], 'SHORT', 80000)).toBe(null);
    expect(buildContinuity(null, 'SHORT', 80000)).toBe(null);
  });

  it('returns a full payload with previous + guidance', () => {
    const c = buildContinuity([prevAlert()], 'SHORT', 79000);
    expect(c.previous.decision).toBe('SHORT');
    expect(c.guidance.kind).toBe('same');
    expect(c.change_kind).toBe('same');
  });

  it('uses most recent (first) trade', () => {
    const older = prevAlert({ id: 'old', created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString() });
    const newer = prevAlert({ id: 'new', ai_decision: 'LONG', ai_setup_long: { entry: '$78,000', sl: '$77,000', tp1: '$80,000' }, ai_setup_short: null });
    const c = buildContinuity([newer, older], 'SHORT', 79000);
    expect(c.previous.id).toBe('new');
    expect(c.change_kind).toBe('reversal');
  });
});
