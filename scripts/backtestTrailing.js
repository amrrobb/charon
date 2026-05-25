#!/usr/bin/env node
// Backtest different trailing_percent values with strict train/test discipline.
//
// Pre-stated thesis (per LESSONS.md): winners give back 38-43% of peak on
// the current 10% trailing. Widening trailing should retain more of the tail
// without changing win rate (entries are unchanged). Test if true.
//
// Methodology (no cherry-pick):
//   1. Take closed dry-run positions in id range, sort chronologically.
//   2. Split 70/30: first 70% = TRAIN, last 30% = TEST.
//   3. Sweep candidate trailing_percent values on TRAIN, pick the one with
//      best PF base. Then report TEST result for that value.
//   4. Also report baseline (current 10%) on both sets for comparison.
//   5. Honest verdict: ship only if TEST PF base ≥ baseline TEST PF base.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 404);
const SWEEP = [10, 15, 20, 25, 30, 40];           // pre-stated grid
const SL_PCT = -25;                                // matches degen
const PANIC_FLOOR = -5;                            // matches degen panic_sl_floor_pct
const TRAIN_FRAC = 0.7;

function simulateTrailing(snaps, trailPct, slPct, tpPct) {
  // Replay a single position through proposed trailing config.
  // tpPct: arm trailing when pnl first hits this; current code arms on tp_percent crossing.
  let peakPnl = -Infinity;
  let armed = false;
  for (const s of snaps) {
    const pnl = Number(s.unrealized_pnl_percent);
    if (!Number.isFinite(pnl)) continue;
    peakPnl = Math.max(peakPnl, pnl);
    if (!armed && pnl >= tpPct) armed = true;
    // SL: bounded loss path.
    if (pnl <= slPct) return { exitPnl: pnl, reason: 'SL' };
    // Trailing exit after armed.
    if (armed) {
      const drop = pnl - peakPnl;
      if (drop <= -Math.abs(trailPct)) return { exitPnl: pnl, reason: 'TRAILING_TP' };
    }
  }
  // Tape exhausted — exit at final pnl.
  const final = Number(snaps[snaps.length - 1]?.unrealized_pnl_percent || 0);
  return { exitPnl: final, reason: 'TAPE_END' };
}

function stats(pnls) {
  const wins = pnls.filter(x => x > 0);
  const losses = pnls.filter(x => x <= 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sortedW = [...wins].sort((a, b) => b - a);
  const gwNoTop = sortedW.slice(1).reduce((a, b) => a + b, 0);
  return {
    n: pnls.length,
    wins: wins.length,
    losses: losses.length,
    wr: pnls.length ? (wins.length / pnls.length) * 100 : 0,
    avgW: wins.length ? gw / wins.length : 0,
    avgL: losses.length ? -gl / losses.length : 0,
    pf: gl > 0 ? gw / gl : Infinity,
    pfBase: gl > 0 ? gwNoTop / gl : Infinity,
    sum: gw - gl,
    bestW: sortedW[0] || 0,
  };
}

function row(label, s) {
  return `${label.padEnd(28)} n=${String(s.n).padStart(3)} W/L=${String(s.wins).padStart(2)}/${String(s.losses).padStart(3)} WR=${s.wr.toFixed(1).padStart(5)}% | aW=${s.avgW.toFixed(1).padStart(6)}% aL=${s.avgL.toFixed(1).padStart(6)}% | PF=${s.pf.toFixed(2)}x base=${s.pfBase.toFixed(2)}x | sum=${s.sum.toFixed(0).padStart(5)}% bestW=+${s.bestW.toFixed(0)}%`;
}

const db = new Database(DB_PATH, { readonly: true });
const positions = db.prepare(`
  SELECT id, symbol, opened_at_ms, pnl_percent, tp_percent
  FROM dry_run_positions
  WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ?
  ORDER BY opened_at_ms ASC
`).all(FROM, TO);

const snapStmt = db.prepare(`
  SELECT at_ms, unrealized_pnl_percent
  FROM position_snapshots WHERE position_id=? ORDER BY at_ms ASC
`);

// Build per-position snapshot list, filter to positions with ≥2 snapshots
const replayable = positions.map(p => ({
  ...p,
  snaps: snapStmt.all(p.id),
})).filter(p => p.snaps.length >= 2);

const trainCount = Math.floor(replayable.length * TRAIN_FRAC);
const train = replayable.slice(0, trainCount);
const test = replayable.slice(trainCount);
console.log(`Pool: ${positions.length} closed in id range, ${replayable.length} replayable (≥2 snapshots).`);
console.log(`Split: TRAIN n=${train.length} (id ${train[0]?.id}-${train[train.length-1]?.id}), TEST n=${test.length} (id ${test[0]?.id}-${test[test.length-1]?.id})\n`);
console.log(`Pre-stated thesis: median winner gives back 38-43% of peak on 10% trailing. Widening retains tail.`);
console.log(`Pre-stated sweep grid: ${SWEEP.join(', ')}%   Pre-stated SL: ${SL_PCT}%   TP arm threshold: 30% (matches degen)\n`);

// Sweep on TRAIN
console.log('═══ TRAIN ═══');
const trainResults = [];
for (const trail of SWEEP) {
  const pnls = train.map(p => simulateTrailing(p.snaps, trail, SL_PCT, 30).exitPnl);
  const st = stats(pnls);
  trainResults.push({ trail, st });
  console.log(row(`trailing=${trail}%`, st));
}

// Pick best by PF base on TRAIN
const best = [...trainResults].sort((a, b) => b.st.pfBase - a.st.pfBase)[0];
console.log(`\nBest by PF base on TRAIN: trailing=${best.trail}% (PF base ${best.st.pfBase.toFixed(2)}x)\n`);

// Report TEST for baseline (10%) and the picked best
console.log('═══ TEST (out-of-sample) ═══');
const baselinePnls = test.map(p => simulateTrailing(p.snaps, 10, SL_PCT, 30).exitPnl);
const baselineSt = stats(baselinePnls);
console.log(row(`trailing=10% (baseline)`, baselineSt));

if (best.trail !== 10) {
  const pickedPnls = test.map(p => simulateTrailing(p.snaps, best.trail, SL_PCT, 30).exitPnl);
  const pickedSt = stats(pickedPnls);
  console.log(row(`trailing=${best.trail}% (picked)`, pickedSt));

  const verdict = pickedSt.pfBase >= baselineSt.pfBase ? 'PASS' : 'FAIL';
  const delta = pickedSt.pfBase - baselineSt.pfBase;
  console.log(`\nVerdict on out-of-sample: ${verdict}`);
  console.log(`  picked trailing=${best.trail}% PF base ${pickedSt.pfBase.toFixed(2)}x vs baseline 10% PF base ${baselineSt.pfBase.toFixed(2)}x`);
  console.log(`  delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}x`);
  console.log(`\n${verdict === 'PASS' ? `Safe to deploy trailing_percent=${best.trail}%.` : `Do NOT deploy. Picked value regressed out-of-sample; train was overfit.`}`);
}

// Bonus: show TEST for all sweep values for context (after the verdict, doesn't affect decision)
console.log('\n═══ TEST — all sweep values for context (NOT used for decision) ═══');
for (const trail of SWEEP) {
  const pnls = test.map(p => simulateTrailing(p.snaps, trail, SL_PCT, 30).exitPnl);
  const st = stats(pnls);
  console.log(row(`trailing=${trail}%`, st));
}
