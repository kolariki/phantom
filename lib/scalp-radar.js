/**
 * Scalp Radar — turns the raw market-pulse + liquidation data into a single
 * tactical payload optimized for $200-300 BTC scalps (≈0.25-0.4% moves).
 *
 * Pure functions, no IO — easy to unit-test. The renderer calls this with the
 * latest market-pulse snapshot, the previous snapshot (for derivatives like
 * CVD slope), and the recent liquidation summary, and gets back a single
 * "what's happening RIGHT NOW" object.
 *
 * Schema returned:
 *   {
 *     pressure:        0-100 score (combined: book imbalance + CVD slope + tape speed + whale flow)
 *     verdict:         'LONG_NOW' | 'SHORT_NOW' | 'FADE_LONG' | 'FADE_SHORT' | 'WAIT'
 *     reason:          one-line explanation
 *     book_imbalance:  number (bid/ask ratio top 1%)
 *     cvd_velocity_usd_per_min: number
 *     tape_speed_per_sec: number
 *     aggressor_pct: { buy_pct, sell_pct, window_sec }
 *     spread_pct: number
 *     spread_velocity: 'WIDENING' | 'TIGHTENING' | 'STABLE'
 *     nearest_magnet: { price, side, distance_usd, distance_pct, notional_usd }
 *     trap_warning: string|null     // e.g. "stop hunt likely at $X (small cluster just above)"
 *     liquidations: { longs_usd, shorts_usd, dominant_side, last_event_ago_sec }
 *   }
 */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Combine raw signals into a 0-100 pressure score. Positive = bullish bias,
 * negative = bearish bias. The renderer maps the absolute value into a gauge.
 * Returns signed [-100, +100].
 */
function pressureScore({ book_imbalance, cvd_velocity, aggressor_buy_pct, whale_skew }) {
  let score = 0;
  // Book imbalance: 1.0 = neutral, >1.5 = bullish, <0.66 = bearish.
  if (book_imbalance != null && isFinite(book_imbalance) && book_imbalance > 0) {
    // log-scale around 1.0, capped at ±30 points
    const lg = Math.log(book_imbalance);   // ln(1)=0, ln(2)≈0.69, ln(0.5)≈-0.69
    score += clamp(lg * 30, -30, 30);
  }
  // CVD velocity: $200k/min in either direction = strong, capped at ±30.
  if (cvd_velocity != null && isFinite(cvd_velocity)) {
    score += clamp(cvd_velocity / 200_000 * 30, -30, 30);
  }
  // Aggressor split last 60s: 50% neutral; 80% buy = +20, 20% buy = -20.
  if (aggressor_buy_pct != null && isFinite(aggressor_buy_pct)) {
    score += clamp((aggressor_buy_pct - 50) / 50 * 20, -20, 20);
  }
  // Whale skew: positive when recent whales bought net, capped ±20.
  if (whale_skew != null && isFinite(whale_skew)) {
    score += clamp(whale_skew * 20, -20, 20);
  }
  return clamp(Math.round(score), -100, 100);
}

/**
 * Decide verdict from the signed pressure score + liquidation context.
 * "FADE" verdicts trigger when one side just got blown out — the squeeze is
 * exhausted, so the smart move is to fade the squeeze direction.
 */
function decideVerdict(score, liq) {
  const abs = Math.abs(score);
  // Strong liquidation cascade just happened → fade it. The squeeze is done.
  if (liq && liq.total_liq_usd > 500_000 && liq.last_event_ago_sec != null && liq.last_event_ago_sec < 30) {
    if (liq.dominant_side === 'LONGS_GOT_REKT')  return 'FADE_SHORT'; // longs rekt = price flushed = buy the dip
    if (liq.dominant_side === 'SHORTS_GOT_REKT') return 'FADE_LONG';  // shorts rekt = price pumped = sell the pump
  }
  if (abs < 25) return 'WAIT';
  if (score >=  40) return 'LONG_NOW';
  if (score <= -40) return 'SHORT_NOW';
  return 'WAIT';
}

/**
 * Build a short human-readable reason for the current verdict. Used by the UI
 * and embedded in the analyzer prompt so the AI can quote it.
 */
function buildReason({ verdict, book_imbalance, cvd_velocity, aggressor_buy_pct, liq, nearest_magnet }) {
  const parts = [];
  if (book_imbalance != null && isFinite(book_imbalance)) {
    if      (book_imbalance >= 1.5) parts.push(`bids ${book_imbalance.toFixed(2)}× asks`);
    else if (book_imbalance <= 0.67) parts.push(`asks ${(1 / book_imbalance).toFixed(2)}× bids`);
  }
  if (cvd_velocity != null && Math.abs(cvd_velocity) >= 50_000) {
    const sign = cvd_velocity > 0 ? '+' : '-';
    parts.push(`CVD ${sign}$${(Math.abs(cvd_velocity) / 1000).toFixed(0)}k/min`);
  }
  if (aggressor_buy_pct != null) {
    if      (aggressor_buy_pct >= 65) parts.push(`buy aggr ${Math.round(aggressor_buy_pct)}%`);
    else if (aggressor_buy_pct <= 35) parts.push(`sell aggr ${100 - Math.round(aggressor_buy_pct)}%`);
  }
  if (liq && liq.last_event_ago_sec != null && liq.last_event_ago_sec < 30 && liq.total_liq_usd > 250_000) {
    const side = liq.dominant_side === 'LONGS_GOT_REKT' ? 'longs' : 'shorts';
    parts.push(`${side} just rekt $${(liq.total_liq_usd / 1000).toFixed(0)}k`);
  }
  if (nearest_magnet && nearest_magnet.distance_pct != null && Math.abs(nearest_magnet.distance_pct) < 0.6) {
    const dir = nearest_magnet.distance_usd > 0 ? 'above' : 'below';
    parts.push(`liq magnet $${Math.round(nearest_magnet.price)} ${dir}`);
  }
  if (!parts.length) parts.push('no clear edge yet');
  return parts.join(' · ');
}

/**
 * Main: compute the radar payload. Inputs:
 *   prev / curr — two market-pulse snapshots (curr being newest)
 *   liqSummary  — output of liquidation-stream.summarize(symbol)
 *   liqClusters — output of liquidation-stream.clusterRecent(symbol, ...)
 */
function computeRadar({ prev, curr, liqSummary, liqClusters }) {
  if (!curr) return null;
  const out = {
    fetched_at: curr.fetched_at,
    mid: curr.book ? curr.book.mid : null
  };

  // ── Book imbalance (already in the snapshot) ──
  out.book_imbalance = curr.book ? curr.book.imbalance_1pct : null;

  // ── Spread + spread velocity ──
  out.spread_pct = curr.book ? curr.book.spread_pct : null;
  if (prev && prev.book && curr.book) {
    const d = curr.book.spread_pct - prev.book.spread_pct;
    out.spread_velocity = Math.abs(d) < 0.0005 ? 'STABLE' : (d > 0 ? 'WIDENING' : 'TIGHTENING');
  } else {
    out.spread_velocity = 'STABLE';
  }

  // ── CVD velocity (Δcvd / Δt minutes) ──
  if (prev && prev.flow && curr.flow && curr.fetched_at && prev.fetched_at && curr.fetched_at > prev.fetched_at) {
    const dCvd = curr.flow.cvd - prev.flow.cvd;
    const dMin = (curr.fetched_at - prev.fetched_at) / 60_000;
    out.cvd_velocity_usd_per_min = dMin > 0 ? Math.round(dCvd / dMin) : 0;
  } else {
    out.cvd_velocity_usd_per_min = 0;
  }

  // ── Tape speed + aggressor split (last 60s) ──
  let tapeSpeed = 0, buyAggr = 0, sellAggr = 0;
  if (Array.isArray(curr.trades_recent) && curr.trades_recent.length) {
    const last60 = curr.trades_recent.filter(t => (t.seconds_ago || 0) <= 60);
    if (last60.length) {
      const span = Math.max(1, Math.min(60, Math.max(...last60.map(t => t.seconds_ago || 0))));
      tapeSpeed = last60.length / span;
      for (const t of last60) {
        if (t.side === 'BUY') buyAggr += t.notional || 0;
        else                  sellAggr += t.notional || 0;
      }
    }
  }
  out.tape_speed_per_sec = +tapeSpeed.toFixed(2);
  const aggrTotal = buyAggr + sellAggr;
  out.aggressor_pct = aggrTotal > 0
    ? { buy_pct: +(buyAggr / aggrTotal * 100).toFixed(1), sell_pct: +(sellAggr / aggrTotal * 100).toFixed(1), window_sec: 60 }
    : { buy_pct: 50, sell_pct: 50, window_sec: 60 };

  // ── Whale skew (last 5 min, in trades_recent we have last ~15) ──
  let whaleBuy = 0, whaleSell = 0;
  if (Array.isArray(curr.trades_recent)) {
    for (const t of curr.trades_recent) {
      if (!t.is_whale) continue;
      if (t.side === 'BUY')  whaleBuy  += t.notional || 0;
      else                    whaleSell += t.notional || 0;
    }
  }
  const whaleTotal = whaleBuy + whaleSell;
  out.whale_skew = whaleTotal > 0 ? (whaleBuy - whaleSell) / whaleTotal : 0;
  out.whale_flow_usd = { buy: Math.round(whaleBuy), sell: Math.round(whaleSell) };

  // ── Nearest liquidation magnet ──
  out.nearest_magnet = null;
  if (Array.isArray(liqClusters) && liqClusters.length && out.mid) {
    // Find the largest cluster within 1% of mid (close enough to act as magnet).
    const near = liqClusters
      .map(c => ({
        price: (c.zone_start + c.zone_end) / 2,
        side: c.side,
        notional_usd: c.notional_usd,
        event_count: c.event_count,
        distance_usd: ((c.zone_start + c.zone_end) / 2) - out.mid,
        distance_pct: (((c.zone_start + c.zone_end) / 2 - out.mid) / out.mid) * 100
      }))
      .filter(c => Math.abs(c.distance_pct) <= 1.0)
      .sort((a, b) => b.notional_usd - a.notional_usd);
    out.nearest_magnet = near[0] || null;
  }
  out.liq_clusters = (liqClusters || []).slice(0, 6);

  // ── Liquidation summary ──
  out.liquidations = liqSummary || { longs_liq_usd: 0, shorts_liq_usd: 0, total_liq_usd: 0, dominant_side: null, last_event_ago_sec: null };

  // ── Pressure score + verdict ──
  out.pressure = pressureScore({
    book_imbalance: out.book_imbalance,
    cvd_velocity: out.cvd_velocity_usd_per_min,
    aggressor_buy_pct: out.aggressor_pct.buy_pct,
    whale_skew: out.whale_skew
  });
  out.verdict = decideVerdict(out.pressure, out.liquidations);
  out.reason  = buildReason({
    verdict: out.verdict,
    book_imbalance: out.book_imbalance,
    cvd_velocity: out.cvd_velocity_usd_per_min,
    aggressor_buy_pct: out.aggressor_pct.buy_pct,
    liq: out.liquidations,
    nearest_magnet: out.nearest_magnet
  });

  // ── Trap warning: stop hunt above/below a small cluster ──
  out.trap_warning = null;
  if (out.nearest_magnet && out.mid) {
    const m = out.nearest_magnet;
    // If a small SHORT_LIQ cluster sits just above mid (within 0.3%), longs may
    // get baited into a breakout that immediately reverses once the cluster
    // hits. Same logic mirrored for LONG_LIQ clusters just below.
    if (m.notional_usd >= 100_000 && m.notional_usd < 2_000_000 && Math.abs(m.distance_pct) <= 0.3) {
      const dir = m.distance_usd > 0 ? 'above' : 'below';
      const side = m.side === 'SHORT_LIQ' ? 'breakout fakeout' : 'breakdown fakeout';
      out.trap_warning = `${side} risk: small liq cluster $${Math.round(m.price)} just ${dir} — may reverse on tag`;
    }
  }

  return out;
}

/** Compact one-paragraph version for embedding in AI prompts. */
function formatForPrompt(radar) {
  if (!radar) return '';
  const lines = ['SCALP RADAR (live, computed from orderbook + tape + liquidation feed):'];
  if (radar.mid != null) lines.push(`- Mid: $${Math.round(radar.mid)}, spread ${radar.spread_pct?.toFixed(3) ?? '—'}% (${radar.spread_velocity})`);
  lines.push(`- Pressure: ${radar.pressure >= 0 ? '+' : ''}${radar.pressure}/100 → ${radar.verdict}`);
  lines.push(`- Reason: ${radar.reason}`);
  if (radar.book_imbalance != null) lines.push(`- Book imbalance (1%): ${radar.book_imbalance.toFixed(2)}× (bid/ask)`);
  lines.push(`- CVD velocity: ${radar.cvd_velocity_usd_per_min >= 0 ? '+' : ''}$${radar.cvd_velocity_usd_per_min.toLocaleString()}/min`);
  lines.push(`- Aggressor 60s: BUY ${radar.aggressor_pct.buy_pct}% / SELL ${radar.aggressor_pct.sell_pct}%`);
  lines.push(`- Tape speed: ${radar.tape_speed_per_sec} trades/sec`);
  lines.push(`- Whale flow 5m: BUY $${radar.whale_flow_usd.buy.toLocaleString()} / SELL $${radar.whale_flow_usd.sell.toLocaleString()}`);
  if (radar.liquidations.total_liq_usd > 0) {
    lines.push(`- Liquidations 5m: longs $${Math.round(radar.liquidations.longs_liq_usd).toLocaleString()} / shorts $${Math.round(radar.liquidations.shorts_liq_usd).toLocaleString()} → ${radar.liquidations.dominant_side || '—'}`);
  }
  if (radar.nearest_magnet) {
    const m = radar.nearest_magnet;
    const dir = m.distance_usd > 0 ? 'above' : 'below';
    lines.push(`- Nearest liq magnet: $${Math.round(m.price)} (${m.side}, $${Math.round(m.notional_usd).toLocaleString()}, ${Math.abs(m.distance_usd).toFixed(0)} ${dir})`);
  }
  if (radar.trap_warning) lines.push(`- ⚠ Trap: ${radar.trap_warning}`);
  return lines.join('\n');
}

module.exports = { computeRadar, formatForPrompt, _internal: { pressureScore, decideVerdict, buildReason } };
