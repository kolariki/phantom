import { describe, it, expect } from 'vitest';
import { resolveSymbol, _internal } from '../lib/news-fetcher.js';
import { summarizeForPrompt, renderNewsPanel } from '../lib/news-summary.js';

const { parseRSS, decodeHTML, hoursAgo } = _internal;

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Test feed</title>
  <item>
    <title><![CDATA[Bitcoin hits new ATH at $100k]]></title>
    <link>https://example.com/btc-ath</link>
    <pubDate>Tue, 13 May 2026 12:00:00 GMT</pubDate>
    <source>CoinDesk</source>
  </item>
  <item>
    <title>ETH ETF gets approval &amp; rallies</title>
    <link>https://example.com/eth-etf</link>
    <pubDate>Mon, 12 May 2026 09:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

describe('resolveSymbol', () => {
  it('strips quote currency suffixes', () => {
    expect(resolveSymbol('BTC/USDT').symbol).toBe('BTC');
    expect(resolveSymbol('eth-usd').symbol).toBe('ETH');
    expect(resolveSymbol('SOLUSDT').symbol).toBe('SOL');
  });
  it('returns alt names when known', () => {
    const r = resolveSymbol('BTC');
    expect(r.names).toContain('Bitcoin');
  });
  it('defaults to BTC on empty', () => {
    expect(resolveSymbol('').symbol).toBe('BTC');
    expect(resolveSymbol(null).symbol).toBe('BTC');
  });
  it('falls back to the symbol itself for unknown', () => {
    const r = resolveSymbol('XYZ');
    expect(r.symbol).toBe('XYZ');
    expect(r.names).toEqual(['XYZ']);
  });
});

describe('parseRSS', () => {
  it('extracts items with title, link, source, date', () => {
    const items = parseRSS(SAMPLE_RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Bitcoin hits new ATH at $100k');
    expect(items[0].url).toBe('https://example.com/btc-ath');
    expect(items[0].source).toBe('CoinDesk');
    expect(items[0].published_at).toBeTruthy();
  });
  it('decodes HTML entities', () => {
    const items = parseRSS(SAMPLE_RSS);
    expect(items[1].title).toBe('ETH ETF gets approval & rallies');
  });
  it('returns [] on garbage input', () => {
    expect(parseRSS('not xml')).toEqual([]);
    expect(parseRSS('')).toEqual([]);
  });
});

describe('decodeHTML', () => {
  it('decodes ampersand and quote entities', () => {
    expect(decodeHTML('&amp;')).toBe('&');
    expect(decodeHTML('&quot;')).toBe('"');
    expect(decodeHTML('&#39;')).toBe("'");
  });
  it('decodes numeric entities', () => {
    expect(decodeHTML('&#65;')).toBe('A');
  });
  it('strips tags (including <...> decoded from entities)', () => {
    expect(decodeHTML('<b>hello</b>')).toBe('hello');
    // After &lt;b&gt; decodes to <b>, the tag-stripper removes it.
    expect(decodeHTML('&lt;b&gt;hello&lt;/b&gt;')).toBe('hello');
  });
});

describe('hoursAgo', () => {
  it('returns null for invalid', () => {
    expect(hoursAgo(null)).toBe(null);
    expect(hoursAgo('not a date')).toBe(null);
  });
  it('returns 0 for now', () => {
    expect(hoursAgo(new Date().toISOString())).toBe(0);
  });
});

describe('summarizeForPrompt', () => {
  it('returns empty string on null', () => {
    expect(summarizeForPrompt(null)).toBe('');
  });
  it('includes recent headlines', () => {
    const out = summarizeForPrompt({
      recent: [{ title: 'ETF approved', source: 'WSJ', hoursAgo: 2 }],
      upcoming: []
    });
    expect(out).toContain('ETF approved');
    expect(out).toContain('WSJ');
    expect(out).toContain('2h ago');
  });
  it('includes upcoming events', () => {
    const out = summarizeForPrompt({
      recent: [],
      upcoming: [{ title: 'Halving', published_at: '2026-06-01T00:00:00Z' }]
    });
    expect(out).toContain('Halving');
    expect(out).toContain('2026-06-01');
  });
  it('returns empty when there are neither headlines nor events', () => {
    // No real items → no prompt block. The system prompt's SECTION 2.6
    // instruction handles the empty case explicitly; we don't want to inject
    // a header that says "(no headlines)" because the AI then reports that.
    expect(summarizeForPrompt({ recent: [], upcoming: [] })).toBe('');
  });

  it('emits a citation mandate when there ARE items', () => {
    const out = summarizeForPrompt({
      recent: [{ source: 'Reuters', hoursAgo: 1, title: 'BTC hits 80k' }],
      upcoming: []
    });
    expect(out).toContain('you MUST cite');
    expect(out).toContain('BTC hits 80k');
  });
});

describe('renderNewsPanel', () => {
  it('returns empty notice when nothing', () => {
    const out = renderNewsPanel({ recent: [], upcoming: [] });
    expect(out).toContain('Sin noticias');
  });
  it('escapes HTML in titles', () => {
    const out = renderNewsPanel({
      recent: [{ title: '<script>alert(1)</script>', source: 'X' }],
      upcoming: []
    });
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('&lt;script&gt;');
  });
  it('renders both sections when both have data', () => {
    const out = renderNewsPanel({
      recent: [{ title: 'A', source: 'X' }],
      upcoming: [{ title: 'B', published_at: '2026-06-01T00:00:00Z' }]
    });
    expect(out).toContain('Noticias recientes');
    expect(out).toContain('Eventos próximos');
  });
});
