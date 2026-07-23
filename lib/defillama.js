/**
 * DefiLlama public API — totally open, no auth needed.
 *
 * Two macro signals:
 *   a) Stablecoin total market cap — rising = dry powder entering crypto,
 *      falling = capital leaving. Major leading indicator for risk-on/off.
 *   b) Per-stable breakdown — USDT vs USDC vs DAI flows reveal whether the
 *      inflow is retail (USDT) or institutional (USDC).
 *
 * Cached for 5 min per call (the underlying data updates daily anyway).
 */

const https = require('https');
const { createLogger } = require('./logger');

const log = createLogger('defillama');
const HOST = 'stablecoins.llama.fi';

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function httpsJSON(path, timeoutMs = 8000) {
  const cached = cache.get(path);
  if (cached && (Date.now() - cached.ts) < CACHE_MS) return Promise.resolve(cached.data);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Phantom-Desktop/1.0' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try {
          const data = JSON.parse(text);
          cache.set(path, { ts: Date.now(), data });
          resolve(data);
        } catch (e) { reject(new Error('Bad JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('defillama timeout')); });
    req.end();
  });
}

/** Build the per-stablecoin breakdown from the list endpoint. */
async function fetchStablecoinFlows() {
  const json = await httpsJSON('/stablecoins?includePrices=true');
  if (!json || !Array.isArray(json.peggedAssets)) return null;

  // Sum across chains for the major USD-pegged stables.
  function totalUSD(pegged) {
    if (!pegged) return null;
    const c = pegged.circulating || {};
    // Aggregate every currency_peg variant we find that's USD.
    return parseFloat(c.peggedUSD || c.peggedVAR || c.peggedEUR || c.peggedJPY || 0) || null;
  }
  function prev1d(pegged)  { return totalUSD(pegged.circulatingPrevDay  ? { circulating: pegged.circulatingPrevDay }  : null); }
  function prev7d(pegged)  { return totalUSD(pegged.circulatingPrevWeek ? { circulating: pegged.circulatingPrevWeek } : null); }
  function prev30d(pegged) { return totalUSD(pegged.circulatingPrevMonth? { circulating: pegged.circulatingPrevMonth}: null); }

  const top = ['Tether', 'USDC', 'Dai', 'FDUSD', 'TrueUSD', 'PYUSD'];
  const breakdown = {};
  let total = 0, total1d = 0, total7d = 0, total30d = 0;

  for (const p of json.peggedAssets) {
    const cur = totalUSD(p);
    if (cur == null) continue;
    total += cur;
    const p1 = prev1d(p);   if (p1  != null) total1d  += p1;
    const p7 = prev7d(p);   if (p7  != null) total7d  += p7;
    const p30 = prev30d(p); if (p30 != null) total30d += p30;
    if (top.includes(p.name)) {
      breakdown[p.name] = {
        circulating: cur,
        prev_1d: p1,
        prev_7d: p7,
        delta_1d_pct: (p1  != null && p1 > 0)  ? ((cur - p1)  / p1)  * 100 : null,
        delta_7d_pct: (p7  != null && p7 > 0)  ? ((cur - p7)  / p7)  * 100 : null
      };
    }
  }

  return {
    total_market_cap_usd: total,
    delta_1d_usd:  total1d  ? total - total1d  : null,
    delta_1d_pct:  total1d  ? ((total - total1d)  / total1d)  * 100 : null,
    delta_7d_pct:  total7d  ? ((total - total7d)  / total7d)  * 100 : null,
    delta_30d_pct: total30d ? ((total - total30d) / total30d) * 100 : null,
    breakdown
  };
}

/* ─── Format for AI prompt ─── */
function formatForPrompt(data) {
  if (!data || !data.total_market_cap_usd) return '';
  const lines = [];
  lines.push('MACRO LIQUIDITY (DefiLlama — global stablecoin market cap, dry powder for crypto):');

  const totB = (data.total_market_cap_usd / 1e9).toFixed(2);
  const d1 = data.delta_1d_pct;
  const d7 = data.delta_7d_pct;
  const d30 = data.delta_30d_pct;

  lines.push(`- Total stablecoin mcap: $${totB}B`);
  if (d1  != null) lines.push(`  • 24h change: ${d1  >= 0 ? '+' : ''}${d1.toFixed(3)}% ($${((data.delta_1d_usd || 0) / 1e6).toFixed(0)}M)`);
  if (d7  != null) lines.push(`  • 7d change:  ${d7  >= 0 ? '+' : ''}${d7.toFixed(2)}%`);
  if (d30 != null) lines.push(`  • 30d change: ${d30 >= 0 ? '+' : ''}${d30.toFixed(2)}%`);

  // Per-stable breakdown highlights composition.
  const breakdown = data.breakdown || {};
  const lines2 = [];
  for (const [name, info] of Object.entries(breakdown)) {
    if (info.circulating > 1e9) {
      const d = info.delta_1d_pct;
      const tag = d == null ? '' : ` (${d >= 0 ? '+' : ''}${d.toFixed(2)}% 24h)`;
      lines2.push(`  • ${name}: $${(info.circulating / 1e9).toFixed(2)}B${tag}`);
    }
  }
  if (lines2.length) {
    lines.push('- By stablecoin:');
    lines.push(...lines2);
  }

  // Verdict
  let verdict = 'neutral';
  if (d1 != null) {
    if (d1 > 0.3)        verdict = 'STRONG INFLOW (capital entering crypto rapidly — bullish setup for risk assets)';
    else if (d1 > 0.05)  verdict = 'mild inflow (gradual buy-side capital)';
    else if (d1 < -0.3)  verdict = 'STRONG OUTFLOW (capital exiting crypto — bearish backdrop)';
    else if (d1 < -0.05) verdict = 'mild outflow';
  }
  lines.push(`- Liquidity verdict (24h): ${verdict}`);

  lines.push('');
  lines.push('MACRO INTERPRETATION:');
  lines.push('- Rising stablecoin mcap = dry powder accumulating, often precedes a coordinated rally.');
  lines.push('- Falling mcap = capital being redeemed off-chain, bearish backdrop.');
  lines.push('- USDC growth > USDT growth = institutional flow leading (high-quality). USDT growth = retail.');
  lines.push('- Use this for MACRO BIAS only — does not predict timing.');
  return lines.join('\n');
}

module.exports = {
  fetchStablecoinFlows,
  formatForPrompt
};
