import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const renderer = readFileSync(
  path.join(path.resolve(__dirname, '..'), 'renderer/renderer.js'),
  'utf8'
);

/**
 * These tests guard the user's product decision: the trading analysis must be
 * short, actionable, and free of indicator/news explanations. They check the
 * source of truth (the system prompt template) directly, not the live output.
 */
describe('trading prompt — concise scenario format', () => {
  it('explicitly forbids explaining indicators', () => {
    expect(renderer).toMatch(/DO NOT[\s\S]{0,200}Explain what RSI\/MACD/);
    expect(renderer).toMatch(/Describe each indicator's reading one-by-one/);
  });

  it('explicitly forbids citing news headlines', () => {
    expect(renderer).toMatch(/DO NOT[\s\S]{0,400}Cite specific news headlines/);
  });

  it('removed the verbose SECTION 4 (indicator confluence) instruction', () => {
    // The old template required the AI to walk through each active indicator.
    expect(renderer).not.toMatch(/SECTION 4 — Indicator Confluence[\s\S]*?For each active indicator/);
  });

  it('removed the mandatory SECTION 2.6 news citation', () => {
    expect(renderer).not.toMatch(/MANDATORY[\s\S]{0,200}cite AT LEAST 2 specific items/);
  });

  it('keeps the structured tags the renderer + email parser depend on', () => {
    // Renderer's parseAll() and the worker email both look for these.
    expect(renderer).toMatch(/\[TRADE_LONG\]/);
    expect(renderer).toMatch(/\[\/TRADE_LONG\]/);
    expect(renderer).toMatch(/\[TRADE_SHORT\]/);
    expect(renderer).toMatch(/\[\/TRADE_SHORT\]/);
    expect(renderer).toMatch(/\[BIAS_BAR\]/);
    expect(renderer).toMatch(/\[\/BIAS_BAR\]/);
  });

  it('uses a 2-scenario structure (primario + alternativo)', () => {
    expect(renderer).toMatch(/ESCENARIO 1.*primario/);
    expect(renderer).toMatch(/ESCENARIO 2.*alternativo/);
  });

  it('sets a hard target length to keep responses scannable', () => {
    // We bound the length explicitly so the model doesn't drift back to essays.
    expect(renderer).toMatch(/Total length target: 450-650 words/);
  });

  it('still expects DIRECCIÓN to be UP / DOWN / RANGE', () => {
    expect(renderer).toMatch(/\*\*UP\*\* \/ \*\*DOWN\*\* \/ \*\*RANGE\*\*/);
  });

  it('keeps the data sources (charts, exchange, coinglass, order-flow, news, on-chain) coming in', () => {
    // Sanity: the input pipeline shouldn't have been touched.
    expect(renderer).toMatch(/coinglassBlock/);
    expect(renderer).toMatch(/orderflowBlock/);
    expect(renderer).toMatch(/tradeTapeBlock/);
    expect(renderer).toMatch(/hyperliquidBlock/);
    expect(renderer).toMatch(/defillamaBlock/);
  });

  it('lowers maxTokens back to a sensible value now that output is short', () => {
    // 8192 was the temporary bump to fix truncation. 4096 is now plenty.
    expect(renderer).not.toMatch(/maxTokens:\s*8192/);
    expect(renderer).toMatch(/maxTokens:\s*4096/);
  });
});
