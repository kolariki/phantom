import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const renderer = readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
const css      = readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf8');
const main     = readFileSync(path.join(ROOT, 'main.js'), 'utf8');

describe('Watcher window — tall layout', () => {
  it('WATCHER_SIZE requests a very tall window (clamped to screen by main)', () => {
    expect(renderer).toMatch(/WATCHER_SIZE\s*=\s*\{[^}]*height:\s*(?:1[2-9]\d{2}|2\d{3}|3\d{3})/);
  });
});

describe('Trading separate window — opens nearly screen-tall', () => {
  it('main.js queries workArea and uses workArea.height - 60 for trading window', () => {
    expect(main).toMatch(/screen\.getPrimaryDisplay\(\)/);
    expect(main).toMatch(/workArea\.height\s*-\s*60/);
  });

  it('trading window uses dark LED background (#0a0604)', () => {
    expect(main).toMatch(/backgroundColor:\s*['"]#0a0604['"]/);
  });

  it('trading window opens narrow (≤720px wide) — tall dashboard layout', () => {
    expect(main).toMatch(/winWidth\s*=\s*Math\.min\(720/);
  });
});

describe('Insights feed — internal scroll', () => {
  it('forces max-height + overflow-y: auto on .ins-feed', () => {
    expect(css).toMatch(/\.ins-feed[\s\S]{0,400}max-height:\s*\d+px\s*!important/);
    expect(css).toMatch(/\.ins-feed[\s\S]{0,400}overflow-y:\s*auto\s*!important/);
    expect(css).toMatch(/\.ins-feed[\s\S]{0,400}overscroll-behavior:\s*contain/);
  });
});

describe('Market Pulse — walls prominence', () => {
  it('walls column is wider than tape (1.2fr vs 1fr at medium widths)', () => {
    expect(css).toMatch(/\.mp-grid\s*\{\s*grid-template-columns:\s*1\.2fr 1fr/);
  });

  it('walls appear FIRST in the rendered HTML (so they are always above the fold)', () => {
    const html = readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
    const wallsIdx = html.indexOf('id="mp-walls"');
    const tapeIdx  = html.indexOf('id="mp-tape"');
    expect(wallsIdx, 'walls element missing').toBeGreaterThan(0);
    expect(tapeIdx,  'tape element missing').toBeGreaterThan(0);
    expect(wallsIdx, 'walls must appear BEFORE tape in the DOM').toBeLessThan(tapeIdx);
  });

  it('CSS order property reinforces walls-first ordering', () => {
    expect(css).toMatch(/\.mp-col-walls\s*\{\s*order:\s*0/);
    expect(css).toMatch(/\.mp-col-tape\s*\{\s*order:\s*1/);
  });

  it('breakpoint is 600px so the 720px Trading window triggers 2-col', () => {
    expect(css).toMatch(/@media \(min-width:\s*600px\)/);
  });

  it('walls have larger max-height than tape', () => {
    expect(css).toMatch(/\.mp-walls[\s\S]{0,400}max-height:\s*320px/);
    expect(css).toMatch(/\.mp-tape[\s\S]{0,400}max-height:\s*240px/);
  });

  it('walls have padded background + border for visibility', () => {
    expect(css).toMatch(/\.mp-walls[\s\S]{0,400}background:\s*rgba\(255,\s*184,\s*74,\s*0\.03\)/);
    expect(css).toMatch(/\.mp-walls[\s\S]{0,400}border:\s*1px solid rgba\(255,\s*184,\s*74,\s*0\.18\)/);
  });

  it('walls rows are chunkier (>=12px font, 6px padding)', () => {
    expect(css).toMatch(/\.mp-wall\s*\{[\s\S]{0,400}font-size:\s*12\.5px\s*!important/);
    expect(css).toMatch(/\.mp-wall\s*\{[\s\S]{0,400}padding:\s*6px 8px\s*!important/);
  });

  it('watcher mode gives walls even more height', () => {
    expect(css).toMatch(/body\.watcher-mode \.mp-walls[\s\S]{0,200}max-height:\s*460px/);
  });
});

describe('Normal mode — trading panel sized for live data', () => {
  it('opens at 720x1100 when trading panel is enabled', () => {
    expect(renderer).toMatch(/phantom\.window\.resize\(\{\s*width:\s*720,\s*height:\s*1100/);
  });
});
