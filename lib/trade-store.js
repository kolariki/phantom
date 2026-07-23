/**
 * Trade store — append-only JSONL persistence + in-memory index.
 *
 * Schema for each record:
 *   {
 *     id:                string (uuid v4-ish),
 *     created_at:        ISO timestamp,
 *     asset:             "BTC/USDT",
 *     exchange:          "kucoin" | "binance" | "bybit" | "",
 *     timeframes:        ["60", "240"],
 *     indicators_visible:["rsi","macd",...],
 *     ai_model:          "claude-opus-4-7",
 *     ai_decision:       "LONG" | "SHORT" | "WAIT" | null,
 *     ai_confluence:     "3/4",
 *     ai_bias_long:      number (0-100),
 *     ai_bias_short:     number (0-100),
 *     ai_setup_long:     { entry: [low, high], sl, tp1, tp2, tp3, size } | null,
 *     ai_setup_short:    same | null,
 *     market_context:    { funding, oi, fear_greed, ls_ratio } | null,
 *     full_response:     string (full AI text),
 *     source:            "manual" | "auto",
 *
 *     // User-completed (filled after the fact):
 *     user_action:       null | "long" | "short" | "skipped",
 *     user_entry:        null | number,
 *     user_size_pct:     null | number,
 *     outcome:           null | "win" | "loss" | "breakeven" | "cancelled" | "open",
 *     outcome_pnl_pct:   null | number,
 *     outcome_notes:     null | string,
 *     closed_at:         null | ISO
 *   }
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('trade-store');

let dataPath = null;
const index = new Map(); // id -> record
let seqCounter = 0;     // monotonic insertion order tiebreaker

function uid() {
  // Simple, dep-free unique ID. Good enough for one user's local log.
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

function initStore(baseDir) {
  dataPath = path.join(baseDir, 'trades.jsonl');
  index.clear();
  seqCounter = 0;
  if (!fs.existsSync(dataPath)) {
    try { fs.writeFileSync(dataPath, ''); } catch (e) { log.error('cannot create trades.jsonl', e); }
    return;
  }
  // Replay file into the index. Last write wins per id.
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) {
          if (typeof rec._seq !== 'number') rec._seq = ++seqCounter;
          else if (rec._seq > seqCounter) seqCounter = rec._seq;
          index.set(rec.id, rec);
        }
      } catch (e) {
        log.warn('skipping malformed line', { snippet: line.slice(0, 200) });
      }
    }
    log.info('loaded trades', { count: index.size });
  } catch (e) {
    log.error('failed to load trades.jsonl', e);
  }
}

function appendLine(rec) {
  if (!dataPath) throw new Error('trade-store not initialized');
  fs.appendFileSync(dataPath, JSON.stringify(rec) + '\n');
}

function logAnalysis(input) {
  const rec = {
    id: uid(),
    _seq: ++seqCounter,
    created_at: new Date().toISOString(),
    asset: input.asset || '',
    exchange: input.exchange || '',
    timeframes: input.timeframes || [],
    indicators_visible: input.indicators_visible || [],
    ai_model: input.ai_model || '',
    ai_decision: input.ai_decision || null,
    ai_confluence: input.ai_confluence || null,
    ai_bias_long: typeof input.ai_bias_long === 'number' ? input.ai_bias_long : null,
    ai_bias_short: typeof input.ai_bias_short === 'number' ? input.ai_bias_short : null,
    ai_setup_long: input.ai_setup_long || null,
    ai_setup_short: input.ai_setup_short || null,
    market_context: input.market_context || null,
    news_context: input.news_context || null,
    full_response: input.full_response || '',
    source: input.source || 'manual',
    user_action: null,
    user_entry: null,
    user_size_pct: null,
    outcome: null,
    outcome_pnl_pct: null,
    outcome_notes: null,
    closed_at: null
  };
  index.set(rec.id, rec);
  appendLine(rec);
  log.info('logged analysis', { id: rec.id, asset: rec.asset, decision: rec.ai_decision });
  return rec;
}

function updateTrade(id, patch) {
  const existing = index.get(id);
  if (!existing) {
    log.warn('update on unknown id', { id });
    return null;
  }
  const updated = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
  index.set(id, updated);
  appendLine(updated);
  log.info('updated trade', { id, patch: Object.keys(patch) });
  return updated;
}

function listTrades(filter) {
  const arr = Array.from(index.values());
  let out = arr;
  if (filter) {
    if (filter.asset)   out = out.filter(t => t.asset === filter.asset);
    if (filter.action)  out = out.filter(t => t.user_action === filter.action);
    if (filter.outcome) out = out.filter(t => t.outcome === filter.outcome);
    if (filter.open)    out = out.filter(t => t.user_action && t.user_action !== 'skipped' && (!t.outcome || t.outcome === 'open'));
    if (filter.since)   out = out.filter(t => t.created_at >= filter.since);
  }
  return out.sort((a, b) => {
    const c = b.created_at.localeCompare(a.created_at);
    return c !== 0 ? c : ((b._seq || 0) - (a._seq || 0));
  });
}

function getTrade(id) {
  return index.get(id) || null;
}

/** Returns the most recent analyses for an asset within a time window. */
function getRecentForAsset(asset, opts) {
  const sinceMs = (opts && opts.sinceMs) || 6 * 60 * 60 * 1000;  // last 6h
  const limit = (opts && opts.limit) || 3;
  const cutoff = Date.now() - sinceMs;
  const arr = Array.from(index.values())
    .filter(t => t.asset === asset && Date.parse(t.created_at) >= cutoff)
    .sort((a, b) => {
    const c = b.created_at.localeCompare(a.created_at);
    return c !== 0 ? c : ((b._seq || 0) - (a._seq || 0));
  });
  return arr.slice(0, limit);
}

function computeStats(filter) {
  const trades = listTrades(filter);
  const taken = trades.filter(t => t.user_action === 'long' || t.user_action === 'short');
  const closed = taken.filter(t => t.outcome && t.outcome !== 'cancelled' && t.outcome !== 'open');
  const wins = closed.filter(t => t.outcome === 'win');
  const losses = closed.filter(t => t.outcome === 'loss');

  const winRate = closed.length ? wins.length / closed.length : 0;
  const totalPnl = closed.reduce((s, t) => s + (t.outcome_pnl_pct || 0), 0);
  const avgPnl = closed.length ? totalPnl / closed.length : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + (t.outcome_pnl_pct || 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + (t.outcome_pnl_pct || 0), 0) / losses.length : 0;

  // Breakdown by confluence score.
  const byConfluence = {};
  for (const t of closed) {
    const key = t.ai_confluence || 'unknown';
    if (!byConfluence[key]) byConfluence[key] = { total: 0, wins: 0 };
    byConfluence[key].total += 1;
    if (t.outcome === 'win') byConfluence[key].wins += 1;
  }
  for (const k of Object.keys(byConfluence)) {
    byConfluence[k].winRate = byConfluence[k].total
      ? byConfluence[k].wins / byConfluence[k].total
      : 0;
  }

  // Breakdown by direction.
  const longTaken = closed.filter(t => t.user_action === 'long');
  const shortTaken = closed.filter(t => t.user_action === 'short');
  const longWinRate = longTaken.length
    ? longTaken.filter(t => t.outcome === 'win').length / longTaken.length
    : 0;
  const shortWinRate = shortTaken.length
    ? shortTaken.filter(t => t.outcome === 'win').length / shortTaken.length
    : 0;

  // "Did AI say WAIT but you entered anyway?" comparison.
  const overrideTrades = closed.filter(t => t.ai_decision === 'WAIT' && (t.user_action === 'long' || t.user_action === 'short'));
  const overrideWinRate = overrideTrades.length
    ? overrideTrades.filter(t => t.outcome === 'win').length / overrideTrades.length
    : 0;

  return {
    totalAnalyses: trades.length,
    taken: taken.length,
    closed: closed.length,
    open: taken.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnlPct: totalPnl,
    avgPnlPct: avgPnl,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    expectancy: winRate * avgWin + (1 - winRate) * avgLoss,
    byConfluence,
    longWinRate,
    shortWinRate,
    overrideTrades: overrideTrades.length,
    overrideWinRate
  };
}

module.exports = {
  initStore,
  logAnalysis,
  updateTrade,
  listTrades,
  getTrade,
  getRecentForAsset,
  computeStats,
  // exposed for tests:
  _internal: { uid }
};
