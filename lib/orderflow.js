/**
 * Order-flow data — three free, no-auth Binance Futures endpoints.
 *
 *   1) takerlongshortRatio       — aggressive market-order flow (BIG edge)
 *   2) topLongShortPositionRatio — smart-money positioning proxy
 *   3) /fapi/v1/depth            — orderbook for walls + imbalance
 *
 * The orchestrator runs them in parallel with per-source timeouts.
 * Returns a compact data object + an AI-ready prompt block.
 */

const https = require('https');
const { createLogger } = require('./logger');

const log = createLogger('orderflow');
const HOST = 'fapi.binance.com';

function httpsJSON(path, timeoutMs = 6000) {
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
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('Bad JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('orderflow timeout')); });
    req.end();
  });
}

/* Normalize "BTC/USDT" / "btc-usdt" → "BTCUSDT" for Binance Futures. */
function toBinanceSymbol(asset) {
  const s = String(asset || 'BTC/USDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /USDT$|BUSD$|USDC$/.test(s) ? s : (s + 'USDT');
}

/* ─── 1) Taker buy/sell ratio (aggressive market-order flow) ─── */
async function fetchTakerRatio(symbol, period = '5m', limit = 12) {
  const path = `/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const arr = await httpsJSON(path);
  if (!Array.isArray(arr) || !arr.length) return null;
  // Sort oldest → newest just in case.
  arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const latest = arr[arr.length - 1];
  const ratios = arr.map(p => parseFloat(p.buySellRatio)).filter(n => !isNaN(n));
  const avg = ratios.reduce((s, n) => s + n, 0) / ratios.length;
  return {
    period,
    latest_ratio: parseFloat(latest.buySellRatio),
    latest_buy_vol: parseFloat(latest.buyVol),
    latest_sell_vol: parseFloat(latest.sellVol),
    avg_ratio_window: avg,
    samples: ratios.length
  };
}

/* ─── 2) Top trader position ratio (smart money proxy) ─── */
async function fetchTopTraderPositionRatio(symbol, period = '1h') {
  const path = `/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=2`;
  const arr = await httpsJSON(path);
  if (!Array.isArray(arr) || !arr.length) return null;
  arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const latest = arr[arr.length - 1];
  const previous = arr.length > 1 ? arr[0] : null;
  return {
    period,
    long_pct: parseFloat(latest.longAccount) * 100,
    short_pct: parseFloat(latest.shortAccount) * 100,
    long_short_ratio: parseFloat(latest.longShortRatio),
    delta_long_pct: previous
      ? (parseFloat(latest.longAccount) - parseFloat(previous.longAccount)) * 100
      : null
  };
}

/* ─── 3) Orderbook → imbalance + walls ─── */
async function fetchOrderBook(symbol, depthLimit = 500) {
  const path = `/fapi/v1/depth?symbol=${symbol}&limit=${depthLimit}`;
  const ob = await httpsJSON(path);
  if (!ob || !Array.isArray(ob.bids) || !Array.isArray(ob.asks)) return null;
  return analyzeOrderBook(ob);
}

/**
 * Compute: bid/ask imbalance at 1% and 2% from mid, and the biggest walls
 * on each side (price levels with size much larger than median size at that range).
 */
function analyzeOrderBook(ob) {
  const bids = ob.bids.map(([p, s]) => [parseFloat(p), parseFloat(s)]).filter(([p, s]) => !isNaN(p) && !isNaN(s));
  const asks = ob.asks.map(([p, s]) => [parseFloat(p), parseFloat(s)]).filter(([p, s]) => !isNaN(p) && !isNaN(s));
  if (!bids.length || !asks.length) return null;

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spread_pct = ((bestAsk - bestBid) / mid) * 100;

  function sumWithin(side, pct) {
    const cutoff = side === 'bid' ? mid * (1 - pct / 100) : mid * (1 + pct / 100);
    const arr = side === 'bid' ? bids : asks;
    return arr
      .filter(([p]) => side === 'bid' ? p >= cutoff : p <= cutoff)
      .reduce((s, [, size]) => s + size, 0);
  }

  const bid_size_1pct = sumWithin('bid', 1);
  const ask_size_1pct = sumWithin('ask', 1);
  const bid_size_2pct = sumWithin('bid', 2);
  const ask_size_2pct = sumWithin('ask', 2);

  // Imbalance ratio: bid / ask. >1 = bid heavy (buying liquidity dominant); <1 = ask heavy.
  const imbalance_1pct = ask_size_1pct > 0 ? bid_size_1pct / ask_size_1pct : null;
  const imbalance_2pct = ask_size_2pct > 0 ? bid_size_2pct / ask_size_2pct : null;

  // Walls: pick the biggest size level within 2% on each side.
  // Mark as a wall only if that level is >= 5x the median size in the visible range.
  function findWall(side) {
    const arr = side === 'bid' ? bids : asks;
    const cutoff = side === 'bid' ? mid * 0.98 : mid * 1.02;
    const nearby = arr.filter(([p]) => side === 'bid' ? p >= cutoff : p <= cutoff);
    if (nearby.length < 5) return null;
    const sorted = [...nearby].sort((a, b) => b[1] - a[1]);
    const biggest = sorted[0];
    const median = sorted[Math.floor(sorted.length / 2)][1];
    if (median <= 0 || biggest[1] < median * 5) return null;
    return {
      price: biggest[0],
      size: biggest[1],
      multiple_of_median: biggest[1] / median,
      distance_pct: ((biggest[0] - mid) / mid) * 100
    };
  }

  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread_pct,
    bid_size_1pct,
    ask_size_1pct,
    imbalance_1pct,
    bid_size_2pct,
    ask_size_2pct,
    imbalance_2pct,
    bid_wall: findWall('bid'),
    ask_wall: findWall('ask')
  };
}

/* ─── Top-level orchestrator ─── */
async function fetchOrderFlow(asset) {
  const symbol = toBinanceSymbol(asset);
  const errors = {};
  const safe = (p, key) => p.catch(err => {
    errors[key] = err && err.message ? err.message.slice(0, 200) : 'error';
    return null;
  });
  const [taker5m, taker1h, topTrader1h, book] = await Promise.all([
    safe(fetchTakerRatio(symbol, '5m', 12),       'taker_5m'),
    safe(fetchTakerRatio(symbol, '1h', 6),        'taker_1h'),
    safe(fetchTopTraderPositionRatio(symbol, '1h'), 'top_trader_1h'),
    safe(fetchOrderBook(symbol, 500),             'orderbook')
  ]);
  log.info('fetched orderflow', { symbol, errors: Object.keys(errors).length || 0 });
  return { symbol, taker5m, taker1h, topTrader1h, book, errors: Object.keys(errors).length ? errors : null };
}

/* ─── Format for AI prompt ─── */
function formatForPrompt(data) {
  if (!data) return '';
  const lines = [];
  const hasAny = data.taker5m || data.taker1h || data.topTrader1h || data.book;
  if (!hasAny) return '';

  lines.push(`ORDER-FLOW DATA (${data.symbol}, Binance Futures public — real-time market microstructure):`);

  // 1) Taker ratio (aggressive flow)
  if (data.taker5m) {
    const t = data.taker5m;
    const verdict =
      t.latest_ratio >= 1.20 ? 'AGGRESSIVE BUYING (market buyers dominant)' :
      t.latest_ratio <= 0.85 ? 'AGGRESSIVE SELLING (market sellers dominant)' :
                               'balanced / no aggressive flow';
    lines.push(`- Taker Buy/Sell 5m (last bar): ${t.latest_ratio.toFixed(3)} → ${verdict}`);
    lines.push(`  • last 5m buy vol: ${t.latest_buy_vol.toFixed(0)} | sell vol: ${t.latest_sell_vol.toFixed(0)}`);
    lines.push(`  • last hour avg ratio: ${t.avg_ratio_window.toFixed(3)} (${t.samples} samples)`);
  }
  if (data.taker1h) {
    const t = data.taker1h;
    lines.push(`- Taker Buy/Sell 1h (last bar): ${t.latest_ratio.toFixed(3)} | 6h avg: ${t.avg_ratio_window.toFixed(3)}`);
  }

  // 2) Top trader positions (smart money)
  if (data.topTrader1h) {
    const tt = data.topTrader1h;
    const drift = tt.delta_long_pct != null
      ? ` (${tt.delta_long_pct >= 0 ? '+' : ''}${tt.delta_long_pct.toFixed(2)}pp last hour)`
      : '';
    const bias = tt.long_short_ratio > 1.15 ? 'LONG-biased' : tt.long_short_ratio < 0.85 ? 'SHORT-biased' : 'balanced';
    lines.push(`- Top Trader Positions (smart money proxy): ${tt.long_pct.toFixed(1)}% long / ${tt.short_pct.toFixed(1)}% short → ${bias}${drift}`);
  }

  // 3) Orderbook
  if (data.book) {
    const b = data.book;
    lines.push(`- Orderbook (live):`);
    lines.push(`  • Best bid ${b.best_bid} | Best ask ${b.best_ask} | Spread ${b.spread_pct.toFixed(4)}%`);
    if (b.imbalance_1pct != null) {
      const verdict =
        b.imbalance_1pct >= 1.3 ? 'BID-heavy (buy-side liquidity dominant)' :
        b.imbalance_1pct <= 0.77 ? 'ASK-heavy (sell-side liquidity dominant)' :
                                    'balanced';
      lines.push(`  • Imbalance within 1%: ${b.imbalance_1pct.toFixed(2)} (${b.bid_size_1pct.toFixed(1)} bids / ${b.ask_size_1pct.toFixed(1)} asks) → ${verdict}`);
    }
    if (b.imbalance_2pct != null) {
      lines.push(`  • Imbalance within 2%: ${b.imbalance_2pct.toFixed(2)}`);
    }
    if (b.bid_wall) {
      lines.push(`  • 🧱 BID wall at $${b.bid_wall.price} (size ${b.bid_wall.size.toFixed(1)}, ${b.bid_wall.multiple_of_median.toFixed(1)}× median, ${b.bid_wall.distance_pct.toFixed(2)}% below mid) — likely strong support`);
    }
    if (b.ask_wall) {
      lines.push(`  • 🧱 ASK wall at $${b.ask_wall.price} (size ${b.ask_wall.size.toFixed(1)}, ${b.ask_wall.multiple_of_median.toFixed(1)}× median, +${b.ask_wall.distance_pct.toFixed(2)}% above mid) — likely strong resistance`);
    }
  }

  lines.push('');
  lines.push('ORDER-FLOW INTERPRETATION (use these signals):');
  lines.push('- Taker ratio is REAL-TIME aggressive flow; far more meaningful than passive L/S positioning.');
  lines.push('- Taker >1.20 + price falling = absorption pattern (buyers absorbing supply, often precedes reversal up).');
  lines.push('- Taker <0.85 + price rising = distribution pattern (sellers offloading into strength).');
  lines.push('- Top trader bias DIVERGING from retail = follow smart money.');
  lines.push('- Orderbook walls often get hunted (price tags the wall then reverses) — treat as magnet AND resistance/support.');
  return lines.join('\n');
}

module.exports = {
  fetchOrderFlow,
  formatForPrompt,
  toBinanceSymbol,
  // exposed for tests
  _internal: { analyzeOrderBook }
};
