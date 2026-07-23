/**
 * Pure functions that extract structured data from the AI's trading response.
 * Every extractor returns null/[] on failure rather than throwing — the
 * caller can mix-and-match what was actually parseable. No DOM, no IPC,
 * fully testable in node.
 */

function safe(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

function extractDecision(text) {
  return safe(() => {
    if (!text) return null;
    if (/ENTER\s*NOW\s*[—–-]\s*LONG/i.test(text))  return 'LONG';
    if (/ENTER\s*NOW\s*[—–-]\s*SHORT/i.test(text)) return 'SHORT';
    if (/DO\s*NOT\s*ENTER|NO\s*ENTRAR|WAIT/i.test(text)) return 'WAIT';
    return null;
  }, null);
}

function extractBias(text) {
  return safe(() => {
    if (!text) return { long: null, short: null };
    const m = text.match(/\[BIAS_BAR\]([\s\S]*?)\[\/BIAS_BAR\]/i);
    const block = m ? m[1] : text;
    const longM  = block.match(/LONG[^0-9]*(\d{1,3})\s*%/i);
    const shortM = block.match(/SHORT[^0-9]*(\d{1,3})\s*%/i);
    return {
      long:  longM  ? Math.min(100, parseInt(longM[1], 10))  : null,
      short: shortM ? Math.min(100, parseInt(shortM[1], 10)) : null
    };
  }, { long: null, short: null });
}

function extractConfluence(text) {
  return safe(() => {
    if (!text) return [];
    const re = /\|\s*\*{0,2}(5m|15m|1H|4H)\*{0,2}\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/gi;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const biasText = m[4].replace(/[🟢🔴🟡\*]/g, '').trim().toUpperCase();
      let bias = 'NEUTRAL';
      if (/BULL|ALCIST/i.test(biasText)) bias = 'BULLISH';
      else if (/BEAR|BAJIST/i.test(biasText)) bias = 'BEARISH';
      out.push({
        tf: m[1],
        trend:  m[2].replace(/\*/g, '').trim(),
        signal: m[3].replace(/\*/g, '').trim().slice(0, 60),
        bias
      });
    }
    return out;
  }, []);
}

function extractConfluenceScore(text) {
  return safe(() => {
    if (!text) return null;
    // Prefer explicit "Confluence Score: X/4" but fall back to counting the table.
    const m = text.match(/Confluence\s*Score[:\s]*\**\s*(\d)\s*\/\s*4/i);
    if (m) return m[1] + '/4';
    const rows = extractConfluence(text);
    if (rows.length === 0) return null;
    const counts = rows.reduce((acc, r) => {
      acc[r.bias] = (acc[r.bias] || 0) + 1;
      return acc;
    }, {});
    const top = Math.max(counts.BULLISH || 0, counts.BEARISH || 0);
    return top + '/' + rows.length;
  }, null);
}

function extractSetup(text, side) {
  return safe(() => {
    if (!text) return null;
    const tag = side === 'short' ? 'TRADE_SHORT' : 'TRADE_LONG';
    const re = new RegExp('\\[' + tag + '\\]([\\s\\S]*?)\\[\\/' + tag + '\\]', 'i');
    const m = text.match(re);
    if (!m) return null;
    const block = m[1];
    const extract = (key) => {
      const rx = new RegExp(key + '\\s*[:=]\\s*([^\\n]+)', 'i');
      const km = block.match(rx);
      return km ? km[1].trim() : null;
    };
    return {
      entry: extract('ENTRY'),
      sl:    extract('SL'),
      tp1:   extract('TP1'),
      tp2:   extract('TP2'),
      tp3:   extract('TP3'),
      rr:    extract('R:R') || extract('RR'),
      size:  extract('SIZE')
    };
  }, null);
}

/** Pull the body of a section identified by its emoji + title keyword(s). */
function extractSection(text, keywords) {
  return safe(() => {
    if (!text) return null;
    // Section headers look like "## 🔑 SECTION 3 — Critical Levels" or "## 📊 SECTION 4 — Indicator Confluence".
    // Split on lines that look like headers and find the block whose title matches any keyword.
    const lines = text.split(/\r?\n/);
    let captureFrom = -1;
    let captureTo = lines.length;
    const kwRx = new RegExp('(' + keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isHeader = /^\s*#{1,3}\s+/.test(line);
      if (isHeader) {
        if (captureFrom === -1 && kwRx.test(line)) {
          captureFrom = i + 1;
        } else if (captureFrom !== -1) {
          captureTo = i;
          break;
        }
      }
    }
    if (captureFrom === -1) return null;
    return lines.slice(captureFrom, captureTo).join('\n').trim();
  }, null);
}

/** Extract indicator readings: lines like "**RSI**: 32 (oversold)" or "- RSI: ...". */
function extractIndicators(text, knownNames) {
  return safe(() => {
    if (!text) return [];
    const section = extractSection(text, ['indicator', 'indicador']) || text;
    const names = (knownNames && knownNames.length)
      ? knownNames
      : ['RSI', 'MACD', 'Bollinger', 'EMA', 'SMA', 'VWAP', 'Stochastic', 'ADX', 'ATR', 'Volume', 'CCI', 'Ichimoku', 'Supertrend', 'OBV', 'MFI', 'Williams', 'Parabolic SAR', 'Keltner', 'Donchian', 'DMI', 'TRIX', 'ROC', 'CMF', 'Pivot'];
    const out = [];
    const seen = new Set();

    for (const name of names) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match: **Name** [optional (params)]: reading   OR   - Name: reading
      const rx = new RegExp(
        '(?:^|\\n)\\s*[-*]?\\s*\\*{0,2}' + esc + '[^\\n:]{0,40}:\\s*([^\\n]{3,180})',
        'i'
      );
      const m = section.match(rx);
      if (m) {
        const key = name.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const raw = m[1].replace(/\*{1,2}/g, '').trim();
        // Score-based to handle texts containing both bull and bear words.
        // Strong/specific keywords win over ambiguous positional ones.
        let bullScore = 0;
        let bearScore = 0;
        const tests = [
          { rx: /\b(bull|alcist|cruce alcista|breakout|reboto|recuperando|presión compradora|momentum alcista|impulso alcista|compra)\b/i, w: 2, side: 'bull' },
          { rx: /\b(long|above ma|por encima de (la )?(ema|sma|ma))\b/i,                                                                w: 1, side: 'bull' },
          { rx: /\b(bear|bajist|cruce bajista|breakdown|rechazo|presión vendedora|momentum bajista|impulso bajista|venta|debilidad)\b/i,  w: 2, side: 'bear' },
          { rx: /\b(short|below ma|por debajo de (la )?(ema|sma|ma)|negativ)\w*\b/i,                                                       w: 1, side: 'bear' }
        ];
        for (const t of tests) {
          if (t.rx.test(raw)) (t.side === 'bull' ? (bullScore += t.w) : (bearScore += t.w));
        }
        let signal = 'NEUTRAL';
        if (bullScore > bearScore)      signal = 'BULLISH';
        else if (bearScore > bullScore) signal = 'BEARISH';
        out.push({ name, value: raw.slice(0, 160), signal });
      }
    }
    return out;
  }, []);
}

function extractCriticalLevels(text) {
  return safe(() => {
    const section = extractSection(text, ['critical levels', 'niveles cr', 'soportes', 'resistencia', 'key levels']);
    if (!section) return null;
    return section.slice(0, 1200);
  }, null);
}

function extractRisks(text) {
  return safe(() => {
    const section = extractSection(text, ['risk factor', 'riesgo', 'risk']);
    if (!section) return null;
    return section.slice(0, 900);
  }, null);
}

function extractRecommendedStrategies(text) {
  return safe(() => {
    const section = extractSection(text, ['recommended strateg', 'estrategias recomendadas']);
    if (!section) return null;
    return section.slice(0, 1200);
  }, null);
}

function extractSummary(text) {
  return safe(() => {
    if (!text) return null;
    const m = text.search(/ENTER NOW|DO NOT ENTER|NO ENTRAR/i);
    if (m === -1) return null;
    const after = text.slice(m).split('\n').slice(1).filter(l => l.trim() && !/^[=#\-\*|]/.test(l.trim()));
    return after.slice(0, 6).join(' ').replace(/\*{1,2}/g, '').slice(0, 900) || null;
  }, null);
}

function extractPatterns(text) {
  return safe(() => {
    if (!text) return [];
    const re = /\[PATTERN:([a-z_]+)(?:\s*"([^"]*)")?\]/gi;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ id: m[1], caption: m[2] || null });
    }
    return out;
  }, []);
}

function parseAll(text, opts) {
  const knownIndicatorNames = (opts && opts.indicatorNames) || null;
  return {
    decision:    extractDecision(text),
    bias:        extractBias(text),
    confluence:  extractConfluence(text),
    score:       extractConfluenceScore(text),
    setupLong:   extractSetup(text, 'long'),
    setupShort:  extractSetup(text, 'short'),
    patterns:    extractPatterns(text),
    indicators:  extractIndicators(text, knownIndicatorNames),
    levels:      extractCriticalLevels(text),
    risks:       extractRisks(text),
    strategies:  extractRecommendedStrategies(text),
    summary:     extractSummary(text)
  };
}

const api = {
  extractDecision,
  extractBias,
  extractConfluence,
  extractConfluenceScore,
  extractSetup,
  extractSection,
  extractIndicators,
  extractCriticalLevels,
  extractRisks,
  extractRecommendedStrategies,
  extractSummary,
  extractPatterns,
  parseAll
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.AIResponseParser = api;
}
