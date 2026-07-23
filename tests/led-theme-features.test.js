import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const renderer = readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
const html     = readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const css      = readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf8');
const i18n     = readFileSync(path.join(ROOT, 'renderer/i18n.js'), 'utf8');
const main     = readFileSync(path.join(ROOT, 'main.js'), 'utf8');

describe('LED dashboard theme — CSS', () => {
  it('trading panel uses the wooden bezel + amber LED look', () => {
    // Outer frame (wood look) — must use the layered box-shadow trick.
    expect(css).toMatch(/#trading-panel[\s\S]{0,400}#4a3220/);
    // Amber primary color
    expect(css).toMatch(/#trading-panel[\s\S]{0,400}color:\s*#ffb84a/);
  });

  it('Market Pulse + Insights use the LED palette', () => {
    expect(css).toMatch(/\.mp-panel\s*\{[\s\S]{0,300}color:\s*#ffb84a/);
    expect(css).toMatch(/\.ins-panel\s*\{[\s\S]{0,400}color:\s*#ffb84a/);
  });

  it('buy/sell rows glow green/red', () => {
    expect(css).toMatch(/\.mp-row\.buy[\s\S]{0,200}#2effa3/);
    expect(css).toMatch(/\.mp-row\.sell[\s\S]{0,200}#ff4d4d/);
  });

  it('uses monospace font for the digital tablero feel', () => {
    expect(css).toMatch(/font-family:\s*['"]Courier New['"][\s\S]{0,40}['"]Menlo['"][\s\S]{0,40}monospace/);
  });

  it('watcher mode adopts the LED dashboard look globally', () => {
    expect(css).toMatch(/body\.watcher-mode\s*\{[\s\S]{0,150}#0a0604/);
    expect(css).toMatch(/body\.watcher-mode \.card\s*\{[\s\S]{0,300}#4a3220/);
  });

  it('analysis output panel (.trading-result + .tr-text) uses the LED palette', () => {
    // Dark background + amber primary
    expect(css).toMatch(/\.trading-result\s*\{[\s\S]{0,400}#0a0604/);
    expect(css).toMatch(/\.tr-text\s*\{[\s\S]{0,200}color:\s*#ffd175/);
    // Section headers glow amber and use monospace
    expect(css).toMatch(/\.tr-text h1, \.tr-text h2, \.tr-text h3\s*\{[\s\S]{0,400}#ffb84a/);
    // Trade setup cards adopt green/red LED accents
    expect(css).toMatch(/\.trade-card-long[\s\S]{0,400}#2effa3/);
    expect(css).toMatch(/\.trade-card-short[\s\S]{0,400}#ff4d4d/);
    // Decision card uses LED glow per side
    expect(css).toMatch(/\.decision-long[\s\S]{0,200}#2effa3/);
    expect(css).toMatch(/\.decision-short[\s\S]{0,200}#ff4d4d/);
    // Bias bar fills in LED green/red
    expect(css).toMatch(/\.bias-long[\s\S]{0,200}#2effa3/);
    expect(css).toMatch(/\.bias-short[\s\S]{0,200}#ff4d4d/);
  });
});

describe('Feature visibility toggles', () => {
  it('HTML exposes the 4 checkboxes', () => {
    expect(html).toMatch(/id="cfg-feature-trading"/);
    expect(html).toMatch(/id="cfg-feature-screen"/);
    expect(html).toMatch(/id="cfg-feature-interview"/);
    expect(html).toMatch(/id="cfg-feature-translate"/);
  });

  it('renderer defines applyFeatureVisibility', () => {
    expect(renderer).toMatch(/function applyFeatureVisibility\(feat\)/);
  });

  it('renderer hides .actions + chat when featureScreen is off', () => {
    // The implementation reads `actions.style.display = feat.featureScreen ? '' : 'none'`,
    // so both tokens appear on the same line in either order.
    expect(renderer).toMatch(/actions\.style\.display\s*=\s*feat\.featureScreen/);
  });

  it('renderer forces trading off when featureTrading is off', () => {
    expect(renderer).toMatch(/!feat\.featureTrading[\s\S]{0,80}applyTradingPanelVisibility\(false\)/);
  });

  it('Settings save round-trips all 4 feature flags', () => {
    expect(renderer).toMatch(/featureTrading:\s*\$\('cfg-feature-trading'\)/);
    expect(renderer).toMatch(/featureScreen:\s*\$\('cfg-feature-screen'\)/);
    expect(renderer).toMatch(/featureInterview:\s*\$\('cfg-feature-interview'\)/);
    expect(renderer).toMatch(/featureTranslate:\s*\$\('cfg-feature-translate'\)/);
  });

  it('main.js defaults the 4 feature flags to true on first run', () => {
    expect(main).toMatch(/featureTrading:\s*true/);
    expect(main).toMatch(/featureScreen:\s*true/);
    expect(main).toMatch(/featureInterview:\s*true/);
    expect(main).toMatch(/featureTranslate:\s*true/);
  });
});

describe('Feature toggle i18n parity', () => {
  function langKeys(lang) {
    const openRe = new RegExp(`^\\s+${lang}:\\s*\\{`, 'm');
    const m = openRe.exec(i18n);
    if (!m) return new Set();
    const bodyStart = m.index + m[0].length;
    const rest = i18n.slice(bodyStart);
    const nextIdx = rest.search(/^\s+(?:es|en|pt|fr|ja|zh):\s*\{/m);
    const block = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
    const set = new Set();
    const kre = /'(settings\.(?:features_label|features_hint|feature_trading|feature_screen|feature_interview|feature_translate))':/g;
    let km;
    while ((km = kre.exec(block))) set.add(km[1]);
    return set;
  }
  it('all 6 languages have the 6 feature-toggle keys', () => {
    const required = [
      'settings.features_label', 'settings.features_hint',
      'settings.feature_trading', 'settings.feature_screen',
      'settings.feature_interview', 'settings.feature_translate'
    ];
    for (const lang of ['es', 'en', 'pt', 'fr', 'ja', 'zh']) {
      const ks = langKeys(lang);
      const missing = required.filter(k => !ks.has(k));
      expect(missing, `[${lang}] missing: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
