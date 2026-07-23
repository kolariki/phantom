import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const renderer = readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
const html     = readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const i18n     = readFileSync(path.join(ROOT, 'renderer/i18n.js'), 'utf8');

describe('insights panel — wiring', () => {
  it('HTML has the panel + feed + manual button + toggle', () => {
    expect(html).toMatch(/id="ins-panel"/);
    expect(html).toMatch(/id="ins-feed"/);
    expect(html).toMatch(/id="ins-generate"/);
    expect(html).toMatch(/id="ins-toggle"/);
    expect(html).toMatch(/id="ins-countdown"/);
  });

  it('renderer.js has the insight IIFE with 15-min cadence', () => {
    expect(renderer).toMatch(/setupInsights/);
    expect(renderer).toMatch(/POLL_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
    expect(renderer).toMatch(/MAX_FEED\s*=\s*20/);
    expect(renderer).toMatch(/STORAGE_KEY\s*=\s*['"]phantom_insights_feed_v1['"]/);
  });

  it('insight call uses a lightweight maxTokens budget', () => {
    // The full analysis uses 4096; the insight call should be much smaller.
    expect(renderer).toMatch(/maxTokens:\s*400/);
  });

  it('insight prompt enforces short two-line output and forbids verbose junk', () => {
    expect(renderer).toMatch(/DIRECTION:\s*<UP\|DOWN\|RANGE>/);
    expect(renderer).toMatch(/NO indicator names\. NO news\. NO trade setups/);
  });

  it('insight prompt respects the user language setting', () => {
    expect(renderer).toMatch(/RESPOND IN \$\{langName\}/);
  });

  it('persists feed across reloads via localStorage', () => {
    expect(renderer).toMatch(/STORAGE_KEY\s*=\s*['"]phantom_insights_feed_v1['"]/);
    expect(renderer).toMatch(/localStorage\.setItem\(STORAGE_KEY/);
    expect(renderer).toMatch(/localStorage\.getItem\(STORAGE_KEY/);
  });

  it('manual button click path runs generate({ manual: true })', () => {
    expect(renderer).toMatch(/genBtn\.addEventListener\([^)]*'click'[^)]*\)/);
    expect(renderer).toMatch(/generate\(\{\s*manual:\s*true\s*\}\)/);
  });

  it('pauses auto-generation when trading panel is hidden', () => {
    expect(renderer).toMatch(/MutationObserver/);
    expect(renderer).toMatch(/style\.display === 'none'/);
  });
});

describe('insights i18n parity', () => {
  // Build a { lang: Set<key> } map robust to ordering: split on each lang label,
  // capture keys until the next label or end of file.
  function extractLangKeys() {
    const re = /^\s+(es|en|pt|fr|ja|zh):\s*\{/gm;
    const starts = [];
    let m;
    while ((m = re.exec(i18n))) starts.push({ lang: m[1], pos: m.index });
    const out = {};
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i].pos;
      const to = i + 1 < starts.length ? starts[i + 1].pos : i18n.length;
      const block = i18n.slice(from, to);
      const keys = new Set();
      const kre = /'(ins\.[\w.]+)':/g;
      let km;
      while ((km = kre.exec(block))) keys.add(km[1]);
      out[starts[i].lang] = keys;
    }
    return out;
  }
  it('all 6 languages have all ins.* keys', () => {
    const required = ['ins.title', 'ins.generate', 'ins.generate_title', 'ins.toggle',
                      'ins.empty', 'ins.generating', 'ins.next_in', 'ins.paused',
                      'ins.error', 'ins.no_asset'];
    const byLang = extractLangKeys();
    for (const lang of ['es', 'en', 'pt', 'fr', 'ja', 'zh']) {
      const ks = byLang[lang] || new Set();
      const missing = required.filter(k => !ks.has(k));
      expect(missing, `[${lang}] missing ins.* keys: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
