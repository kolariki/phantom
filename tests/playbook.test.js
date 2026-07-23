import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const renderer = readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8');
const html     = readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const css      = readFileSync(path.join(ROOT, 'renderer/styles.css'), 'utf8');
const i18n     = readFileSync(path.join(ROOT, 'renderer/i18n.js'), 'utf8');

describe('Price Playbook — wiring', () => {
  it('HTML has the panel + generate button + header trigger', () => {
    expect(html).toMatch(/id="pb-panel"/);
    expect(html).toMatch(/id="pb-generate"/);
    expect(html).toMatch(/id="btn-trading-playbook"/);
    expect(html).toMatch(/id="pb-body"/);
    expect(html).toMatch(/id="pb-meta"/);
  });

  it('CSS defines LED-themed playbook with scenario cards', () => {
    expect(css).toMatch(/\.pb-panel\s*\{[\s\S]{0,500}#0a0604/);
    expect(css).toMatch(/\.pb-scenario\.long[\s\S]{0,200}#2effa3/);
    expect(css).toMatch(/\.pb-scenario\.short[\s\S]{0,200}#ff4d4d/);
    expect(css).toMatch(/\.pb-scenario\.wait[\s\S]{0,200}#ffb84a/);
  });

  it('renderer.js has setupPricePlaybook with deep-data fetch', () => {
    expect(renderer).toMatch(/setupPricePlaybook/);
    // Pulls the heavy data sources for the playbook context
    expect(renderer).toMatch(/phantom\.coinglass\.fetch/);
    expect(renderer).toMatch(/phantom\.orderflow\.fetch/);
    expect(renderer).toMatch(/phantom\.tradetape\.fetch/);
    expect(renderer).toMatch(/phantom\.hyperliquid\.fetch/);
    expect(renderer).toMatch(/phantom\.marketpulse\.fetch/);
  });

  it('uses dedicated maxTokens budget for deep analysis', () => {
    // Find the setupPricePlaybook IIFE and check it issues an ai.call with maxTokens 4096
    const start = renderer.indexOf('setupPricePlaybook');
    expect(start, 'setupPricePlaybook function should exist').toBeGreaterThan(0);
    const block = renderer.slice(start);
    expect(block).toMatch(/phantom\.ai\.call\(\{[\s\S]{0,800}maxTokens:\s*4096/);
  });

  it('persists last playbook to localStorage', () => {
    expect(renderer).toMatch(/STORAGE_KEY\s*=\s*['"]phantom_playbook_v1['"]/);
    expect(renderer).toMatch(/localStorage\.setItem\(STORAGE_KEY/);
    expect(renderer).toMatch(/localStorage\.getItem\(STORAGE_KEY/);
  });

  it('prompt enforces structured tags for parsing', () => {
    expect(renderer).toMatch(/\[LEVEL\][\s\S]{0,400}\[\/LEVEL\]/);
    expect(renderer).toMatch(/\[SCENARIO\b[\s\S]{0,400}\[\/SCENARIO\]/);
    expect(renderer).toMatch(/\[SEQUENCE\][\s\S]{0,400}\[\/SEQUENCE\]/);
  });

  it('prompt forbids vague output (no indicator name-drop, no disclaimers)', () => {
    expect(renderer).toMatch(/NO disclaimers, NO indicator name-dropping/);
  });

  it('parser extracts levels with price + role', () => {
    // Match the parser regex pattern used by parsePlaybook
    expect(renderer).toMatch(/levelRe\s*=\s*\/\\\[LEVEL\\\]\(\[\\s\\S\]\*\?\)\\\[\\\/LEVEL\\\]/);
  });

  it('parser extracts scenarios with action attribute', () => {
    expect(renderer).toMatch(/scenRe\s*=\s*\/\\\[SCENARIO\\b\(\[\^\\\]\]\*\)\\\]/);
  });

  it('respects user language setting', () => {
    expect(renderer).toMatch(/RESPOND IN \$\{langName\}/);
  });
});

describe('Price Playbook — i18n parity', () => {
  function keysFor(lang) {
    const openRe = new RegExp(`^\\s+${lang}:\\s*\\{`, 'm');
    const m = openRe.exec(i18n);
    if (!m) return new Set();
    const bodyStart = m.index + m[0].length;
    const rest = i18n.slice(bodyStart);
    const nextRe = /^\s+(?:es|en|pt|fr|ja|zh):\s*\{/m;
    const nextIdx = rest.search(nextRe);
    const block = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
    const set = new Set();
    const kre = /'(playbook\.[\w.]+)':/g;
    let km;
    while ((km = kre.exec(block))) set.add(km[1]);
    return set;
  }
  it('all 6 languages have the playbook.* keys', () => {
    const required = ['playbook.button', 'playbook.button_title', 'playbook.title',
                      'playbook.generate', 'playbook.generate_title', 'playbook.empty',
                      'playbook.generating', 'playbook.error', 'playbook.no_asset'];
    for (const lang of ['es', 'en', 'pt', 'fr', 'ja', 'zh']) {
      const ks = keysFor(lang);
      const missing = required.filter(k => !ks.has(k));
      expect(missing, `[${lang}] missing: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
