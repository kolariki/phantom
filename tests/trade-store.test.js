import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initStore,
  logAnalysis,
  updateTrade,
  listTrades,
  getTrade,
  getRecentForAsset,
  computeStats
} from '../lib/trade-store.js';

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-trade-test-'));
  initStore(dir);
  return dir;
}

describe('trade-store basic ops', () => {
  beforeEach(() => { freshDir(); });

  it('logs and reads back a trade', () => {
    const rec = logAnalysis({
      asset: 'BTC/USDT',
      ai_decision: 'LONG',
      ai_confluence: '3/4',
      ai_bias_long: 65,
      ai_bias_short: 35
    });
    expect(rec.id).toBeTruthy();
    expect(rec.user_action).toBe(null);
    expect(rec.outcome).toBe(null);
    expect(getTrade(rec.id).asset).toBe('BTC/USDT');
  });

  it('updates a trade preserving id', () => {
    const rec = logAnalysis({ asset: 'ETH/USDT', ai_decision: 'SHORT' });
    const updated = updateTrade(rec.id, { user_action: 'short', user_entry: 3000, outcome: 'open' });
    expect(updated.id).toBe(rec.id);
    expect(updated.user_action).toBe('short');
    expect(updated.user_entry).toBe(3000);
  });

  it('returns null when updating an unknown id', () => {
    expect(updateTrade('nope', { outcome: 'win' })).toBe(null);
  });

  it('persists across re-init (JSONL replay)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-trade-test-'));
    initStore(dir);
    const rec = logAnalysis({ asset: 'SOL/USDT', ai_decision: 'WAIT' });
    initStore(dir); // simulate restart
    expect(getTrade(rec.id).asset).toBe('SOL/USDT');
  });

  it('list filters: open trades', () => {
    const a = logAnalysis({ asset: 'A/USDT', ai_decision: 'LONG' });
    const b = logAnalysis({ asset: 'B/USDT', ai_decision: 'LONG' });
    updateTrade(a.id, { user_action: 'long', outcome: 'open' });
    updateTrade(b.id, { user_action: 'long', outcome: 'win', outcome_pnl_pct: 2 });
    const open = listTrades({ open: true });
    expect(open.length).toBe(1);
    expect(open[0].asset).toBe('A/USDT');
  });
});

describe('getRecentForAsset', () => {
  beforeEach(() => { freshDir(); });
  it('returns trades for matching asset within window, newest first', () => {
    logAnalysis({ asset: 'BTC/USDT', ai_decision: 'LONG' });
    logAnalysis({ asset: 'BTC/USDT', ai_decision: 'WAIT' });
    logAnalysis({ asset: 'ETH/USDT', ai_decision: 'SHORT' });
    const recent = getRecentForAsset('BTC/USDT', { sinceMs: 60 * 60 * 1000, limit: 5 });
    expect(recent).toHaveLength(2);
    expect(recent[0].ai_decision).toBe('WAIT');
    expect(recent[1].ai_decision).toBe('LONG');
  });
  it('respects limit', () => {
    for (let i = 0; i < 5; i++) logAnalysis({ asset: 'BTC/USDT', ai_decision: 'LONG' });
    const recent = getRecentForAsset('BTC/USDT', { limit: 2 });
    expect(recent).toHaveLength(2);
  });
});

describe('computeStats', () => {
  beforeEach(() => { freshDir(); });

  function seed(records) {
    const ids = [];
    for (const r of records) {
      const rec = logAnalysis(r.log);
      if (r.update) updateTrade(rec.id, r.update);
      ids.push(rec.id);
    }
    return ids;
  }

  it('returns zeros on empty store', () => {
    const s = computeStats({});
    expect(s.totalAnalyses).toBe(0);
    expect(s.winRate).toBe(0);
  });

  it('counts wins/losses correctly', () => {
    seed([
      { log: { asset: 'A', ai_decision: 'LONG' }, update: { user_action: 'long', outcome: 'win',  outcome_pnl_pct: 3 } },
      { log: { asset: 'B', ai_decision: 'LONG' }, update: { user_action: 'long', outcome: 'win',  outcome_pnl_pct: 2 } },
      { log: { asset: 'C', ai_decision: 'LONG' }, update: { user_action: 'long', outcome: 'loss', outcome_pnl_pct: -1 } }
    ]);
    const s = computeStats({});
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(2 / 3, 5);
    expect(s.totalPnlPct).toBeCloseTo(4, 5);
  });

  it('ignores cancelled and open trades in win-rate', () => {
    seed([
      { log: { asset: 'A', ai_decision: 'LONG' }, update: { user_action: 'long', outcome: 'win',       outcome_pnl_pct: 2 } },
      { log: { asset: 'B', ai_decision: 'LONG' }, update: { user_action: 'long', outcome: 'cancelled' } },
      { log: { asset: 'C', ai_decision: 'LONG' }, update: { user_action: 'long', outcome: 'open' } }
    ]);
    const s = computeStats({});
    expect(s.closed).toBe(1);
    expect(s.winRate).toBe(1);
  });

  it('tracks override (AI said WAIT, user entered)', () => {
    seed([
      { log: { asset: 'A', ai_decision: 'WAIT' }, update: { user_action: 'long',    outcome: 'loss', outcome_pnl_pct: -1 } },
      { log: { asset: 'B', ai_decision: 'LONG' }, update: { user_action: 'long',    outcome: 'win',  outcome_pnl_pct: 2 } },
      { log: { asset: 'C', ai_decision: 'WAIT' }, update: { user_action: 'skipped' } }
    ]);
    const s = computeStats({});
    expect(s.overrideTrades).toBe(1);
    expect(s.overrideWinRate).toBe(0);
  });

  it('breaks down by confluence score', () => {
    seed([
      { log: { ai_decision: 'LONG', ai_confluence: '4/4' }, update: { user_action: 'long', outcome: 'win',  outcome_pnl_pct: 2 } },
      { log: { ai_decision: 'LONG', ai_confluence: '4/4' }, update: { user_action: 'long', outcome: 'win',  outcome_pnl_pct: 1 } },
      { log: { ai_decision: 'LONG', ai_confluence: '2/4' }, update: { user_action: 'long', outcome: 'loss', outcome_pnl_pct: -1 } }
    ]);
    const s = computeStats({});
    expect(s.byConfluence['4/4'].winRate).toBe(1);
    expect(s.byConfluence['2/4'].winRate).toBe(0);
  });
});
