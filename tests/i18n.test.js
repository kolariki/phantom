import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

function readText(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Parse i18n.js into { lang: Set<key> }. Dep-free regex parser. */
function extractLangKeys(i18nSrc) {
  const langStarts = [];
  const re = /^\s+(es|en|pt|fr|ja|zh):\s*\{/gm;
  let m;
  while ((m = re.exec(i18nSrc))) langStarts.push({ lang: m[1], pos: m.index });
  const keys = {};
  for (let i = 0; i < langStarts.length; i++) {
    const start = langStarts[i].pos;
    const end = i + 1 < langStarts.length ? langStarts[i + 1].pos : i18nSrc.length;
    const block = i18nSrc.slice(start, end);
    const set = new Set();
    const keyRe = /^\s+'([\w.]+)':/gm;
    let km;
    while ((km = keyRe.exec(block))) set.add(km[1]);
    keys[langStarts[i].lang] = set;
  }
  return keys;
}

describe('i18n parity', () => {
  const i18n = readText('renderer/i18n.js');
  const keys = extractLangKeys(i18n);
  const supportedLangs = ['es', 'en', 'pt', 'fr', 'ja', 'zh'];

  it('has all 6 languages defined', () => {
    for (const lang of supportedLangs) {
      expect(keys[lang], `missing language block: ${lang}`).toBeDefined();
      expect(keys[lang].size).toBeGreaterThan(50);
    }
  });

  it('every language has identical key coverage as Spanish (reference)', () => {
    const base = keys.es;
    for (const lang of supportedLangs) {
      if (lang === 'es') continue;
      const ks = keys[lang];
      const missing = [...base].filter(k => !ks.has(k));
      const extra = [...ks].filter(k => !base.has(k));
      expect(missing, `[${lang}] missing keys vs es: ${missing.slice(0, 5).join(', ')}`).toEqual([]);
      expect(extra,   `[${lang}] extra keys vs es: ${extra.slice(0, 5).join(', ')}`).toEqual([]);
    }
  });
});

describe('i18n coverage of UI surface', () => {
  const i18n = readText('renderer/i18n.js');
  const html = readText('renderer/index.html');
  const js = readText('renderer/renderer.js');
  const esKeys = extractLangKeys(i18n).es;

  it('every data-i18n* attribute in HTML maps to an existing key', () => {
    const htmlKeys = new Set();
    const attrRe = /data-i18n(?:-(?:placeholder|title|aria-label))?\s*=\s*["']([\w.]+)["']/g;
    let m;
    while ((m = attrRe.exec(html))) htmlKeys.add(m[1]);
    const missing = [...htmlKeys].filter(k => !esKeys.has(k));
    expect(missing, `HTML keys missing from i18n: ${missing.join(', ')}`).toEqual([]);
  });

  it("every t('...') literal in renderer.js maps to an existing key", () => {
    const jsKeys = new Set();
    const tRe = /\bt\(['"]([\w.]+)['"]\)/g;
    let m;
    while ((m = tRe.exec(js))) jsKeys.add(m[1]);
    const missing = [...jsKeys].filter(k => !esKeys.has(k));
    expect(missing, `JS keys missing from i18n: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('AI response language enforcement', () => {
  const js = readText('renderer/renderer.js');

  it('exposes a chartAnalysisPrompt() helper with all 6 languages', () => {
    expect(js).toMatch(/CHART_ANALYSIS_PROMPTS\s*=\s*\{/);
    for (const lang of ['es', 'en', 'pt', 'fr', 'ja', 'zh']) {
      // The dictionary entry exists for every lang.
      expect(js).toMatch(new RegExp(`${lang}:\\s*['"\`]`));
    }
  });

  it('chartAnalysisPrompt is used in both manual and auto analysis (not hardcoded EN/ES)', () => {
    const callCount = (js.match(/chartAnalysisPrompt\(uiLang\)/g) || []).length;
    expect(callCount, 'chartAnalysisPrompt should be called in both paths').toBeGreaterThanOrEqual(2);
    // Make sure the old hardcoded "Analizá estos gráficos de trading. La PRIMERA..." string
    // does NOT appear as a fallback string at a call site anymore (only inside the helper).
    const hardcoded = (js.match(/'Analizá estos gráficos de trading\. La PRIMERA/g) || []).length;
    expect(hardcoded, 'old hardcoded ES prompt should only appear inside CHART_ANALYSIS_PROMPTS').toBeLessThanOrEqual(1);
  });

  it('trading system prompt enforces language at the very start', () => {
    // The opening of the trading system prompt should mention LANGUAGE as priority.
    expect(js).toMatch(/OUTPUT LANGUAGE\s+—\s+ABSOLUTE PRIORITY/);
  });

  it('trading system prompt repeats the language reminder at the end', () => {
    expect(js).toMatch(/LANGUAGE REMINDER \(last check before you reply\)/);
  });
});
