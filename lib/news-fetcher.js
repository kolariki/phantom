/**
 * News fetcher — aggregates from 4 free sources for a given crypto asset.
 *
 *   Google News RSS  → broad news coverage (mainstream + crypto media)
 *   Reddit JSON      → community sentiment (r/cryptocurrency + asset sub)
 *   CryptoPanic      → crypto-specific aggregator with bullish/bearish votes
 *   CoinMarketCal    → upcoming scheduled events (ETF, halving, upgrades)
 *
 * Each source is awaited in parallel with a per-source timeout. Failures
 * in one source do not affect the others. All functions return arrays
 * (never throw) so the caller can render whatever was obtained.
 */

const https = require('https');

/* ─── Asset name resolution (BTC/USDT → "Bitcoin" / "BTC") ─── */
const ASSET_NAMES = {
  BTC:  ['Bitcoin', 'BTC'],
  ETH:  ['Ethereum', 'ETH'],
  SOL:  ['Solana', 'SOL'],
  BNB:  ['BNB', 'Binance Coin'],
  XRP:  ['XRP', 'Ripple'],
  ADA:  ['Cardano', 'ADA'],
  DOGE: ['Dogecoin', 'DOGE'],
  AVAX: ['Avalanche', 'AVAX'],
  MATIC:['Polygon', 'MATIC'],
  LINK: ['Chainlink', 'LINK'],
  DOT:  ['Polkadot', 'DOT'],
  TRX:  ['Tron', 'TRX'],
  LTC:  ['Litecoin', 'LTC'],
  TON:  ['Toncoin', 'TON'],
  ARB:  ['Arbitrum', 'ARB'],
  OP:   ['Optimism', 'OP'],
  SUI:  ['Sui', 'SUI'],
  APT:  ['Aptos', 'APT'],
  PEPE: ['Pepe', 'PEPE'],
  SHIB: ['Shiba Inu', 'SHIB']
};

function resolveSymbol(asset) {
  // Normalize "BTC/USDT" → "BTC", "btc-usd" → "BTC", "btcusdt" → "BTC", "Bitcoin" → "BTC"
  if (!asset) return { symbol: 'BTC', names: ['Bitcoin', 'BTC'] };
  const cleaned = String(asset).toUpperCase().replace(/[^A-Z]/g, '').replace(/USDT$|USD$|USDC$|BUSD$/, '');
  const symbol = cleaned || 'BTC';
  const names = ASSET_NAMES[symbol] || [symbol];
  return { symbol, names };
}

function hoursAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return Math.round((Date.now() - t) / 36e5);
}

/* ─── Low-level HTTP with timeout (returns string) ─── */
function httpsText(urlString, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) { return reject(e); }
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: {
        // Real browser UA — Reddit and a few RSS endpoints 403 generic bots.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, application/rss+xml, text/xml, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
      // Follow simple 301/302 once.
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return httpsText(new URL(res.headers.location, urlString).toString(), timeoutMs).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('news request timeout')); });
    req.end();
  });
}

/**
 * Wrap a fetcher promise so failures don't propagate.
 * Captures the error message into a shared `errors` object for diagnostics.
 */
function withTimeoutOrEmpty(promise, fallback, errors, sourceKey) {
  return promise.catch((err) => {
    if (errors && sourceKey) errors[sourceKey] = err && err.message ? err.message.slice(0, 200) : 'unknown error';
    return fallback;
  });
}

/* ─── Minimal RSS parser (no deps) ─── */
function parseRSS(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 20) {
    const block = m[1];
    const title  = pick(block, 'title');
    const link   = pick(block, 'link');
    const pubDate = pick(block, 'pubDate') || pick(block, 'dc:date');
    const source = pick(block, 'source') || extractDomain(link);
    if (title) {
      items.push({
        title: decodeHTML(title),
        url: link || null,
        source,
        published_at: pubDate ? new Date(pubDate).toISOString() : null
      });
    }
  }
  return items;
}

function pick(block, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = block.match(re);
  if (!m) return null;
  let v = m[1].trim();
  // Strip CDATA
  v = v.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
  return v || null;
}

function decodeHTML(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/<[^>]+>/g, '');
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

/* ─── 1) Google News RSS ─── */
async function fetchGoogleNews(names) {
  const query = encodeURIComponent(`(${names.join(' OR ')}) crypto`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await httpsText(url, 8000);
  const items = parseRSS(xml).slice(0, 8).map(it => ({
    ...it,
    aggregator: 'Google News'
  }));
  return items;
}

/* ─── 2) Reddit JSON search (via old.reddit.com to skip OAuth wall) ─── */
async function fetchReddit(symbol, names) {
  const primary = names[0] || symbol;
  const q = encodeURIComponent(primary);
  // old.reddit.com doesn't enforce the same anti-bot checks as www.reddit.com.
  const url = `https://old.reddit.com/r/CryptoCurrency/search.json?q=${q}&restrict_sr=on&sort=hot&t=week&limit=10`;
  const raw = await httpsText(url, 8000);
  const json = JSON.parse(raw);
  const children = json?.data?.children || [];
  return children.slice(0, 8).map(c => ({
    title: c.data.title,
    url: 'https://reddit.com' + c.data.permalink,
    source: 'r/CryptoCurrency',
    published_at: c.data.created_utc ? new Date(c.data.created_utc * 1000).toISOString() : null,
    score: c.data.score || 0,
    comments: c.data.num_comments || 0,
    aggregator: 'Reddit'
  }));
}

/* ─── 3) CryptoPanic — moved to free public RSS feed (no auth needed) ─── */
async function fetchCryptoPanic(symbol) {
  // Old JSON API at /api/free/v1/posts/ is 404'd; the RSS feed still works.
  const url = `https://cryptopanic.com/news/rss/?currencies=${encodeURIComponent(symbol)}`;
  const xml = await httpsText(url, 8000);
  return parseRSS(xml).slice(0, 8).map(it => ({
    ...it,
    source: it.source || 'CryptoPanic',
    aggregator: 'CryptoPanic'
  }));
}

/* ─── 4) Upcoming events — CoinDesk Calendar replaces Cloudflare-blocked CMC ─── */
async function fetchUpcomingEvents(symbol, names) {
  // CoinMarketCal puts the RSS behind a Cloudflare challenge → unusable from
  // plain HTTPS. We fall back to scanning CoinDesk's "upcoming" feed and
  // filter to titles mentioning the asset. Not perfect but always responds.
  const url = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
  const xml = await httpsText(url, 8000);
  const all = parseRSS(xml);
  const needles = [symbol.toLowerCase(), ...names.map(n => n.toLowerCase())];
  // Loose filter: future-facing keywords + asset mention.
  const upcomingHints = /upgrade|halving|fork|airdrop|launch|listing|unlock|merge|catalyst|schedul|upcoming|will (be|announce|launch)|set to|expected/i;
  return all
    .filter(it => {
      const t = (it.title || '').toLowerCase();
      return needles.some(n => t.includes(n)) && upcomingHints.test(it.title || '');
    })
    .slice(0, 6)
    .map(it => ({ ...it, source: 'CoinDesk', aggregator: 'CoinDesk' }));
}

/* ─── 5) CoinDesk RSS (reliable, no auth) — primary recent-news fallback ─── */
async function fetchCoinDesk(names) {
  const url = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
  const xml = await httpsText(url, 8000);
  const all = parseRSS(xml);
  const needles = names.map(n => n.toLowerCase());
  return all
    .filter(it => {
      const t = (it.title || '').toLowerCase();
      return needles.some(n => t.includes(n));
    })
    .slice(0, 6)
    .map(it => ({ ...it, source: it.source || 'CoinDesk', aggregator: 'CoinDesk' }));
}

/* ─── Top-level orchestrator ─── */
async function fetchNews(asset) {
  const { symbol, names } = resolveSymbol(asset);
  const errors = {};

  const [google, reddit, cryptoPanic, upcoming, coinDesk] = await Promise.all([
    withTimeoutOrEmpty(fetchGoogleNews(names),             [], errors, 'google_news'),
    withTimeoutOrEmpty(fetchReddit(symbol, names),         [], errors, 'reddit'),
    withTimeoutOrEmpty(fetchCryptoPanic(symbol),           [], errors, 'crypto_panic'),
    withTimeoutOrEmpty(fetchUpcomingEvents(symbol, names), [], errors, 'coin_market_cal'),
    withTimeoutOrEmpty(fetchCoinDesk(names),               [], errors, 'coindesk')
  ]);

  // Merge recent news, de-dup by title prefix.
  const seenTitles = new Set();
  const recent = [];
  for (const list of [cryptoPanic, coinDesk, google, reddit]) {
    for (const item of list) {
      const key = (item.title || '').toLowerCase().slice(0, 60);
      if (!key || seenTitles.has(key)) continue;
      seenTitles.add(key);
      recent.push({ ...item, hoursAgo: hoursAgo(item.published_at) });
    }
  }
  // Sort recent by published_at desc (unknown dates last).
  recent.sort((a, b) => {
    if (!a.published_at) return 1;
    if (!b.published_at) return -1;
    return b.published_at.localeCompare(a.published_at);
  });

  return {
    asset: symbol,
    fetched_at: new Date().toISOString(),
    recent: recent.slice(0, 12),
    upcoming: upcoming.slice(0, 6),
    sources: {
      google_news: google.length,
      reddit: reddit.length,
      crypto_panic: cryptoPanic.length,
      coin_market_cal: upcoming.length,
      coindesk: coinDesk.length
    },
    errors: Object.keys(errors).length ? errors : null
  };
}

/* ─── Compact text summary for prompt injection ─── */
function summarizeForPrompt(newsData) {
  if (!newsData) return '';
  const hasRecent   = !!(newsData.recent   && newsData.recent.length);
  const hasUpcoming = !!(newsData.upcoming && newsData.upcoming.length);
  // No real items → no block. The prompt instructions cover the empty case.
  if (!hasRecent && !hasUpcoming) return '';

  const lines = [];
  lines.push('NEWS CONTEXT (real headlines fetched from public feeds — these ARE specific news items, you MUST cite them):');
  if (hasRecent) {
    lines.push('\nRecent headlines (last days):');
    for (const item of newsData.recent.slice(0, 10)) {
      const age = item.hoursAgo !== null ? `${item.hoursAgo}h ago` : 'recent';
      const votes = item.votes
        ? ` [+${item.votes.positive}/-${item.votes.negative}]`
        : '';
      lines.push(`  - [${item.source} · ${age}]${votes} ${item.title}`);
    }
  }
  if (hasUpcoming) {
    lines.push('\nUpcoming scheduled events:');
    for (const item of newsData.upcoming) {
      const when = item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : '';
      lines.push(`  - [${when}] ${item.title}`);
    }
  }
  lines.push('\nInterpretation rules:');
  lines.push('- Recent bullish news + bearish chart = potential bull trap, await confirmation.');
  lines.push('- Recent bearish news + bullish chart = potential bottom signal, check volume.');
  lines.push('- Upcoming event within 7 days = elevated volatility risk, consider reducing size or waiting.');
  lines.push('- Always weight the chart more than the headlines, but flag the news as a risk factor.');
  lines.push('- You MUST cite at least 2 specific headlines above by quoting a fragment in SECTION 2.6.');
  return lines.join('\n');
}

module.exports = {
  fetchNews,
  summarizeForPrompt,
  resolveSymbol,
  // exposed for tests:
  _internal: { parseRSS, decodeHTML, hoursAgo }
};
