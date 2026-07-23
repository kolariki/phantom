/**
 * Trade tape analysis — pulls the last ~1000 aggregated trades from Binance
 * Futures public endpoint and derives 4 high-value signals:
 *
 *   1) WHALE PRINTS     — top N largest trades by notional, with side/price/time
 *   2) CVD              — Cumulative Volume Delta over the window (net pressure)
 *   3) VOLUME PROFILE   — top price bins by total volume (where the action is)
 *   4) BUY/SELL RATIO   — aggregate ratio for the window
 *
 * Endpoint: GET /fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000  (no auth)
 * Returns recent ~5-15 min of activity depending on volatility.
 *
 * Binance flag semantics:
 *   m=true  → buyer was MAKER → seller hit the bid → AGGRESSIVE SELL
 *   m=false → buyer was TAKER → buyer hit the ask → AGGRESSIVE BUY
 */

const https = require('https');
const { createLogger } = require('./logger');

const log = createLogger('trade-tape');
const HOST = 'fapi.binance.com';

function httpsJSON(path, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path, method: 'GET',
      headers: { 'User-Agent': 'Phantom-Desktop/1.0' }
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
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('trade-tape timeout')); });
    req.end();
  });
}

function toBinanceSymbol(asset) {
  const s = String(asset || 'BTC/USDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /USDT$|BUSD$|USDC$/.test(s) ? s : (s + 'USDT');
}

/**
 * Bin trades into price buckets sized roughly 0.05% of the mean price.
 * For each bin: total volume + buy/sell split. Returns top N by volume.
 */
function buildVolumeProfile(trades, topN = 5) {
  if (!trades.length) return [];
  const meanPrice = trades.reduce((s, t) => s + t.price, 0) / trades.length;
  const binSize = Math.max(1, meanPrice * 0.0005); // 0.05%
  const bins = new Map();
  for (const t of trades) {
    const bucket = Math.round(t.price / binSize) * binSize;
    const key = bucket.toFixed(2);
    const cur = bins.get(key) || { price: bucket, total: 0, buy: 0, sell: 0 };
    cur.total += t.notional;
    if (t.side === 'BUY') cur.buy += t.notional;
    else                  cur.sell += t.notional;
    bins.set(key, cur);
  }
  return [...bins.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, topN)
    .map(b => ({
      price: b.price,
      total_notional_usd: b.total,
      buy_notional_usd: b.buy,
      sell_notional_usd: b.sell,
      bias: b.buy > b.sell * 1.2 ? 'buy-dominant' :
            b.sell > b.buy * 1.2 ? 'sell-dominant' :
                                   'balanced'
    }));
}

/* ─── Top-level analysis ─── */
async function fetchTradeTape(asset, opts = {}) {
  const symbol = toBinanceSymbol(asset);
  const limit = opts.limit || 1000;
  const whaleThresholdUsd = opts.whaleThresholdUsd || 100_000;     // single print >= $100k = whale
  const raw = await httpsJSON(`/fapi/v1/aggTrades?symbol=${symbol}&limit=${limit}`);
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const trades = raw.map(t => {
    const price = parseFloat(t.p);
    const qty = parseFloat(t.q);
    const notional = price * qty;
    const aggressiveSell = !!t.m;
    return {
      price,
      qty,
      notional,
      side: aggressiveSell ? 'SELL' : 'BUY',
      time: t.T
    };
  }).filter(t => !isNaN(t.price) && !isNaN(t.qty));

  if (!trades.length) return null;

  const first = trades[0].time;
  const last = trades[trades.length - 1].time;
  const window_seconds = Math.max(1, Math.round((last - first) / 1000));

  // Aggregates
  let buyVol = 0, sellVol = 0, buyNotional = 0, sellNotional = 0;
  for (const t of trades) {
    if (t.side === 'BUY') { buyVol += t.qty; buyNotional += t.notional; }
    else                  { sellVol += t.qty; sellNotional += t.notional; }
  }
  const cvd_notional_usd = buyNotional - sellNotional;
  const buy_sell_ratio = sellNotional > 0 ? buyNotional / sellNotional : null;

  // Whales: trades whose notional exceeds threshold.
  const whales = trades
    .filter(t => t.notional >= whaleThresholdUsd)
    .sort((a, b) => b.notional - a.notional);

  // Take top 8 by notional for display (across both sides).
  const topWhales = whales.slice(0, 8).map(w => ({
    side: w.side,
    price: w.price,
    qty: w.qty,
    notional_usd: w.notional,
    seconds_ago: Math.round((Date.now() - w.time) / 1000)
  }));

  // Whale aggregate
  const whaleBuyNotional  = whales.filter(w => w.side === 'BUY').reduce((s, w) => s + w.notional, 0);
  const whaleSellNotional = whales.filter(w => w.side === 'SELL').reduce((s, w) => s + w.notional, 0);

  const profile = buildVolumeProfile(trades, 5);

  log.info('fetched trade-tape', { symbol, trades: trades.length, window_s: window_seconds, whales: whales.length });

  return {
    symbol,
    window_seconds,
    trade_count: trades.length,
    buy_vol_coin: buyVol,
    sell_vol_coin: sellVol,
    buy_notional_usd: buyNotional,
    sell_notional_usd: sellNotional,
    cvd_notional_usd,
    buy_sell_ratio,
    whale_count: whales.length,
    whale_buy_notional_usd: whaleBuyNotional,
    whale_sell_notional_usd: whaleSellNotional,
    whale_net_notional_usd: whaleBuyNotional - whaleSellNotional,
    top_whales: topWhales,
    volume_profile: profile
  };
}

/* ─── Format for AI prompt ─── */
function formatForPrompt(data) {
  if (!data) return '';
  const fmtUSD = (n) => {
    const neg = n < 0;
    const abs = Math.abs(n);
    let body;
    if      (abs >= 1e9) body = `$${(abs / 1e9).toFixed(2)}B`;
    else if (abs >= 1e6) body = `$${(abs / 1e6).toFixed(2)}M`;
    else if (abs >= 1e3) body = `$${(abs / 1e3).toFixed(2)}K`;
    else                 body = `$${abs.toFixed(0)}`;
    return neg ? '-' + body : body;
  };
  const sign = (n) => n >= 0 ? '+' : '';   // only used to add explicit + for positives

  const lines = [];
  lines.push(`TRADE TAPE (${data.symbol}, last ${data.window_seconds}s, ${data.trade_count} aggregated trades — real executed flow):`);

  // Aggregate
  const cvdVerdict =
    data.cvd_notional_usd >  0.10 * (data.buy_notional_usd + data.sell_notional_usd) ? 'STRONG NET BUYING' :
    data.cvd_notional_usd < -0.10 * (data.buy_notional_usd + data.sell_notional_usd) ? 'STRONG NET SELLING' :
                                                                                       'roughly balanced';
  lines.push(`- CVD (net delta): ${sign(data.cvd_notional_usd)}${fmtUSD(data.cvd_notional_usd)} → ${cvdVerdict}`);
  lines.push(`  • Buys ${fmtUSD(data.buy_notional_usd)} vs Sells ${fmtUSD(data.sell_notional_usd)}` +
             (data.buy_sell_ratio != null ? ` (ratio ${data.buy_sell_ratio.toFixed(2)})` : ''));

  // Whales
  if (data.whale_count > 0) {
    const whaleBias =
      data.whale_net_notional_usd >  0.10 * (data.whale_buy_notional_usd + data.whale_sell_notional_usd) ? 'WHALES NET BUYING' :
      data.whale_net_notional_usd < -0.10 * (data.whale_buy_notional_usd + data.whale_sell_notional_usd) ? 'WHALES NET SELLING' :
                                                                                                          'whales mixed';
    lines.push(`- Whale prints (≥$100k single fills): ${data.whale_count} in window → ${whaleBias}`);
    lines.push(`  • Whale buys ${fmtUSD(data.whale_buy_notional_usd)} | whale sells ${fmtUSD(data.whale_sell_notional_usd)} | net ${sign(data.whale_net_notional_usd)}${fmtUSD(data.whale_net_notional_usd)}`);
    if (data.top_whales.length > 0) {
      lines.push(`  • Biggest recent prints:`);
      for (const w of data.top_whales.slice(0, 5)) {
        const ageStr = w.seconds_ago < 60 ? `${w.seconds_ago}s ago` : `${Math.round(w.seconds_ago / 60)}m ago`;
        lines.push(`    - ${w.side === 'BUY' ? '🟢 BUY' : '🔴 SELL'} ${w.qty.toFixed(3)} @ $${w.price} (${fmtUSD(w.notional_usd)}, ${ageStr})`);
      }
    }
  } else {
    lines.push(`- Whale prints (≥$100k): 0 in window — no large fills, retail-only flow`);
  }

  // Volume profile — where the action is
  if (data.volume_profile.length > 0) {
    lines.push(`- Volume profile (top price levels by traded volume in window):`);
    for (const b of data.volume_profile) {
      const tag = b.bias === 'buy-dominant'  ? '🟢 buyers dominant'  :
                  b.bias === 'sell-dominant' ? '🔴 sellers dominant' :
                                                'balanced';
      lines.push(`  • $${b.price.toFixed(2)}: ${fmtUSD(b.total_notional_usd)} traded → ${tag} (buy ${fmtUSD(b.buy_notional_usd)} / sell ${fmtUSD(b.sell_notional_usd)})`);
    }
  }

  lines.push('');
  lines.push('TRADE-TAPE INTERPRETATION:');
  lines.push('- CVD shows ACTUAL executed pressure (different from orderbook depth, which shows resting orders).');
  lines.push('- Whales NET BUYING + price flat = ACCUMULATION (often precedes a leg up).');
  lines.push('- Whales NET SELLING + price rising = DISTRIBUTION (often precedes a top).');
  lines.push('- Volume-profile heavy levels are SUPPORT/RESISTANCE proven by real fills — stronger than chart-based levels.');
  lines.push('- Cluster of whale SELL prints near a high = institutional offload, treat as resistance even if chart looks bullish.');
  lines.push('- Cluster of whale BUY prints near a low = institutional bid, treat as support even if chart looks bearish.');
  return lines.join('\n');
}

module.exports = {
  fetchTradeTape,
  formatForPrompt,
  toBinanceSymbol,
  _internal: { buildVolumeProfile }
};
