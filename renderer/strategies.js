/**
 * Phantom — Trading Strategy Library
 * Proven strategies organized by category, timeframe, and market condition.
 */

const TRADING_STRATEGIES = [
  // ─── SCALPING (1m - 15m) ─────────────────────────────────
  {
    id: 'ema_cross_scalp',
    name: 'EMA 9/21 Crossover Scalp',
    category: 'scalping',
    timeframes: ['1m', '5m', '15m'],
    market: 'trending',
    indicators: ['EMA 20', 'RSI', 'Volume'],
    winRate: '62-68%',
    rr: '1:1.5',
    description: 'Entry on EMA9 crossing above/below EMA21 with RSI confirmation. Volume must be above 20-period average.',
    rules: {
      long: 'EMA9 crosses above EMA21 + RSI > 50 + Volume spike > 1.5x avg',
      short: 'EMA9 crosses below EMA21 + RSI < 50 + Volume spike > 1.5x avg',
      sl: 'Below/above the last swing low/high (typically 0.3-0.5%)',
      tp: 'TP1: 1:1 R:R, TP2: 1:1.5 R:R. Trail stop after TP1.',
      filter: 'Avoid during low volume (Asian session for crypto). Best during London/NY overlap.'
    }
  },
  {
    id: 'rsi_divergence_scalp',
    name: 'RSI Divergence Scalp',
    category: 'scalping',
    timeframes: ['5m', '15m'],
    market: 'ranging',
    indicators: ['RSI', 'EMA 50'],
    winRate: '58-65%',
    rr: '1:2',
    description: 'Identify RSI divergence at key levels. Price makes new low but RSI makes higher low (bullish) or vice versa.',
    rules: {
      long: 'Bullish RSI divergence at support + RSI < 35 + price near EMA50 or key S/R',
      short: 'Bearish RSI divergence at resistance + RSI > 65 + price near EMA50 or key S/R',
      sl: 'Below the divergence low/high + 0.2% buffer',
      tp: 'Previous swing high/low. Minimum 1:2 R:R.',
      filter: 'Works best in ranging markets. Avoid during strong trends (ADX > 40).'
    }
  },
  {
    id: 'bollinger_bounce',
    name: 'Bollinger Band Bounce',
    category: 'scalping',
    timeframes: ['5m', '15m', '1H'],
    market: 'ranging',
    indicators: ['Bollinger Bands', 'RSI', 'Stochastic'],
    winRate: '60-67%',
    rr: '1:1.5',
    description: 'Enter when price touches outer Bollinger Band and shows reversal signs. RSI/Stochastic confirm overbought/oversold.',
    rules: {
      long: 'Price touches lower BB + RSI < 30 OR Stochastic < 20 + bullish candle pattern',
      short: 'Price touches upper BB + RSI > 70 OR Stochastic > 80 + bearish candle pattern',
      sl: 'Below lower BB (long) or above upper BB (short) + 0.3%',
      tp: 'Middle BB (SMA20) for conservative. Opposite BB for aggressive.',
      filter: 'BB width must be normal (not squeezed). Squeeze = breakout coming, not bounce.'
    }
  },
  {
    id: 'vwap_scalp',
    name: 'VWAP Bounce/Rejection',
    category: 'scalping',
    timeframes: ['1m', '5m', '15m'],
    market: 'trending',
    indicators: ['VWAP', 'Volume', 'EMA 20'],
    winRate: '65-72%',
    rr: '1:1.5',
    description: 'Trade bounces off VWAP in trending markets. VWAP acts as dynamic support in uptrends and resistance in downtrends.',
    rules: {
      long: 'Price pulls back to VWAP from above + holds + volume decreases on pullback + bullish engulfing',
      short: 'Price rallies to VWAP from below + rejects + volume decreases on rally + bearish engulfing',
      sl: 'Opposite side of VWAP + 0.3%',
      tp: 'Previous high/low or 2x the VWAP distance. Trail after TP1.',
      filter: 'Only trade in direction of daily trend. Ignore if price is chopping around VWAP.'
    }
  },

  // ─── INTRADAY (15m - 1H) ─────────────────────────────────
  {
    id: 'macd_rsi_confluence',
    name: 'MACD + RSI Confluence',
    category: 'intraday',
    timeframes: ['15m', '1H'],
    market: 'trending',
    indicators: ['MACD', 'RSI', 'EMA 50', 'EMA 200'],
    winRate: '60-66%',
    rr: '1:2',
    description: 'Enter when both MACD and RSI confirm direction simultaneously. Higher probability when aligned with higher TF trend.',
    rules: {
      long: 'MACD crosses above signal + MACD histogram turning green + RSI > 50 and rising + price above EMA50',
      short: 'MACD crosses below signal + MACD histogram turning red + RSI < 50 and falling + price below EMA50',
      sl: 'Below last swing low + ATR(14)*0.5',
      tp: 'TP1: 1:1.5, TP2: 1:2.5. Move SL to BE after TP1.',
      filter: 'Best when EMA50 > EMA200 (uptrend) for longs. Avoid during news events.'
    }
  },
  {
    id: 'fibonacci_retracement',
    name: 'Fibonacci Retracement Entry',
    category: 'intraday',
    timeframes: ['15m', '1H', '4H'],
    market: 'trending',
    indicators: ['Fibonacci', 'RSI', 'Volume'],
    winRate: '58-64%',
    rr: '1:2.5',
    description: 'Enter on pullbacks to key Fibonacci levels (38.2%, 50%, 61.8%) in a trending market.',
    rules: {
      long: 'Uptrend confirmed + price pulls back to 38.2-61.8% Fib level + bullish candle + RSI bouncing from 40-50 zone',
      short: 'Downtrend confirmed + price rallies to 38.2-61.8% Fib level + bearish candle + RSI rejecting from 50-60 zone',
      sl: 'Below 78.6% Fib level (long) or above (short)',
      tp: 'TP1: -27.2% extension. TP2: -61.8% extension.',
      filter: '50% and 61.8% levels are strongest. Golden pocket (61.8-65%) has highest probability.'
    }
  },
  {
    id: 'breakout_retest',
    name: 'Breakout + Retest',
    category: 'intraday',
    timeframes: ['15m', '1H'],
    market: 'breakout',
    indicators: ['Volume', 'EMA 20', 'ATR'],
    winRate: '55-62%',
    rr: '1:3',
    description: 'Wait for price to break key S/R, then enter on the retest of the broken level. Broken support becomes resistance and vice versa.',
    rules: {
      long: 'Price breaks above resistance with volume > 2x avg + wait for pullback to broken level (now support) + bullish rejection candle',
      short: 'Price breaks below support with volume > 2x avg + wait for rally to broken level (now resistance) + bearish rejection candle',
      sl: 'Below the retest level + ATR(14)*0.3',
      tp: 'Measured move (distance of the range) projected from breakout point.',
      filter: 'Only valid with strong volume on breakout. Fake breakouts have low volume. Wait for candle CLOSE above/below level.'
    }
  },
  {
    id: 'opening_range_breakout',
    name: 'Opening Range Breakout (ORB)',
    category: 'intraday',
    timeframes: ['5m', '15m'],
    market: 'breakout',
    indicators: ['Volume', 'ATR', 'VWAP'],
    winRate: '58-65%',
    rr: '1:2',
    description: 'Define the high and low of the first 30-60 minutes, then trade the breakout direction with volume confirmation.',
    rules: {
      long: 'Price breaks above opening range high + volume spike + above VWAP',
      short: 'Price breaks below opening range low + volume spike + below VWAP',
      sl: 'Opposite side of opening range OR midpoint of range',
      tp: '1x opening range size for TP1, 2x for TP2.',
      filter: 'Best on high-volatility days. Check economic calendar. Wider range = bigger moves but wider stops.'
    }
  },

  // ─── SWING (1H - 4H - D) ─────────────────────────────────
  {
    id: 'ichimoku_cloud',
    name: 'Ichimoku Cloud Breakout',
    category: 'swing',
    timeframes: ['1H', '4H', 'D'],
    market: 'trending',
    indicators: ['Ichimoku'],
    winRate: '62-70%',
    rr: '1:3',
    description: 'Enter when price breaks through the Kumo (cloud) with Tenkan/Kijun confirmation. Powerful trend-following system.',
    rules: {
      long: 'Price above cloud + Tenkan above Kijun + Chikou above price 26 periods ago + future cloud is green',
      short: 'Price below cloud + Tenkan below Kijun + Chikou below price 26 periods ago + future cloud is red',
      sl: 'Below Kijun-sen (base line) or below cloud bottom',
      tp: 'Trail using Tenkan-sen. Exit when Tenkan crosses below Kijun.',
      filter: 'All 5 Ichimoku signals aligned = strongest setup. Inside the cloud = no trade zone.'
    }
  },
  {
    id: 'golden_cross',
    name: 'Golden/Death Cross (EMA 50/200)',
    category: 'swing',
    timeframes: ['4H', 'D'],
    market: 'trending',
    indicators: ['EMA 50', 'EMA 200', 'Volume', 'RSI'],
    winRate: '65-75%',
    rr: '1:3',
    description: 'Golden Cross: EMA50 crosses above EMA200 (bullish). Death Cross: EMA50 crosses below EMA200 (bearish). Major trend change signal.',
    rules: {
      long: 'EMA50 crosses above EMA200 + volume increasing + RSI > 50 + wait for pullback to EMA50',
      short: 'EMA50 crosses below EMA200 + volume increasing + RSI < 50 + wait for rally to EMA50',
      sl: 'Below EMA200 (long) or above EMA200 (short)',
      tp: 'Trail with EMA50. These are big moves — let them run. Take partials at 2:1 and 4:1.',
      filter: 'This is a LAGGING signal. Best used to confirm trend already started. Combine with momentum (RSI, MACD).'
    }
  },
  {
    id: 'supertrend_strategy',
    name: 'Supertrend Trend-Following',
    category: 'swing',
    timeframes: ['1H', '4H'],
    market: 'trending',
    indicators: ['Supertrend', 'ADX', 'Volume'],
    winRate: '58-65%',
    rr: '1:2.5',
    description: 'Follow Supertrend direction with ADX confirmation for trend strength. Simple but effective trend-following.',
    rules: {
      long: 'Supertrend flips green (price closes above) + ADX > 25 (trend exists) + volume above average',
      short: 'Supertrend flips red (price closes below) + ADX > 25 + volume above average',
      sl: 'At the Supertrend line (it moves with price)',
      tp: 'Trail with Supertrend. Exit when Supertrend flips color.',
      filter: 'ADX < 20 = no trend, avoid. Works best in trending markets. Choppy = whipsaw losses.'
    }
  },
  {
    id: 'double_bottom_top',
    name: 'Double Bottom / Double Top',
    category: 'swing',
    timeframes: ['1H', '4H', 'D'],
    market: 'reversal',
    indicators: ['Volume', 'RSI', 'MACD'],
    winRate: '60-68%',
    rr: '1:2.5',
    description: 'Classic reversal pattern. Two tests of the same level with momentum divergence signals exhaustion.',
    rules: {
      long: 'Price tests support twice (double bottom) + RSI bullish divergence on 2nd test + volume lower on 2nd test + break above neckline',
      short: 'Price tests resistance twice (double top) + RSI bearish divergence on 2nd test + volume lower on 2nd test + break below neckline',
      sl: 'Below the double bottom/top + 0.5%',
      tp: 'Measured move: distance from bottom to neckline projected up from neckline break.',
      filter: 'The 2nd bottom/top should have RSI divergence. Without divergence, pattern is weaker.'
    }
  },

  // ─── MEAN REVERSION ──────────────────────────────────────
  {
    id: 'bb_squeeze',
    name: 'Bollinger Band Squeeze Breakout',
    category: 'breakout',
    timeframes: ['15m', '1H', '4H'],
    market: 'breakout',
    indicators: ['Bollinger Bands', 'Volume', 'MACD'],
    winRate: '62-70%',
    rr: '1:3',
    description: 'When BB width contracts to minimum (squeeze), a big move is imminent. Trade the breakout direction.',
    rules: {
      long: 'BB squeeze (width at 6-month low) + price breaks above upper BB + volume explosion + MACD positive',
      short: 'BB squeeze + price breaks below lower BB + volume explosion + MACD negative',
      sl: 'Middle BB (SMA20)',
      tp: 'Let it run — squeezes produce big moves. Trail with middle BB. TP at 2-3x the squeeze range.',
      filter: 'The longer the squeeze, the bigger the breakout. Minimum 10-15 candles of squeeze.'
    }
  },
  {
    id: 'stochastic_oversold',
    name: 'Stochastic Extreme Reversal',
    category: 'mean_reversion',
    timeframes: ['15m', '1H'],
    market: 'ranging',
    indicators: ['Stochastic', 'EMA 50', 'Volume'],
    winRate: '58-64%',
    rr: '1:2',
    description: 'Enter when Stochastic reaches extreme levels and crosses back. Best in ranging markets.',
    rules: {
      long: 'Stochastic %K < 20 + %K crosses above %D + price near support or EMA50',
      short: 'Stochastic %K > 80 + %K crosses below %D + price near resistance or EMA50',
      sl: 'Below the recent swing low/high',
      tp: 'Opposite Stochastic extreme or key S/R level.',
      filter: 'ONLY in ranging markets. In trends, Stochastic stays overbought/oversold for extended periods.'
    }
  },

  // ─── ADVANCED / INSTITUTIONAL ────────────────────────────
  {
    id: 'order_block',
    name: 'Order Block + FVG (Smart Money)',
    category: 'advanced',
    timeframes: ['15m', '1H', '4H'],
    market: 'all',
    indicators: ['Volume', 'EMA 20'],
    winRate: '65-72%',
    rr: '1:3',
    description: 'Identify institutional order blocks (last opposing candle before impulsive move) and Fair Value Gaps (FVGs). Price tends to return to fill these.',
    rules: {
      long: 'Bullish order block identified (last bearish candle before big bullish move) + price returns to OB zone + bullish reaction + FVG below acts as magnet',
      short: 'Bearish order block identified (last bullish candle before big bearish move) + price returns to OB zone + bearish reaction + FVG above acts as magnet',
      sl: 'Below/above the order block',
      tp: 'Next order block in opposite direction or liquidity pool (equal highs/lows).',
      filter: 'Higher timeframe OBs are stronger. 4H and Daily OBs are institutional levels.'
    }
  },
  {
    id: 'liquidity_sweep',
    name: 'Liquidity Sweep + Reversal',
    category: 'advanced',
    timeframes: ['5m', '15m', '1H'],
    market: 'reversal',
    indicators: ['Volume', 'RSI'],
    winRate: '60-68%',
    rr: '1:3',
    description: 'Price sweeps above/below a key level to grab liquidity (stop losses), then reverses. Classic stop hunt pattern.',
    rules: {
      long: 'Price breaks below obvious support (stops triggered) + immediately reverses back above + volume spike on reversal + RSI divergence',
      short: 'Price breaks above obvious resistance (stops triggered) + immediately reverses back below + volume spike + RSI divergence',
      sl: 'Below the sweep low (long) or above sweep high (short) + small buffer',
      tp: 'Opposite side of the range. These moves are often violent.',
      filter: 'Look for equal lows/highs (obvious stop levels). The more obvious the level, the more likely a sweep.'
    }
  },
  {
    id: 'funding_rate_strategy',
    name: 'Funding Rate Contrarian',
    category: 'advanced',
    timeframes: ['1H', '4H'],
    market: 'all',
    indicators: ['RSI', 'Volume'],
    winRate: '62-70%',
    rr: '1:2.5',
    description: 'When funding rate is extremely positive (everyone long), short. When extremely negative (everyone short), long. Crowd is usually wrong at extremes.',
    rules: {
      long: 'Funding rate < -0.05% + price at support + RSI oversold + Fear & Greed < 30',
      short: 'Funding rate > 0.05% + price at resistance + RSI overbought + Fear & Greed > 70',
      sl: 'Below/above key level + 1%',
      tp: 'Mean reversion to neutral funding. Usually 3-5% moves.',
      filter: 'Only at EXTREME funding. Normal funding (-0.01 to 0.01) is not a signal. Combine with technical levels.'
    }
  },
  {
    id: 'ema_ribbon',
    name: 'EMA Ribbon Trend',
    category: 'swing',
    timeframes: ['1H', '4H'],
    market: 'trending',
    indicators: ['EMA 20', 'EMA 50', 'EMA 200', 'ADX'],
    winRate: '60-68%',
    rr: '1:2.5',
    description: 'Use EMA 20/50/100/200 as a ribbon. When all are stacked in order, trend is strong. Enter on pullbacks to the nearest EMA.',
    rules: {
      long: 'EMA20 > EMA50 > EMA100 > EMA200 (perfect stack) + price pulls back to EMA20 or EMA50 + bounces',
      short: 'EMA20 < EMA50 < EMA100 < EMA200 (inverse stack) + price rallies to EMA20 or EMA50 + rejects',
      sl: 'Below the next EMA in the ribbon (e.g., enter at EMA20, SL below EMA50)',
      tp: 'Trail with EMA20. Let the trend run.',
      filter: 'ADX > 25 confirms trend. Tangled/crossed EMAs = no trade.'
    }
  },
  {
    id: 'pivot_point_strategy',
    name: 'Pivot Points S/R Trading',
    category: 'intraday',
    timeframes: ['15m', '1H'],
    market: 'all',
    indicators: ['Pivot Points', 'Volume', 'RSI'],
    winRate: '60-66%',
    rr: '1:2',
    description: 'Use daily/weekly pivot points as key S/R levels. Institutional traders watch these levels.',
    rules: {
      long: 'Price bounces off S1/S2 pivot + volume increase on bounce + RSI divergence or oversold',
      short: 'Price rejects from R1/R2 pivot + volume increase on rejection + RSI overbought',
      sl: 'Below next pivot level (e.g., enter at S1, SL below S2)',
      tp: 'Next pivot level up (e.g., enter at S1, TP at Pivot, extended TP at R1).',
      filter: 'Central Pivot is the most important level. Above = bullish bias, below = bearish bias.'
    }
  },
  {
    id: 'williams_r_extreme',
    name: 'Williams %R Extreme + Trend',
    category: 'intraday',
    timeframes: ['15m', '1H'],
    market: 'trending',
    indicators: ['Williams %R', 'EMA 50', 'ADX'],
    winRate: '58-64%',
    rr: '1:2',
    description: 'Williams %R reaches -100 (oversold) or 0 (overbought) in a trending market. Trade the snapback in trend direction.',
    rules: {
      long: 'Uptrend (price > EMA50) + Williams %R < -80 + ADX > 25 + %R starts rising',
      short: 'Downtrend (price < EMA50) + Williams %R > -20 + ADX > 25 + %R starts falling',
      sl: 'Below recent swing + ATR buffer',
      tp: 'When Williams %R reaches opposite extreme.',
      filter: 'Only trade WITH the trend. Counter-trend W%R signals are traps.'
    }
  }
];

// Category labels for UI
const STRATEGY_CATEGORIES = {
  scalping: { label: 'Scalping', emoji: '⚡', color: '#f59e0b' },
  intraday: { label: 'Intraday', emoji: '📊', color: '#3b82f6' },
  swing: { label: 'Swing', emoji: '🌊', color: '#8b5cf6' },
  breakout: { label: 'Breakout', emoji: '💥', color: '#ef4444' },
  mean_reversion: { label: 'Mean Reversion', emoji: '🔄', color: '#06b6d4' },
  advanced: { label: 'Smart Money', emoji: '🐋', color: '#10b981' }
};
