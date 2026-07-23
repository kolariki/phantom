import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const renderer = readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
const html     = readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const css      = readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf8');
const i18n     = readFileSync(path.join(ROOT, 'renderer/i18n.js'), 'utf8');
const main     = readFileSync(path.join(ROOT, 'main.js'), 'utf8');

describe('watcher mode — UI wiring', () => {
  it('HTML has the header toggle + floating exit', () => {
    expect(html).toMatch(/id="btn-watcher"/);
    expect(html).toMatch(/id="watcher-exit"/);
  });

  it('CSS defines .watcher-mode class hiding non-essential panels', () => {
    expect(css).toMatch(/body\.watcher-mode .actions[\s\S]*display:\s*none/);
    expect(css).toMatch(/body\.watcher-mode #trading-panel \.trading-indicators/);
    expect(css).toMatch(/body\.watcher-mode #trading-panel \.trading-result/);
    expect(css).toMatch(/body\.watcher-mode \.news-panel/);
  });

  it('CSS keeps Market Pulse + Insights visible in watcher mode', () => {
    // mp-panel and ins-panel are NOT in the hide list:
    expect(css).not.toMatch(/body\.watcher-mode \.mp-panel\s*\{[^}]*display:\s*none/);
    expect(css).not.toMatch(/body\.watcher-mode \.ins-panel\s*\{[^}]*display:\s*none/);
  });

  it('CSS shows the floating exit pill only in watcher mode', () => {
    expect(css).toMatch(/\.watcher-exit\s*\{[\s\S]*display:\s*none/);
    expect(css).toMatch(/body\.watcher-mode \.watcher-exit\s*\{[\s\S]*display:\s*inline-block/);
  });
});

describe('watcher mode — JS lifecycle', () => {
  it('renderer.js has setupWatcherMode IIFE with localStorage persistence', () => {
    expect(renderer).toMatch(/setupWatcherMode/);
    expect(renderer).toMatch(/STORAGE_KEY\s*=\s*['"]phantom_watcher_mode_v1['"]/);
  });

  it('shrinks the window when entering watcher mode', () => {
    expect(renderer).toMatch(/WATCHER_SIZE\s*=\s*\{[^}]*width:\s*\d+/);
    expect(renderer).toMatch(/phantom\.window\.resize\(WATCHER_SIZE\)/);
  });

  it('restores the previous window size on exit', () => {
    expect(renderer).toMatch(/prevSize\s*=\s*\{[^}]*width[^}]*height/);
    expect(renderer).toMatch(/phantom\.window\.resize\(prevSize\)/);
  });

  it('ESC key exits watcher mode', () => {
    expect(renderer).toMatch(/'keydown'/);
    expect(renderer).toMatch(/e\.key === 'Escape'/);
  });

  it('leave() clears inline display styles set by enter() (scroll-bug fix)', () => {
    // The bug: enter() sets `tp.style.display = 'block'` and the same on
    // .collapsible-body. If leave() does NOT reset them to '', the original
    // CSS (often flex) is overridden and inner overflow:auto stops working.
    expect(renderer).toMatch(/tp\.style\.display\s*=\s*['"]\s*['"]/);
    expect(renderer).toMatch(/tpBody\.style\.display\s*=\s*['"]\s*['"]/);
  });

  it('leave() falls back to a sensible window size if no prevSize was captured', () => {
    expect(renderer).toMatch(/phantom\.window\.resize\(\{\s*width:\s*720,\s*height:\s*1100/);
  });

  it('main.js window:resize handler uses sender, not always mainWindow', () => {
    expect(main).toMatch(/BrowserWindow\.fromWebContents\(_e\.sender\)/);
  });
});

describe('watcher mode — i18n', () => {
  function langKeys(lang) {
    // Find the block for this lang. The opening label is `  lang: {`; the
    // block ends at the next lang label or end of file.
    const openRe = new RegExp(`^\\s+${lang}:\\s*\\{`, 'm');
    const m = openRe.exec(i18n);
    if (!m) return new Set();
    const bodyStart = m.index + m[0].length;
    const rest = i18n.slice(bodyStart);
    const nextRe = /^\s+(?:es|en|pt|fr|ja|zh):\s*\{/m;
    const nextIdx = rest.search(nextRe);
    const block = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
    const set = new Set();
    const kre = /'(watcher\.[\w.]+)':/g;
    let km;
    while ((km = kre.exec(block))) set.add(km[1]);
    return set;
  }
  it('all 6 languages have watcher.toggle + watcher.exit', () => {
    const required = ['watcher.toggle', 'watcher.exit'];
    for (const lang of ['es', 'en', 'pt', 'fr', 'ja', 'zh']) {
      const ks = langKeys(lang);
      const missing = required.filter(k => !ks.has(k));
      expect(missing, `[${lang}] missing: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
