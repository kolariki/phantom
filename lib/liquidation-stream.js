/**
 * Binance USDⓈ-M futures liquidation stream.
 *
 * Subscribes to `wss://fstream.binance.com/ws/!forceOrder@arr` — a public,
 * no-auth firehose of every liquidation across all USDT-M futures pairs.
 * Keeps an in-memory rolling buffer (last 30 min) per symbol so the renderer
 * can show liquidation "magnets" (price clusters where leveraged positions
 * just got rekt — short-term magnets for the next move).
 *
 * Why this matters for scalp: liquidation cascades are the single biggest
 * source of fast $200-300 moves on BTC. Spotting where they cluster lets the
 * user position themselves on the right side of the squeeze.
 *
 * Buffer schema per liquidation event:
 *   { symbol, side, price, qty, notional_usd, ts }
 *   side = 'LONG_LIQ'  → a long got rekt (forced sell → bearish flush)
 *   side = 'SHORT_LIQ' → a short got rekt (forced buy → bullish squeeze)
 */

const WebSocket = require('ws');
const { createLogger } = require('./logger');

const log = createLogger('liq-stream');
const WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const BUFFER_MS = 30 * 60 * 1000; // 30 minutes

let ws = null;
let reconnectTimer = null;
let backoffMs = 1000;
const buffer = []; // chronological list of events
const MAX_BUFFER = 5000;

function pruneOld() {
  const cutoff = Date.now() - BUFFER_MS;
  while (buffer.length && buffer[0].ts < cutoff) buffer.shift();
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  // Binance can deliver single objects or arrays depending on the stream
  // multiplexer. Normalize to array.
  const events = Array.isArray(msg) ? msg : [msg];
  for (const ev of events) {
    const o = ev && ev.o;
    if (!o) continue;
    const price = parseFloat(o.ap || o.p);
    const qty   = parseFloat(o.q);
    if (!isFinite(price) || !isFinite(qty)) continue;
    // Binance order side: BUY means the LIQUIDATION ORDER was a buy — which
    // means a SHORT was force-closed. SELL means a LONG got force-closed.
    const side = (o.S === 'SELL') ? 'LONG_LIQ' : 'SHORT_LIQ';
    buffer.push({
      symbol:       String(o.s || '').toUpperCase(),
      side,
      price,
      qty,
      notional_usd: price * qty,
      ts:           Date.now()
    });
  }
  pruneOld();
}

function connect() {
  if (ws) return;
  try {
    ws = new WebSocket(WS_URL, { handshakeTimeout: 10000 });
  } catch (e) {
    log.warn('connect threw', e);
    scheduleReconnect();
    return;
  }
  ws.on('open', () => {
    log.info('connected');
    backoffMs = 1000;
  });
  ws.on('message', (data) => handleMessage(data.toString()));
  ws.on('close', () => {
    log.info('closed');
    ws = null;
    scheduleReconnect();
  });
  ws.on('error', (e) => {
    log.warn('error', e && e.message);
    try { ws && ws.terminate(); } catch {}
    ws = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    connect();
  }, backoffMs);
}

function start() {
  if (ws || reconnectTimer) return;
  connect();
}

function stop() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { ws && ws.close(); } catch {}
  ws = null;
}

/**
 * Return liquidation events for a specific symbol within the last `windowMs`.
 * If no symbol passed, returns all symbols (useful for "market-wide carnage"
 * summaries).
 */
function getRecent(symbol, windowMs = 5 * 60 * 1000) {
  pruneOld();
  const cutoff = Date.now() - windowMs;
  const sym = symbol ? String(symbol).toUpperCase() : null;
  return buffer.filter(e => e.ts >= cutoff && (!sym || e.symbol === sym));
}

/**
 * Aggregate recent liquidations into PRICE CLUSTERS for a single symbol.
 * Returns clusters sorted by total notional (biggest magnets first).
 * Used to surface "$77,820 just got $2.1M of longs liquidated" type signals.
 */
function clusterRecent(symbol, opts = {}) {
  const windowMs   = opts.windowMs   || 5 * 60 * 1000;
  const zoneSize   = opts.zoneSize   || inferZoneSize(opts.refPrice);
  const minClusterUsd = opts.minClusterUsd || 50_000;
  const events = getRecent(symbol, windowMs);
  if (!events.length) return [];
  const buckets = new Map();
  for (const e of events) {
    const start = Math.floor(e.price / zoneSize) * zoneSize;
    const key = `${e.side}:${start.toFixed(8)}`;
    const b = buckets.get(key) || {
      zone_start: start,
      zone_end:   start + zoneSize,
      side:       e.side,
      notional_usd: 0,
      event_count: 0,
      last_ts:    0
    };
    b.notional_usd += e.notional_usd;
    b.event_count  += 1;
    if (e.ts > b.last_ts) b.last_ts = e.ts;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .filter(c => c.notional_usd >= minClusterUsd)
    .sort((a, b) => b.notional_usd - a.notional_usd);
}

function inferZoneSize(price) {
  if (!price || price <= 0) return 1;
  if (price >= 50000) return 50;
  if (price >= 10000) return 25;
  if (price >= 1000)  return 2.5;
  if (price >= 100)   return 0.25;
  if (price >= 10)    return 0.05;
  if (price >= 1)     return 0.01;
  return 0.001;
}

/**
 * Quick summary of last-N-min liquidation pressure for a symbol — used by the
 * Scalp Radar and the analyzer prompt.
 *   { longs_liq_usd, shorts_liq_usd, dominant_side, last_event_ago_sec }
 */
function summarize(symbol, windowMs = 5 * 60 * 1000) {
  const events = getRecent(symbol, windowMs);
  let longs = 0, shorts = 0, lastTs = 0;
  for (const e of events) {
    if (e.side === 'LONG_LIQ')  longs  += e.notional_usd;
    else                         shorts += e.notional_usd;
    if (e.ts > lastTs) lastTs = e.ts;
  }
  const total = longs + shorts;
  return {
    window_seconds: Math.round(windowMs / 1000),
    longs_liq_usd: longs,
    shorts_liq_usd: shorts,
    total_liq_usd: total,
    dominant_side: total === 0 ? null : (longs > shorts ? 'LONGS_GOT_REKT' : 'SHORTS_GOT_REKT'),
    event_count: events.length,
    last_event_ago_sec: lastTs ? Math.round((Date.now() - lastTs) / 1000) : null
  };
}

module.exports = {
  start, stop,
  getRecent, clusterRecent, summarize,
  _internal: { handleMessage, buffer }
};
