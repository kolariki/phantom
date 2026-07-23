import { describe, it, expect, vi } from 'vitest';

// Mock electron so we can import the scraper outside Electron.
vi.mock('electron', () => ({
  BrowserWindow: class { destroy() {} }
}));

const { formatForPrompt, buildUrl } = await import('../lib/coinglass-scraper.js');

describe('buildUrl', () => {
  it('strips USDT and slash', () => {
    expect(buildUrl('BTC/USDT')).toBe('https://www.coinglass.com/currencies/BTC');
    expect(buildUrl('ETHUSDT')).toBe('https://www.coinglass.com/currencies/ETH');
    expect(buildUrl('sol')).toBe('https://www.coinglass.com/currencies/SOL');
  });
  it('defaults to BTC', () => {
    expect(buildUrl(null)).toBe('https://www.coinglass.com/currencies/BTC');
  });
});

describe('formatForPrompt', () => {
  it('returns empty string when no meaningful data', () => {
    expect(formatForPrompt(null, 'BTC')).toBe('');
    expect(formatForPrompt({ _meaningful_fields: 0 }, 'BTC')).toBe('');
  });

  it('renders the new shape of fields', () => {
    const data = {
      _meaningful_fields: 6,
      price: 80123.45,
      change_24h_pct: 1.37,
      change_7d_pct: -1.52,
      market_cap: 1_600_000_000_000,
      open_interest: 59_900_000_000,
      oi_change_24h_pct: 0.16,
      futures_volume_24h: 64_730_000_000,
      spot_volume_24h: 5_300_000_000,
      long_short_ratio: 0.9158,
      global_long_pct: 50.2,
      global_short_pct: 49.8,
      liquidations_24h_total: 83_500_000,
      long_liquidations_24h: 62_200_000,
      short_liquidations_24h: 21_200_000
    };
    const out = formatForPrompt(data, 'BTC');
    expect(out).toContain('COINGLASS AGGREGATED DATA');
    expect(out).toContain('Price: $80,123.45');
    expect(out).toContain('+1.37% 24h');
    expect(out).toContain('-1.52% 7d');
    expect(out).toContain('$59.90B');           // open interest
    expect(out).toContain('+0.16% 24h');        // OI change
    expect(out).toContain('$64.73B');           // futures volume
    expect(out).toContain('50.2% long / 49.8% short');
    expect(out).toContain('Top Trader L/S Ratio');
    expect(out).toContain('Longs rekt: $62.2M');
    expect(out).toContain('Shorts rekt: $21.2M');
    expect(out).toContain('24h Total Liquidations: $83.5M');
    expect(out).toContain('longs got squeezed harder');
    // Funding rate must NOT come from Coinglass — that lives in a canvas
    // and any value would be hallucinated.
    expect(out).not.toMatch(/Funding Rate/i);
  });

  it('detects when shorts got squeezed more', () => {
    const data = {
      _meaningful_fields: 1,
      liquidations_24h_total: 100_000_000,
      long_liquidations_24h: 20_000_000,
      short_liquidations_24h: 80_000_000
    };
    expect(formatForPrompt(data, 'ETH')).toContain('shorts got squeezed harder');
  });

  it('skips liquidation breakdown if only total available', () => {
    const data = { _meaningful_fields: 1, liquidations_24h_total: 50_000_000 };
    const out = formatForPrompt(data, 'BTC');
    expect(out).toContain('24h Total Liquidations: $50.0M');
    expect(out).not.toContain('Longs rekt');
  });

  // The extraction logic runs inside the browser, so we test the regexes
  // against the same text the page actually exposes via innerText.
  it('extraction regexes match real Coinglass text', () => {
    const sampleText = `Bitcoin Trading Overview
Over the past 24 hours,
Bitcoin spot trading volume was 5,046,840,770 USD,
and Bitcoin futures trading volume was 60,485,960,360 USD.
During the same period, around 80,624,385 USD in Bitcoin futures positions were liquidated.
The current open interest of Bitcoin is 59,488,254,632 USD.

Bitcoin Price Live
As of now, The current price of Bitcoin (BTC) is 80,002.10 USD.
Over the past 24 hours, Bitcoin price Up +0.37%;
over the past 7 days, Bitcoin price Down -0.67%.
The current circulating supply of Bitcoin is 20,029,228 BTC,
with a market capitalization of 1,601,030,407,722 USD.

24h Long/Short 50.2%/49.8%
Open Interest $134,265,811,194 +0.16%
24h Rekt $83.50M Long $62.25M Short $21.25M
Top Trader Long/Short (Positions) 0.9158
`;
    // Mirror the production regexes here to validate them.
    expect(sampleText.match(/spot trading volume was\s+([\d,]+)\s*USD/i)[1]).toBe('5,046,840,770');
    expect(sampleText.match(/futures trading volume was\s+([\d,]+)\s*USD/i)[1]).toBe('60,485,960,360');
    expect(sampleText.match(/([\d,]+)\s*USD in\s+\S+\s+futures positions were liquidated/i)[1]).toBe('80,624,385');
    expect(sampleText.match(/open interest of [^\s]+ is\s+([\d,]+)\s*USD/i)[1]).toBe('59,488,254,632');
    expect(sampleText.match(/current price of [^\s]+ \([A-Z]+\) is\s+([\d,.]+)\s*USD/i)[1]).toBe('80,002.10');
    expect(parseFloat(sampleText.match(/past 24 hours,\s+\S+\s+price (Up|Down)\s+([+\-]?[\d.]+)%/i)[2])).toBe(0.37);
    expect(sampleText.match(/past 7 days,\s+\S+\s+price (Up|Down)\s+([+\-]?[\d.]+)%/i)[1].toLowerCase()).toBe('down');
    expect(sampleText.match(/24h Long\/Short\s*(\d+(?:\.\d+)?)\s*%\s*\/\s*(\d+(?:\.\d+)?)\s*%/i)[1]).toBe('50.2');
    expect(sampleText.match(/24h Rekt\s*\$[\d.,]+[KMBT]?\s*Long\s*\$([\d.,]+[KMBT]?)\s*Short\s*\$([\d.,]+[KMBT]?)/i)[1]).toBe('62.25M');
    expect(sampleText.match(/Top Trader Long\/Short \(Positions\)\s*([\d.]+)/i)[1]).toBe('0.9158');
  });
});
