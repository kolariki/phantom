/**
 * Market Pulse — lightweight live snapshot for the 5-second polling widget.
 *
 * Combines the trade tape (recent fills) + orderbook depth into a single
 * payload sized for fast UI rendering. NOT for AI prompt injection — for
 * the realtime panel that updates while the user watches.
 */

const https = require('https');
const HOST = 'fapi.binance.com';

function httpsJSON(path, timeoutMs = 4000) {
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
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('bad json')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function toBinanceSymbol(asset) {
  const s = String(asset || 'BTC/USDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /USDT$|BUSD$|USDC$/.test(s) ? s : (s + 'USDT');
}

/**
 * Pick a "nice" zone width based on price magnitude. Tuned for SCALPING with
 * INTERMEDIATE granularity: the user wants to see e.g. $79,050 AND $79,100
 * as separate zones (not lumped into $79,000-$79,200).
 *   BTC at $80K → $50 zones (~0.06%)
 *   ETH at $3K  → $2.5 zones (~0.08%)
 *   SOL at $100 → $0.25 zones (~0.25%)
 */
function inferZoneSize(price) {
  if (!price || price <= 0) return 1;
  if (price >= 50000)  return 50;
  if (price >= 10000)  return 25;
  if (price >= 1000)   return 2.5;
  if (price >= 100)    return 0.25;
  if (price >= 10)     return 0.05;
  if (price >= 1)      return 0.01;
  if (price >= 0.1)    return 0.001;
  if (price >= 0.01)   return 0.0001;
  return 0.00001;
}

/**
 * Aggregate orderbook levels into PRICE ZONES (buckets) instead of individual
 * ticks. Each zone reports total size, level count, multiplier vs median zone,
 * and distance from mid. Returns top N zones by total size.
 *
 * Why: tick-level walls cluster (12 levels within $20 = noise). Zones answer
 * the trader's real question: "where, in round numbers, is the heavy liquidity?"
 */
function topWallZones(side, levels, mid, opts = {}) {
  const maxDistPct = opts.maxDistPct || 3;
  const zoneSize   = opts.zoneSize   || inferZoneSize(mid);
  const topN       = opts.topN       || 10;    // show many intermediate zones so trader sees levels between major walls
  // minMult is OPT-IN now. By default we ALWAYS return the top N zones by
  // total size — they are, by definition, where the most liquidity sits.
  // The `mult` field is informational ("how dominant is this zone?"), not a
  // gate. Pass `opts.minMult` if you want to enforce a threshold (used by
  // some tests to verify the legacy gating behavior).
  const minMult    = opts.minMult ?? 0;

  const arr = levels.filter(([p]) =>
    side === 'bid'
      ? p <= mid && p >= mid * (1 - maxDistPct / 100)
      : p >= mid && p <= mid * (1 + maxDistPct / 100)
  );
  if (arr.length === 0) return [];

  const buckets = new Map();
  for (const [price, size] of arr) {
    const zoneStart = Math.floor(price / zoneSize) * zoneSize;
    const key = zoneStart.toFixed(8);
    const b = buckets.get(key) || { zone_start: zoneStart, total_size: 0, level_count: 0, max_level_size: 0 };
    b.total_size  += size;
    b.level_count += 1;
    if (size > b.max_level_size) b.max_level_size = size;
    buckets.set(key, b);
  }

  const sizes = [...buckets.values()].map(b => b.total_size).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const safeMedian = median > 0 ? median : 0.0001;

  return [...buckets.values()]
    .map(b => ({
      zone_start: b.zone_start,
      zone_end:   b.zone_start + zoneSize,
      total_size: b.total_size,
      level_count:b.level_count,
      mult:       b.total_size / safeMedian,
      dist_pct:   ((b.zone_start - mid) / mid) * 100,
      zone_size:  zoneSize
    }))
    .filter(z => z.mult >= minMult)
    .sort((a, b) => b.total_size - a.total_size)
    .slice(0, topN);
}

/* ─── Main: fetch and shape ─── */
async function fetchMarketPulse(asset) {
  const symbol = toBinanceSymbol(asset);
  const [trades, ob] = await Promise.all([
    httpsJSON(`/fapi/v1/aggTrades?symbol=${symbol}&limit=300`).catch(() => null),
    httpsJSON(`/fapi/v1/depth?symbol=${symbol}&limit=1000`).catch(() => null)
  ]);

  /* ─── Parse trade tape ─── */
  let recent = [];
  let buyNotional = 0, sellNotional = 0, cvdSeries = [];
  let windowSec = 0;
  if (Array.isArray(trades) && trades.length) {
    const parsed = trades.map(t => ({
      price: parseFloat(t.p),
      qty: parseFloat(t.q),
      side: t.m ? 'SELL' : 'BUY',
      time: t.T,
      notional: parseFloat(t.p) * parseFloat(t.q)
    })).filter(t => !isNaN(t.price));

    windowSec = parsed.length ? Math.max(1, Math.round((parsed[parsed.length - 1].time - parsed[0].time) / 1000)) : 0;

    let running = 0;
    for (const t of parsed) {
      if (t.side === 'BUY')  { buyNotional  += t.notional; running += t.notional; }
      else                   { sellNotional += t.notional; running -= t.notional; }
      cvdSeries.push(running);
    }
    // Last ~15 trades for the live tape (most recent first).
    recent = parsed.slice(-15).reverse().map(t => ({
      side: t.side,
      price: t.price,
      qty: t.qty,
      notional: t.notional,
      seconds_ago: Math.max(0, Math.round((Date.now() - t.time) / 1000)),
      is_whale: t.notional >= 100_000
    }));
  }

  /* ─── Parse orderbook ─── */
  let bestBid = null, bestAsk = null, mid = null, spreadPct = null;
  let bidWalls = [], askWalls = [];
  let bidSize1 = 0, askSize1 = 0, imbalance1 = null;
  if (ob && Array.isArray(ob.bids) && Array.isArray(ob.asks) && ob.bids.length && ob.asks.length) {
    const bids = ob.bids.map(([p, s]) => [parseFloat(p), parseFloat(s)]);
    const asks = ob.asks.map(([p, s]) => [parseFloat(p), parseFloat(s)]);
    bestBid = bids[0][0];
    bestAsk = asks[0][0];
    mid = (bestBid + bestAsk) / 2;
    spreadPct = ((bestAsk - bestBid) / mid) * 100;

    const within = (arr, side) => arr.filter(([p]) => side === 'bid'
      ? p >= mid * 0.99
      : p <= mid * 1.01);
    bidSize1 = within(bids, 'bid').reduce((s, [, sz]) => s + sz, 0);
    askSize1 = within(asks, 'ask').reduce((s, [, sz]) => s + sz, 0);
    imbalance1 = askSize1 > 0 ? bidSize1 / askSize1 : null;

    bidWalls = topWallZones('bid', bids, mid);
    askWalls = topWallZones('ask', asks, mid);
  }

  const cvd = buyNotional - sellNotional;
  const totalFlow = buyNotional + sellNotional;
  const cvdPctOfFlow = totalFlow > 0 ? (cvd / totalFlow) * 100 : 0;

  return {
    symbol,
    fetched_at: Date.now(),
    window_seconds: windowSec,
    trades_recent: recent,
    flow: {
      buy_notional: buyNotional,
      sell_notional: sellNotional,
      cvd,
      cvd_pct_of_flow: cvdPctOfFlow,
      verdict:
        cvdPctOfFlow >  15 ? 'STRONG_BUY' :
        cvdPctOfFlow >   5 ? 'BUY' :
        cvdPctOfFlow < -15 ? 'STRONG_SELL' :
        cvdPctOfFlow <  -5 ? 'SELL' :
                             'BALANCED'
    },
    book: mid ? {
      best_bid: bestBid,
      best_ask: bestAsk,
      mid,
      spread_pct: spreadPct,
      imbalance_1pct: imbalance1,
      bid_size_1pct: bidSize1,
      ask_size_1pct: askSize1,
      bid_walls: bidWalls,
      ask_walls: askWalls
    } : null
  };
}

module.exports = {
  fetchMarketPulse,
  toBinanceSymbol,
  _internal: { topWallZones, inferZoneSize }
};
