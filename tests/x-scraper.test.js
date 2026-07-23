import { describe, it, expect, vi } from 'vitest';

// We can't import lib/x-scraper directly because it pulls in `electron`,
// which doesn't load outside the Electron runtime. Stub the electron module
// before importing.
vi.mock('electron', () => ({
  BrowserWindow: class { destroy() {} },
  session: { fromPartition: () => ({ clearStorageData: () => Promise.resolve() }) }
}));

const { asNewsItems, smartMoneyAsNewsItems, SMART_MONEY_ACCOUNTS } = await import('../lib/x-scraper.js');

describe('asNewsItems', () => {
  it('maps tweets to news-source shape', () => {
    const items = asNewsItems([
      {
        text: 'BTC breaking out',
        author: 'Cool Trader',
        handle: '@cooltrader',
        datetime: '2026-05-13T22:00:00Z',
        url: 'https://x.com/cooltrader/status/1',
        likes: 320,
        retweets: 45,
        replies: 12
      }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('BTC breaking out');
    expect(items[0].source).toBe('X · @cooltrader');
    expect(items[0].url).toContain('/status/');
    expect(items[0].published_at).toBe('2026-05-13T22:00:00Z');
    expect(items[0].votes.positive).toBe(320);
    expect(items[0].votes.important).toBe(45);
    expect(items[0].aggregator).toBe('X');
  });

  it('falls back to "X" when handle is missing', () => {
    const items = asNewsItems([{ text: 'hi', likes: 0, retweets: 0 }]);
    expect(items[0].source).toBe('X');
  });

  it('returns [] for empty / null', () => {
    expect(asNewsItems(null)).toEqual([]);
    expect(asNewsItems([])).toEqual([]);
  });
});

describe('smartMoneyAsNewsItems', () => {
  it('tags source with whale emoji and uses retweets+replies as importance', () => {
    const items = smartMoneyAsNewsItems([
      { text: 'Whale just deposited 2000 BTC to Binance', handle: '@lookonchain', datetime: '2026-05-14T20:00:00Z', url: 'https://x.com/x/status/1', likes: 800, retweets: 150, replies: 30 }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].source).toContain('Smart 🐋');
    expect(items[0].source).toContain('@lookonchain');
    expect(items[0].aggregator).toBe('SmartMoney');
    expect(items[0].votes.important).toBe(180);
  });
});

describe('SMART_MONEY_ACCOUNTS', () => {
  it('includes core whale-tracking accounts', () => {
    expect(SMART_MONEY_ACCOUNTS).toContain('lookonchain');
    expect(SMART_MONEY_ACCOUNTS).toContain('WhaleAlert');
    expect(SMART_MONEY_ACCOUNTS.length).toBeGreaterThanOrEqual(3);
  });
});
