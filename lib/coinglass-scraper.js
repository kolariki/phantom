/**
 * Coinglass scraper — uses a hidden Electron BrowserWindow to load
 * coinglass.com/currencies/{SYMBOL} and extract aggregated derivatives data:
 *   • Funding rate (avg across exchanges)
 *   • Open Interest + 24h change
 *   • Long/Short ratio (global)
 *   • 24h liquidations (long vs short)
 *   • Price + 24h change
 *
 * No login required — the data is public.
 * Cached for 60s per symbol.
 */

const { BrowserWindow } = require('electron');
const { createLogger } = require('./logger');

const log = createLogger('coinglass');
const CACHE_MS = 60 * 1000;
const cache = new Map(); // symbol -> { ts, data }

function buildUrl(symbol) {
  const clean = (symbol || 'BTC').toUpperCase()
    .replace(/USDT$|USD$|PERP$|\/.*$/g, '')
    .replace(/[^A-Z0-9]/g, '');
  return `https://www.coinglass.com/currencies/${clean}`;
}

function createWin() {
  return new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
}

/**
 * Extraction runs inside the page context. We pull from data attributes when
 * available, and fall back to scraping rendered text. Returns a flat object.
 */
function buildExtractScript() {
  // The renderer-side script. Parses the human-readable "Bitcoin Trading Overview"
  // and "Bitcoin Price Live" text blocks at the bottom of the page plus the
  // top header strip. This is far more stable than chasing divs across React
  // class hashes that change on every Coinglass release.
  return `(function() {
    function suffixed(s) {
      if (!s) return null;
      const m = String(s).replace(/\\s/g, '').match(/(-?[\\d.,]+)\\s*([KMBT])?/i);
      if (!m) return null;
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (isNaN(n)) return null;
      const mul = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || '').toUpperCase()];
      if (mul) n *= mul;
      return n;
    }

    const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';

    // ─── 1. "Bitcoin Trading Overview" prose block (most reliable) ───
    let spot_volume_24h = null, futures_volume_24h = null, liquidations_24h_total = null, open_interest = null;
    const overview = bodyText.match(/Trading Overview[\\s\\S]{0,800}/);
    if (overview) {
      const t = overview[0];
      let m;
      if ((m = t.match(/spot trading volume was\\s+([\\d,]+)\\s*USD/i))) spot_volume_24h = parseFloat(m[1].replace(/,/g, ''));
      if ((m = t.match(/futures trading volume was\\s+([\\d,]+)\\s*USD/i))) futures_volume_24h = parseFloat(m[1].replace(/,/g, ''));
      if ((m = t.match(/([\\d,]+)\\s*USD in\\s+\\S+\\s+futures positions were liquidated/i))) liquidations_24h_total = parseFloat(m[1].replace(/,/g, ''));
      if ((m = t.match(/open interest of [^\\s]+ is\\s+([\\d,]+)\\s*USD/i))) open_interest = parseFloat(m[1].replace(/,/g, ''));
    }

    // ─── 2. "Bitcoin Price Live" prose block ───
    let price = null, change_24h_pct = null, change_7d_pct = null, market_cap = null, circulating_supply = null;
    const live = bodyText.match(/Price Live[\\s\\S]{0,500}/);
    if (live) {
      const t = live[0];
      let m;
      if ((m = t.match(/current price of [^\\s]+ \\([A-Z]+\\) is\\s+([\\d,.]+)\\s*USD/i))) price = parseFloat(m[1].replace(/,/g, ''));
      if ((m = t.match(/past 24 hours,\\s+\\S+\\s+price (Up|Down)\\s+([+\\-]?[\\d.]+)%/i))) {
        change_24h_pct = (m[1].toLowerCase() === 'down' ? -1 : 1) * parseFloat(m[2]);
      }
      if ((m = t.match(/past 7 days,\\s+\\S+\\s+price (Up|Down)\\s+([+\\-]?[\\d.]+)%/i))) {
        change_7d_pct = (m[1].toLowerCase() === 'down' ? -1 : 1) * parseFloat(m[2]);
      }
      if ((m = t.match(/market capitalization of\\s+([\\d,]+)\\s*USD/i))) market_cap = parseFloat(m[1].replace(/,/g, ''));
      if ((m = t.match(/circulating supply of [^\\s]+ is\\s+([\\d,]+)/i))) circulating_supply = parseFloat(m[1].replace(/,/g, ''));
    }

    // ─── 3. Header strip pattern: "24h Long/Short 50.2%/49.8%" ───
    let global_long_pct = null, global_short_pct = null;
    const ls = bodyText.match(/24h Long\\/Short\\s*(\\d+(?:\\.\\d+)?)\\s*%\\s*\\/\\s*(\\d+(?:\\.\\d+)?)\\s*%/i);
    if (ls) { global_long_pct = parseFloat(ls[1]); global_short_pct = parseFloat(ls[2]); }

    // ─── 4. Binance Top Trader L/S Ratio (best signal of smart-money positioning) ───
    let long_short_ratio = null;
    let lsRow = bodyText.match(/Top Trader Long\\/Short \\(Positions\\)\\s*([\\d.]+)/i);
    if (!lsRow) lsRow = bodyText.match(/Top Trader Long\\/Short \\(Accounts\\)\\s*([\\d.]+)/i);
    if (!lsRow) lsRow = bodyText.match(/Long\\/Short Ratio\\(Accounts\\)\\s*([\\d.]+)/i);
    if (lsRow) long_short_ratio = parseFloat(lsRow[1]);

    // ─── 5. 24h liquidation breakdown: "24h Rekt $83.50M Long $62.25M Short $21.25M" ───
    let long_liquidations_24h = null, short_liquidations_24h = null;
    const rekt = bodyText.match(/24h Rekt\\s*\\$[\\d.,]+[KMBT]?\\s*Long\\s*\\$([\\d.,]+[KMBT]?)\\s*Short\\s*\\$([\\d.,]+[KMBT]?)/i);
    if (rekt) {
      long_liquidations_24h = suffixed(rekt[1]);
      short_liquidations_24h = suffixed(rekt[2]);
    }

    // ─── 6. OI 24h % change from header strip ("Open Interest $134B +0.16%") ───
    let oi_change_24h_pct = null;
    const oiHeader = bodyText.match(/Open Interest\\s*\\$[\\d.,]+[KMBT]?\\s*([+\\-]?[\\d.]+)\\s*%/i);
    if (oiHeader) oi_change_24h_pct = parseFloat(oiHeader[1]);

    // NOTE: funding rate is NOT scraped from Coinglass — it lives inside a
    // chart canvas (not in DOM text), so any regex match would be a label or
    // tooltip artifact, not the current value. We rely on the exchange API
    // (KuCoin/Binance) for funding rate, which is exact and real-time.

    const out = {
      price,
      change_24h_pct,
      change_7d_pct,
      market_cap,
      open_interest,
      oi_change_24h_pct,
      futures_volume_24h,
      spot_volume_24h,
      liquidations_24h_total,
      long_liquidations_24h,
      short_liquidations_24h,
      long_short_ratio,
      global_long_pct,
      global_short_pct,
      circulating_supply
    };
    // Count meaningful fields so the caller can decide whether to include the block.
    const keys = ['price', 'open_interest', 'liquidations_24h_total', 'long_short_ratio', 'futures_volume_24h', 'change_24h_pct'];
    out._meaningful_fields = keys.filter(k => out[k] != null).length;
    return out;
  })();`;
}

async function fetchCoinglass(symbol) {
  const url = buildUrl(symbol);
  const key = url;
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.ts) < CACHE_MS) return cached.data;

  const win = createWin();
  let data = null;
  try {
    await win.loadURL(url).catch(() => {});
    // Coinglass is a SPA — give it time to hydrate.
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const probe = await win.webContents.executeJavaScript(`
        document.querySelectorAll('table, [class*="card"], [class*="cell"]').length
      `).catch(() => 0);
      if (probe >= 10) break;
    }
    data = await win.webContents.executeJavaScript(buildExtractScript()).catch(() => null);
  } catch (e) {
    log.warn('fetch failed', e);
  } finally {
    win.destroy();
  }

  if (data) {
    cache.set(key, { ts: Date.now(), data });
    log.info('fetched coinglass', { symbol, meaningful: data._meaningful_fields });
  }
  return data;
}

/** Format the coinglass dataset for inclusion in the AI prompt. */
function formatForPrompt(data, symbol) {
  if (!data || !data._meaningful_fields || data._meaningful_fields === 0) return '';
  const M = 1e6, B = 1e9;
  const fmtB = (n) => '$' + (n / B).toFixed(2) + 'B';
  const fmtM = (n) => '$' + (n / M).toFixed(1) + 'M';
  const fmtPct = (n) => (n >= 0 ? '+' : '') + n + '%';

  const lines = [];
  lines.push(`COINGLASS AGGREGATED DATA (${symbol}, real-time public data):`);

  if (data.price != null) {
    let priceLine = `- Price: $${data.price.toLocaleString()}`;
    if (data.change_24h_pct != null) priceLine += ` (${fmtPct(data.change_24h_pct)} 24h)`;
    if (data.change_7d_pct != null)  priceLine += ` · ${fmtPct(data.change_7d_pct)} 7d`;
    lines.push(priceLine);
  }
  if (data.market_cap != null)          lines.push(`- Market Cap: ${fmtB(data.market_cap)}`);

  if (data.open_interest != null) {
    let oiLine = `- Open Interest (aggregated all exchanges): ${fmtB(data.open_interest)}`;
    if (data.oi_change_24h_pct != null) oiLine += ` (${fmtPct(data.oi_change_24h_pct)} 24h)`;
    lines.push(oiLine);
  }
  if (data.futures_volume_24h != null)  lines.push(`- 24h Futures Volume: ${fmtB(data.futures_volume_24h)}`);
  if (data.spot_volume_24h != null)     lines.push(`- 24h Spot Volume: ${fmtB(data.spot_volume_24h)}`);

  // Funding rate intentionally NOT included from Coinglass — see scraper notes.
  // The exchange API block (KuCoin/Binance) supplies the live funding rate.

  if (data.global_long_pct != null && data.global_short_pct != null) {
    lines.push(`- 24h Global Long/Short: ${data.global_long_pct}% long / ${data.global_short_pct}% short`);
  }
  if (data.long_short_ratio != null) {
    lines.push(`- Binance Top Trader L/S Ratio (smart money positioning): ${data.long_short_ratio}`);
  }

  if (data.liquidations_24h_total != null) {
    lines.push(`- 24h Total Liquidations: ${fmtM(data.liquidations_24h_total)}`);
  }
  if (data.long_liquidations_24h != null && data.short_liquidations_24h != null) {
    const longLiq = fmtM(data.long_liquidations_24h);
    const shortLiq = fmtM(data.short_liquidations_24h);
    const bias = data.long_liquidations_24h > data.short_liquidations_24h ? 'longs got squeezed harder' : 'shorts got squeezed harder';
    lines.push(`  • Longs rekt: ${longLiq} | Shorts rekt: ${shortLiq} → ${bias}`);
  }

  lines.push('');
  lines.push('SOURCE: coinglass.com/currencies/' + symbol + ' — these are AGGREGATED numbers across all exchanges, more representative than any single exchange.');
  return lines.join('\n');
}

module.exports = {
  fetchCoinglass,
  formatForPrompt,
  buildUrl,
  _internal: { buildExtractScript }
};
