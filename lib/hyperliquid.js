/**
 * Hyperliquid public API — POST https://api.hyperliquid.xyz/info
 *
 * Two complementary signals:
 *   a) Asset context (metaAndAssetCtxs) — Hyperliquid's own per-coin perp stats:
 *      mark price, funding, OI, premium. Comparing to centralized exchanges
 *      reveals DEX-vs-CEX positioning divergence.
 *   b) Known whale wallets (clearinghouseState) — public addresses of large
 *      perp traders. For each, pull their current position in the requested
 *      asset. Aggregate: N long vs N short, biggest position size, net delta.
 *
 * The whale list is curated from public sources (Hyperliquid leaderboards,
 * LookOnChain reports). Stale addresses fail open — they just return null
 * positions and contribute nothing. The list can be updated freely.
 */

const https = require('https');
const { createLogger } = require('./logger');

const log = createLogger('hyperliquid');
const HOST = 'api.hyperliquid.xyz';

/**
 * Public addresses of large Hyperliquid traders. Sources: Hyperliquid's
 * public leaderboard at app.hyperliquid.xyz/leaderboard, plus addresses
 * tagged by LookOnChain / Arkham. Update freely.
 */
const KNOWN_WHALES = [
  // James Wynn — famously big perp trader on Hyperliquid
  { label: 'James Wynn',          address: '0x5078c2fbea2b2ad61bc840bc023e35fce56bedb6' },
  // Other publicly visible top accounts (placeholders — update from leaderboard)
  { label: 'Hyper Whale A',       address: '0xa2d8db4ff8d7f3e21f9bde2e3a64f3c4a64bf4b1' },
  { label: 'Hyper Whale B',       address: '0xf3f496c9486be5924a93d67e98298733bb47057c' },
  { label: 'Hyper Whale C',       address: '0xd35e9c1eb13b3f8c8df6e5e0f4d35d3fe8f1bdec' },
  { label: 'Hyper Whale D',       address: '0xe7a067ee9c6f0e8a01b8b2d96f3a18d44a9b0c1f' }
];

function postJSON(body, timeoutMs = 6000) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path: '/info',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'User-Agent': 'Phantom-Desktop/1.0'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('Bad JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('hyperliquid timeout')); });
    req.write(data);
    req.end();
  });
}

/** Normalize "BTC/USDT" / "BTCUSDT" / "btc" → "BTC". Hyperliquid uses bare tickers. */
function toHLSymbol(asset) {
  const s = String(asset || 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.replace(/USDT$|BUSD$|USDC$|USD$|PERP$/, '') || 'BTC';
}

/**
 * Returns Hyperliquid's own perp stats for the asset:
 *   mark price, funding rate, OI ($), premium, day's volume, etc.
 */
async function fetchAssetContext(symbol) {
  const data = await postJSON({ type: 'metaAndAssetCtxs' });
  if (!Array.isArray(data) || data.length < 2) return null;
  const [meta, ctxs] = data;
  const idx = meta && meta.universe ? meta.universe.findIndex(u => u.name === symbol) : -1;
  if (idx < 0 || !ctxs[idx]) return null;
  const c = ctxs[idx];
  const mark = parseFloat(c.markPx);
  const oracle = parseFloat(c.oraclePx);
  const oi = parseFloat(c.openInterest);
  const funding = parseFloat(c.funding);
  const dayVolUsd = parseFloat(c.dayNtlVlm);
  const premiumPct = (mark && oracle) ? ((mark - oracle) / oracle) * 100 : null;
  return {
    symbol,
    mark_price: isNaN(mark) ? null : mark,
    oracle_price: isNaN(oracle) ? null : oracle,
    premium_pct: premiumPct,
    funding_rate: isNaN(funding) ? null : funding,            // already a decimal per-hour rate
    funding_rate_annualized_pct: isNaN(funding) ? null : funding * 24 * 365 * 100,
    open_interest_coin: isNaN(oi) ? null : oi,
    open_interest_usd: (isNaN(oi) || isNaN(mark)) ? null : oi * mark,
    day_volume_usd: isNaN(dayVolUsd) ? null : dayVolUsd
  };
}

/** Pull a single user's clearinghouseState and extract their position in `symbol`. */
async function fetchWhalePosition(address, symbol) {
  try {
    const state = await postJSON({ type: 'clearinghouseState', user: address });
    if (!state || !Array.isArray(state.assetPositions)) return null;
    const pos = state.assetPositions.find(p => p.position && p.position.coin === symbol);
    if (!pos || !pos.position) return null;
    const size = parseFloat(pos.position.szi);
    const entry = parseFloat(pos.position.entryPx);
    const liq = parseFloat(pos.position.liquidationPx);
    const upnl = parseFloat(pos.position.unrealizedPnl);
    const lev = pos.position.leverage ? parseFloat(pos.position.leverage.value) : null;
    if (!size || isNaN(size)) return null;
    return {
      side: size > 0 ? 'LONG' : 'SHORT',
      size_coin: Math.abs(size),
      entry_price: isNaN(entry) ? null : entry,
      liquidation_price: isNaN(liq) ? null : liq,
      unrealized_pnl_usd: isNaN(upnl) ? null : upnl,
      leverage: isNaN(lev) ? null : lev,
      account_equity_usd: state.marginSummary ? parseFloat(state.marginSummary.accountValue) : null
    };
  } catch (e) {
    return null;
  }
}

/** Pull positions for all configured whales for the given asset, in parallel. */
async function fetchWhalePositions(symbol) {
  const results = await Promise.all(
    KNOWN_WHALES.map(async w => {
      const pos = await fetchWhalePosition(w.address, symbol);
      return pos ? { ...w, ...pos } : null;
    })
  );
  const open = results.filter(Boolean);
  if (open.length === 0) return null;

  const longs  = open.filter(w => w.side === 'LONG');
  const shorts = open.filter(w => w.side === 'SHORT');
  const sumSize = (arr) => arr.reduce((s, w) => s + (w.size_coin || 0), 0);
  const longSize = sumSize(longs);
  const shortSize = sumSize(shorts);

  return {
    total_whales_in_position: open.length,
    longs: longs.length,
    shorts: shorts.length,
    long_size_coin: longSize,
    short_size_coin: shortSize,
    net_size_coin: longSize - shortSize,
    biggest: [...open].sort((a, b) => b.size_coin - a.size_coin).slice(0, 3),
    sample_size: KNOWN_WHALES.length
  };
}

/* ─── Top-level orchestrator ─── */
async function fetchHyperliquid(asset) {
  const symbol = toHLSymbol(asset);
  const errors = {};
  const safe = (p, key) => p.catch(err => {
    errors[key] = err && err.message ? err.message.slice(0, 200) : 'error';
    return null;
  });
  const [ctx, whales] = await Promise.all([
    safe(fetchAssetContext(symbol),    'asset_context'),
    safe(fetchWhalePositions(symbol),  'whale_positions')
  ]);
  log.info('fetched hyperliquid', { symbol, has_ctx: !!ctx, whale_count: whales ? whales.total_whales_in_position : 0 });
  return { symbol, ctx, whales, errors: Object.keys(errors).length ? errors : null };
}

/* ─── Format for AI prompt ─── */
function formatForPrompt(data) {
  if (!data || (!data.ctx && !data.whales)) return '';
  const lines = [];
  lines.push(`HYPERLIQUID DEX DATA (${data.symbol}, on-chain perpetuals — different population than CEX):`);

  if (data.ctx) {
    const c = data.ctx;
    lines.push('Hyperliquid perp context:');
    if (c.mark_price != null)         lines.push(`  • Mark: $${c.mark_price} | Oracle: $${c.oracle_price ?? '?'}`);
    if (c.premium_pct != null) {
      const verdict = c.premium_pct > 0.05 ? 'HL premium (DEX longs more aggressive)' :
                      c.premium_pct < -0.05 ? 'HL discount (DEX shorts more aggressive)' :
                                              'no significant premium';
      lines.push(`  • Premium vs oracle: ${c.premium_pct >= 0 ? '+' : ''}${c.premium_pct.toFixed(4)}% → ${verdict}`);
    }
    if (c.funding_rate_annualized_pct != null) {
      const f = c.funding_rate_annualized_pct;
      lines.push(`  • Funding rate (annualized): ${f >= 0 ? '+' : ''}${f.toFixed(2)}% — ${f > 0 ? 'longs pay shorts' : 'shorts pay longs'}`);
    }
    if (c.open_interest_usd != null)  lines.push(`  • OI on Hyperliquid: $${(c.open_interest_usd / 1e6).toFixed(1)}M`);
    if (c.day_volume_usd != null)     lines.push(`  • 24h volume: $${(c.day_volume_usd / 1e6).toFixed(1)}M`);
  }

  if (data.whales) {
    const w = data.whales;
    lines.push('Tracked whales (curated public addresses):');
    lines.push(`  • ${w.total_whales_in_position}/${w.sample_size} whales currently positioned in ${data.symbol}`);
    lines.push(`  • ${w.longs} long (${w.long_size_coin.toFixed(2)} ${data.symbol}) vs ${w.shorts} short (${w.short_size_coin.toFixed(2)} ${data.symbol})`);
    const netBias = w.net_size_coin > 0 ? 'NET LONG (whales accumulating)' :
                    w.net_size_coin < 0 ? 'NET SHORT (whales positioned for downside)' :
                                          'NET FLAT';
    lines.push(`  • Net delta: ${w.net_size_coin >= 0 ? '+' : ''}${w.net_size_coin.toFixed(2)} ${data.symbol} → ${netBias}`);
    if (w.biggest && w.biggest.length) {
      lines.push('  • Biggest positions:');
      for (const b of w.biggest) {
        const equity = b.account_equity_usd ? ` | acct equity $${(b.account_equity_usd / 1e6).toFixed(2)}M` : '';
        const pnl = b.unrealized_pnl_usd != null ? ` | uPnL ${b.unrealized_pnl_usd >= 0 ? '+' : ''}$${b.unrealized_pnl_usd.toFixed(0)}` : '';
        lines.push(`    - ${b.label}: ${b.side} ${b.size_coin.toFixed(2)} @ $${b.entry_price ?? '?'}${equity}${pnl}`);
      }
    }
  }

  lines.push('');
  lines.push('HYPERLIQUID INTERPRETATION:');
  lines.push('- Premium > 0 vs oracle = DEX longs paying up (bullish demand on-chain).');
  lines.push('- Whales NET LONG diverging from retail SHORT = follow whales.');
  lines.push('- Big single whale with extreme leverage = potential cascade if it gets liquidated.');
  lines.push('- HL funding diverging from CEX funding = on-chain vs off-chain positioning split (interesting signal).');
  return lines.join('\n');
}

module.exports = {
  fetchHyperliquid,
  formatForPrompt,
  toHLSymbol,
  KNOWN_WHALES,
  _internal: { fetchAssetContext, fetchWhalePosition }
};
