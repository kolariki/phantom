import { describe, it, expect } from 'vitest';
import {
  extractDecision,
  extractBias,
  extractConfluence,
  extractConfluenceScore,
  extractSetup,
  extractPatterns,
  parseAll
} from '../lib/ai-response-parser.js';

const SAMPLE = `
## 🚦 SECTION 1 — DECISION
🔴 **ENTER NOW — SHORT** because the structure looks weak.

## ⏱ SECTION 2 — Multi-Timeframe Confluence
| Timeframe | Trend | Key Signal | Bias |
|-----------|-------|-----------|------|
| **5m**  | Bajista | Rejection at MA20 | 🔴 BEARISH |
| **15m** | Bajista | Lower highs       | 🔴 BEARISH |
| **1H**  | Lateral | RSI 50            | 🟡 NEUTRAL |
| **4H**  | Bajista | MACD < 0          | 🔴 BEARISH |

**Confluence Score**: 3/4 timeframes aligned → STRONG.

## SECTION 8 — BIAS
[BIAS_BAR]
LONG: 25% | SHORT: 75%
[/BIAS_BAR]

## SECTION 9 — TRADE SETUPS

[TRADE_LONG]
ENTRY: $78,200 - $78,500
SL: $77,800
TP1: $79,200 (R:R 1:2.5)
TP2: $79,600 (R:R 1:3.5)
TP3: $80,000 (R:R 1:4.5)
SIZE: 1% of capital
[/TRADE_LONG]

[TRADE_SHORT]
ENTRY: $79,500 - $79,700
SL: $80,200
TP1: $78,800 (R:R 1:1.4)
TP2: $78,200 (R:R 1:2.6)
TP3: $77,500 (R:R 1:4.4)
SIZE: 1.5% of capital
[/TRADE_SHORT]

## PATTERNS
[PATTERN:double_top "forming on 1H"] and also [PATTERN:bear_flag]
`;

describe('extractDecision', () => {
  it('detects SHORT', () => {
    expect(extractDecision('🔴 ENTER NOW — SHORT')).toBe('SHORT');
  });
  it('detects LONG', () => {
    expect(extractDecision('🟢 ENTER NOW – LONG')).toBe('LONG');
  });
  it('detects WAIT', () => {
    expect(extractDecision('🟡 DO NOT ENTER — WAIT for confirmation')).toBe('WAIT');
  });
  it('returns null on empty', () => {
    expect(extractDecision('')).toBe(null);
    expect(extractDecision(null)).toBe(null);
  });
  it('returns null when no recognized phrase', () => {
    expect(extractDecision('Hello world, nothing here.')).toBe(null);
  });
});

describe('extractBias', () => {
  it('parses LONG/SHORT %', () => {
    const b = extractBias(SAMPLE);
    expect(b.long).toBe(25);
    expect(b.short).toBe(75);
  });
  it('caps at 100', () => {
    const b = extractBias('LONG: 999% | SHORT: 0%');
    expect(b.long).toBe(100);
  });
  it('handles missing tag gracefully', () => {
    const b = extractBias('no bias here');
    expect(b.long).toBe(null);
    expect(b.short).toBe(null);
  });
});

describe('extractConfluence', () => {
  it('returns one row per timeframe', () => {
    const rows = extractConfluence(SAMPLE);
    expect(rows).toHaveLength(4);
    expect(rows[0].tf).toBe('5m');
    expect(rows[0].bias).toBe('BEARISH');
    expect(rows[2].bias).toBe('NEUTRAL');
  });
  it('returns [] on bad input', () => {
    expect(extractConfluence(null)).toEqual([]);
    expect(extractConfluence('no table here')).toEqual([]);
  });
});

describe('extractConfluenceScore', () => {
  it('uses explicit score when present', () => {
    expect(extractConfluenceScore(SAMPLE)).toBe('3/4');
  });
  it('falls back to counting table rows', () => {
    const onlyTable = SAMPLE.replace(/Confluence Score.*/, '');
    expect(extractConfluenceScore(onlyTable)).toBe('3/4');
  });
});

describe('extractSetup', () => {
  it('parses LONG setup', () => {
    const s = extractSetup(SAMPLE, 'long');
    expect(s.entry).toBe('$78,200 - $78,500');
    expect(s.sl).toBe('$77,800');
    expect(s.tp1).toMatch(/79,200/);
    expect(s.size).toBe('1% of capital');
  });
  it('parses SHORT setup', () => {
    const s = extractSetup(SAMPLE, 'short');
    expect(s.entry).toBe('$79,500 - $79,700');
    expect(s.sl).toBe('$80,200');
  });
  it('returns null when tag missing', () => {
    expect(extractSetup('nothing', 'long')).toBe(null);
  });
});

describe('extractPatterns', () => {
  it('parses inline pattern tags', () => {
    const p = extractPatterns(SAMPLE);
    expect(p).toHaveLength(2);
    expect(p[0].id).toBe('double_top');
    expect(p[0].caption).toBe('forming on 1H');
    expect(p[1].id).toBe('bear_flag');
    expect(p[1].caption).toBe(null);
  });
});

describe('parseAll', () => {
  it('returns the full parsed shape', () => {
    const r = parseAll(SAMPLE);
    expect(r.decision).toBe('SHORT');
    expect(r.bias.short).toBe(75);
    expect(r.confluence).toHaveLength(4);
    expect(r.score).toBe('3/4');
    expect(r.setupLong).toBeTruthy();
    expect(r.setupShort).toBeTruthy();
    expect(r.patterns).toHaveLength(2);
  });
  it('tolerates malformed input without throwing', () => {
    expect(() => parseAll('garbage \x00 \x01 not a real response')).not.toThrow();
    expect(() => parseAll(null)).not.toThrow();
    expect(() => parseAll(undefined)).not.toThrow();
  });
});

describe('extractIndicators', () => {
  const RICH = `
## 📊 SECTION 4 — Indicator Confluence
- **RSI** (14): 32 (oversold zone), rebotando — alcista incipiente
- **MACD**: histograma negativo decreciente, divergencia bajista vs precio
- **Bollinger Bands**: precio rompió banda inferior, momentum bajista fuerte
- **Volume**: above average en la última vela, confirma la presión vendedora
`;
  it('parses well-structured indicator list', () => {
    const { extractIndicators } = parseAll(RICH);
    const list = extractIndicators ? extractIndicators(RICH) : parseAll(RICH).indicators;
    // parseAll already calls extractIndicators internally:
    const inds = parseAll(RICH).indicators;
    expect(inds.find(i => i.name === 'RSI')).toBeTruthy();
    expect(inds.find(i => i.name === 'MACD').signal).toBe('BEARISH');
    expect(inds.find(i => i.name === 'Volume').signal).toBe('BEARISH');
  });

  it('returns [] when nothing matches', () => {
    const inds = parseAll('no indicators here at all').indicators;
    expect(inds).toEqual([]);
  });

  it('does not invent random values from prose', () => {
    // The old regex matched mid-sentence. The new one requires bold/list + colon.
    const inds = parseAll('We see volume confirming the breakdown nicely.').indicators;
    const vol = inds.find(i => i.name === 'Volume');
    expect(vol).toBeUndefined();
  });
});

describe('section extractors', () => {
  const TEXT = `
## 🔑 SECTION 3 — Critical Levels
- Resistance: $80,200, $79,750
- Support: $78,800, $78,200

## ⚠️ SECTION 7 — Risk Factors
- Macro news at 14:00 ET
- Funding rate flipping positive
`;
  it('extracts critical levels block', () => {
    const r = parseAll(TEXT);
    expect(r.levels).toContain('Resistance');
    expect(r.levels).toContain('$80,200');
  });
  it('extracts risks block', () => {
    const r = parseAll(TEXT);
    expect(r.risks).toContain('Macro news');
  });
  it('returns null when section missing', () => {
    const r = parseAll('no sections at all');
    expect(r.levels).toBe(null);
    expect(r.risks).toBe(null);
  });
});
