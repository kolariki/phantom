/**
 * X (Twitter) scraper — uses a hidden Electron BrowserWindow with a
 * persisted session partition. Personal-use only.
 *
 *   First time:  show login window → user logs in once → cookies persist.
 *   Subsequent:  open hidden window, load search URL, extract tweets via JS.
 *
 * Returns tweets in the same shape as other news sources:
 *   { title, source, url, published_at, votes, aggregator }
 *
 * Filters: only main tweets (no replies). Replies are identified by the
 * presence of a "Replying to" prefix in the tweet conversation context.
 */

const { BrowserWindow, session } = require('electron');
const { createLogger } = require('./logger');

const log = createLogger('x-scraper');
const PARTITION = 'persist:x-scraper';
const LOGIN_URL = 'https://x.com/login';
const HOME_URL  = 'https://x.com/home';

let cachedAuthState = null; // { authenticated: bool, checked_at: number }
const AUTH_CACHE_MS = 60 * 1000;

function createWin(opts = {}) {
  return new BrowserWindow({
    width:  opts.width  || 1100,
    height: opts.height || 800,
    show:   !!opts.show,
    title:  'Phantom — X session',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
}

/* ─── Auth check: is the persisted session logged in? ─── */
async function checkAuth(force = false) {
  if (!force && cachedAuthState && (Date.now() - cachedAuthState.checked_at) < AUTH_CACHE_MS) {
    return cachedAuthState.authenticated;
  }

  const win = createWin({ show: false });
  let authed = false;
  try {
    await win.loadURL(HOME_URL).catch(() => {});
    // Give the page a moment to redirect to /login if not authenticated.
    await new Promise(r => setTimeout(r, 2500));
    const url = win.webContents.getURL();
    // Authenticated home looks like https://x.com/home; unauth gets bounced.
    authed = /\/home(\?|$|\/)/.test(url) || /x\.com\/(i\/)?$/.test(url);
    if (!authed) {
      // Some auth flows put us at x.com/?logged_in=1 first — try once more.
      const has = await win.webContents.executeJavaScript(`
        !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [aria-label*="Account menu"], [data-testid="primaryColumn"]')
      `).catch(() => false);
      authed = !!has;
    }
  } catch (e) {
    log.warn('checkAuth error', e);
    authed = false;
  } finally {
    win.destroy();
  }

  cachedAuthState = { authenticated: authed, checked_at: Date.now() };
  log.info('auth state', { authed });
  return authed;
}

/* ─── Interactive login: opens visible window, waits for /home ─── */
async function startLogin() {
  const win = createWin({ show: true });
  win.setTitle('Phantom — Inicia sesión en X (cerrá esta ventana cuando termines)');
  await win.loadURL(LOGIN_URL).catch(() => {});

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (authed) => {
      if (resolved) return;
      resolved = true;
      cachedAuthState = { authenticated: authed, checked_at: Date.now() };
      if (!win.isDestroyed()) win.destroy();
      resolve({ authenticated: authed });
    };

    // Poll the URL — when it lands on /home, we're in.
    const interval = setInterval(() => {
      try {
        if (win.isDestroyed()) {
          clearInterval(interval);
          finish(false);
          return;
        }
        const url = win.webContents.getURL();
        if (/x\.com\/home/.test(url) || /x\.com\/i\/flow\/login\/success/.test(url)) {
          clearInterval(interval);
          finish(true);
        }
      } catch (_) {}
    }, 1500);

    win.on('closed', () => {
      clearInterval(interval);
      // User closed the window — re-check auth (they might have logged in).
      checkAuth(true).then(authed => finish(authed));
    });
  });
}

/* ─── Logout: clear the persisted session ─── */
async function logout() {
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData().catch(() => {});
  cachedAuthState = { authenticated: false, checked_at: Date.now() };
  log.info('session cleared');
  return { ok: true };
}

/* ─── Fetch tweets for a query (main tweets only, no replies) ─── */
async function fetchTweets({ query, count = 15, lang = 'en' }) {
  if (!query) return [];
  const authed = await checkAuth();
  if (!authed) {
    log.warn('fetchTweets called without auth');
    return [];
  }

  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  const win = createWin({ show: false });
  let tweets = [];
  try {
    await win.loadURL(url).catch(() => {});
    // Wait for tweets to render. Poll for up to ~10s.
    for (let i = 0; i < 10; i++) {
      const n = await win.webContents.executeJavaScript(`
        document.querySelectorAll('[data-testid="tweet"]').length
      `).catch(() => 0);
      if (n >= Math.min(count, 5)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    tweets = await win.webContents.executeJavaScript(buildExtractScript(count)).catch(() => []);
  } catch (e) {
    log.error('fetchTweets failed', e);
    tweets = [];
  } finally {
    win.destroy();
  }
  log.info('fetched tweets', { query, count: tweets.length });
  return tweets;
}

/* ─── Extraction script (runs inside the X page context) ─── */
function buildExtractScript(maxCount) {
  return `(function() {
    function txt(el) { return el ? (el.innerText || el.textContent || '').trim() : ''; }
    const out = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const art of articles) {
      try {
        // Skip replies: they have a "Replying to" header above the tweet text.
        const replyHeader = art.querySelector('[data-testid="reply-context"]');
        if (replyHeader) continue;
        const replyText = txt(art).slice(0, 100);
        if (/^Replying to|^Respondiendo a/i.test(replyText)) continue;

        const textEl = art.querySelector('[data-testid="tweetText"]');
        const text = txt(textEl);
        if (!text || text.length < 5) continue;

        const userEl = art.querySelector('[data-testid="User-Name"]');
        const userTxt = txt(userEl);
        const handleMatch = userTxt.match(/@([A-Za-z0-9_]+)/);
        const handle = handleMatch ? '@' + handleMatch[1] : null;
        const displayName = handle ? userTxt.split('@')[0].trim() : userTxt.split('\\n')[0].trim();

        const timeEl = art.querySelector('time[datetime]');
        const datetime = timeEl ? timeEl.getAttribute('datetime') : null;

        const linkEl = art.querySelector('a[href*="/status/"]');
        const href = linkEl ? linkEl.getAttribute('href') : null;
        const url = href ? (href.startsWith('http') ? href : 'https://x.com' + href) : null;

        // Engagement: data-testid="reply" / "retweet" / "like" buttons have aria-label with counts.
        function countFrom(testid) {
          const btn = art.querySelector('[data-testid="' + testid + '"]');
          if (!btn) return 0;
          const label = btn.getAttribute('aria-label') || '';
          const m = label.match(/([0-9][\\d,.]*)/);
          if (!m) return 0;
          let n = parseFloat(m[1].replace(/,/g, ''));
          if (/K/i.test(label)) n *= 1000;
          if (/M/i.test(label)) n *= 1000000;
          return Math.round(n);
        }
        const likes      = countFrom('like');
        const retweets   = countFrom('retweet');
        const replies    = countFrom('reply');

        out.push({
          text: text.slice(0, 500),
          author: displayName,
          handle,
          datetime,
          url,
          likes,
          retweets,
          replies
        });
        if (out.length >= ${maxCount}) break;
      } catch (_) {}
    }
    return out;
  })();`;
}

/* ─── Adapt to news-source shape ─── */
function asNewsItems(tweets) {
  return (tweets || []).map(tw => ({
    title: tw.text,
    url: tw.url,
    source: tw.handle ? `X · ${tw.handle}` : 'X',
    published_at: tw.datetime || null,
    votes: {
      positive: tw.likes || 0,
      negative: 0,
      important: tw.retweets || 0
    },
    aggregator: 'X'
  }));
}

/**
 * Smart-money tweets — query a curated set of on-chain analytics accounts
 * filtered by the asset of interest. These accounts post whale moves,
 * large transfers, and institutional flows in near-real-time.
 */
const SMART_MONEY_ACCOUNTS = [
  'lookonchain',     // wallet moves, whale activity (very high signal)
  'WhaleAlert',      // large transfers >$1M
  'spotonchain',     // on-chain analysis
  'EmberCN',         // chinese whale tracker, often early
  'OnchainLens'      // wallet positions
];

async function fetchSmartMoneyTweets({ asset, count = 10 }) {
  const tag = (asset || 'BTC').toUpperCase().replace(/[^A-Z]/g, '').replace(/USDT$|USDC$|USD$/, '') || 'BTC';
  const names = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin' };
  const term = names[tag] ? `(${tag} OR ${names[tag]})` : tag;
  const fromClause = SMART_MONEY_ACCOUNTS.map(a => `from:${a}`).join(' OR ');
  const query = `(${fromClause}) ${term} -filter:replies`;
  const tweets = await fetchTweets({ query, count });
  // Tag each tweet so we know it's smart-money sourced.
  return (tweets || []).map(t => ({ ...t, smart_money: true }));
}

/** Convert smart-money tweets to news-shape with a distinguishing aggregator tag. */
function smartMoneyAsNewsItems(tweets) {
  return (tweets || []).map(tw => ({
    title: tw.text,
    url: tw.url,
    source: tw.handle ? `Smart 🐋 ${tw.handle}` : 'Smart 🐋',
    published_at: tw.datetime || null,
    votes: {
      positive: tw.likes || 0,
      negative: 0,
      important: (tw.retweets || 0) + (tw.replies || 0)
    },
    aggregator: 'SmartMoney'
  }));
}

module.exports = {
  checkAuth,
  startLogin,
  logout,
  fetchTweets,
  fetchSmartMoneyTweets,
  asNewsItems,
  smartMoneyAsNewsItems,
  SMART_MONEY_ACCOUNTS
};
