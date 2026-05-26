#!/usr/bin/env node
// Test degen_favor_v1: only enter when holderChange5m > +5%.
//
// PRE-STATED THESIS:
//   Holder velocity > +5% in last 5min is the ONLY single-feature bucket
//   that showed positive avg PnL on BOTH train (+13.7%) and test (+10.5%)
//   halves in patternAnalyzer.js + chart 2.
//   Thesis: rising holder count = fresh organic demand, NOT a topping pump.
//
// PRE-STATED THRESHOLD (no sweep): holderChange5m > 5
// PRE-STATED FALLBACK: if data missing, REJECT (this is a favor filter —
//   we only enter on confirmed positive signal, not on absence of negative).
//
// SUCCESS CRITERIA (TEST must hit all):
//   1. avg PnL ≥ +3% (vs baseline likely ~-3%)
//   2. catastrophe rate ≤ 5% (vs baseline ~8%)
//   3. n kept ≥ 10 (sample large enough to mean anything)
//
// Note: this filter is expected to reject ~95% of trades. Trade frequency
// will collapse. That's the entire point — fewer trades, higher quality.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 9999999);
const TRAIN_FRAC = 0.7;
const MIN_HOLDER_CHG = 5;

function extract(snap) {
  const c = snap.candidate || {};
  const e = c.entrySignals || {};
  const t = c.trending || {};
  const s5 = t.stats5m || {};
  return {
    holderChange5m: Number(e.holderChange5mPct ?? s5.holderChange ?? NaN),
  };
}

function stats(arr) {
  const pnls = arr.map(x => x.pnl);
  const wins = pnls.filter(x => x > 0);
  const losses = pnls.filter(x => x <= 0);
  const cats = pnls.filter(x => x <= -25);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sortedW = [...wins].sort((a, b) => b - a);
  const gwNoTop = sortedW.slice(1).reduce((a, b) => a + b, 0);
  return {
    n: arr.length, wins: wins.length, losses: losses.length, catastrophes: cats.length,
    wr: arr.length ? (wins.length / arr.length) * 100 : 0,
    catRate: arr.length ? (cats.length / arr.length) * 100 : 0,
    avgPnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
    avgW: wins.length ? gw / wins.length : 0,
    avgL: losses.length ? -gl / losses.length : 0,
    pf: gl > 0 ? gw / gl : Infinity,
    pfBase: gl > 0 ? gwNoTop / gl : Infinity,
    sum: gw - gl,
    bestW: sortedW[0] || 0,
  };
}

function row(label, s) {
  return `${label.padEnd(35)} n=${String(s.n).padStart(4)} W/L=${String(s.wins).padStart(3)}/${String(s.losses).padStart(4)} WR=${s.wr.toFixed(1).padStart(5)}% | avgPnL=${(s.avgPnl >= 0 ? '+' : '') + s.avgPnl.toFixed(1)}% cat=${s.catRate.toFixed(1)}% | PF=${s.pf.toFixed(2)}x base=${s.pfBase.toFixed(2)}x | sum=${s.sum.toFixed(0)}%`;
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT id, opened_at_ms, pnl_percent, snapshot_json
  FROM dry_run_positions WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ? AND strategy_id IN ('degen','degen_filtered_v1')
  ORDER BY opened_at_ms ASC
`).all(FROM, TO);

const items = rows.map(r => {
  let snap = {};
  try { snap = JSON.parse(r.snapshot_json); } catch {}
  return { id: r.id, pnl: Number(r.pnl_percent), feat: extract(snap) };
});

const split = Math.floor(items.length * TRAIN_FRAC);
const train = items.slice(0, split);
const test = items.slice(split);

console.log(`Pool: ${items.length} trades, TRAIN n=${train.length}, TEST n=${test.length}`);
console.log(`Filter: holderChange5m > ${MIN_HOLDER_CHG}  (REJECT when data missing)\n`);

const trainKept = train.filter(x => Number.isFinite(x.feat.holderChange5m) && x.feat.holderChange5m > MIN_HOLDER_CHG);
const testKept = test.filter(x => Number.isFinite(x.feat.holderChange5m) && x.feat.holderChange5m > MIN_HOLDER_CHG);

console.log('═══ TRAIN ═══');
console.log(row('baseline (all)', stats(train)));
console.log(row('favor-filter applied', stats(trainKept)));
console.log(`  data coverage: ${train.filter(x => Number.isFinite(x.feat.holderChange5m)).length}/${train.length} = ${(train.filter(x => Number.isFinite(x.feat.holderChange5m)).length/train.length*100).toFixed(0)}%`);
console.log(`  kept: ${trainKept.length}/${train.length} = ${(trainKept.length/train.length*100).toFixed(1)}%\n`);

console.log('═══ TEST (out-of-sample) ═══');
const baselineTest = stats(test);
const filteredTest = stats(testKept);
console.log(row('baseline (all)', baselineTest));
console.log(row('favor-filter applied', filteredTest));
console.log(`  data coverage: ${test.filter(x => Number.isFinite(x.feat.holderChange5m)).length}/${test.length} = ${(test.filter(x => Number.isFinite(x.feat.holderChange5m)).length/test.length*100).toFixed(0)}%`);
console.log(`  kept: ${testKept.length}/${test.length} = ${(testKept.length/test.length*100).toFixed(1)}%`);

console.log('\n═══ VERDICT ═══');
const passAvg = filteredTest.avgPnl >= 3;
const passCat = filteredTest.catRate <= 5;
const passN = filteredTest.n >= 10;
console.log(`  avgPnL ≥ +3%:        ${filteredTest.avgPnl >= 0 ? '+' : ''}${filteredTest.avgPnl.toFixed(2)}%  ${passAvg ? '✓' : '✗'}`);
console.log(`  catRate ≤ 5%:        ${filteredTest.catRate.toFixed(1)}%   ${passCat ? '✓' : '✗'}`);
console.log(`  n ≥ 10:              ${filteredTest.n}    ${passN ? '✓' : '✗'}`);
const all = passAvg && passCat && passN;
console.log(`\n  ${all ? 'PASS — safe to deploy as degen_favor_v1.' : 'FAIL — do NOT deploy.'}`);
if (!all && passN) {
  console.log(`\n  Note: filter kept enough trades (n=${filteredTest.n}) but performance bar not met.`);
  console.log(`  Honest read: holderChange5m signal is real but weak; deploying would risk noise.`);
}
