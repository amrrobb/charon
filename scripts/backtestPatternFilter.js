#!/usr/bin/env node
// Backtest the pattern-derived avoid-filter with strict LESSONS.md discipline.
//
// PRE-STATED THESIS:
//   Four feature buckets show CONSISTENT loss tendency across TRAIN and TEST
//   in patternAnalyzer.js output:
//   - vol5m > 6000      : "topping pump, exhausting"
//   - entryMcap < 10K   : "thin token, bonding-curve vulnerable"
//   - priceChange5m > 30: "parabolic blow-off, late entry"
//   - priceChange5m < -10..0%: "already turning down"
//
//   Avoid filter: reject if ANY of the four conditions hit.
//
// PRE-STATED THRESHOLDS (taken directly from bucket boundaries, NOT swept):
//   maxVol5m = 6000
//   minEntryMcap = 10000
//   maxPriceChange5m = 30
//   minPriceChange5m = -10
//
// SUCCESS CRITERIA (all three must hold on TEST):
//   1. Catastrophe rate drops by ≥3pp
//   2. PF base does NOT drop more than 0.05x
//   3. Best winner retained ≥80% of baseline
//
// METHODOLOGY: 70/30 chronological split. Filter applied identically on both.
// TEST result is the verdict. No optimization on TEST.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 9999999);
const TRAIN_FRAC = 0.7;
const CATASTROPHE = -25;

const MAX_VOL5M = 6000;
const MIN_ENTRY_MCAP = 10000;
const MAX_PCHG5 = 30;
const MIN_PCHG5 = -10;

function extract(snap, entryMcap) {
  const c = snap.candidate || {};
  const e = c.entrySignals || {};
  const t = c.trending || {};
  const s5 = t.stats5m || {};
  return {
    entryMcap: Number(entryMcap),
    vol5m: Number(e.vol5mUsd ?? t.volume5m ?? NaN),
    priceChange5m: Number(e.priceChange5mPct ?? s5.priceChange ?? t.change5m ?? NaN),
  };
}

function passes(f) {
  // Each leg: pass-through when data is missing (don't reject on absent data,
  // matches how the live filter will behave when trending data isn't available).
  if (Number.isFinite(f.vol5m) && f.vol5m > MAX_VOL5M) return { ok: false, reason: 'vol5m>6000' };
  if (Number.isFinite(f.entryMcap) && f.entryMcap < MIN_ENTRY_MCAP) return { ok: false, reason: 'mcap<10K' };
  if (Number.isFinite(f.priceChange5m)) {
    if (f.priceChange5m > MAX_PCHG5) return { ok: false, reason: 'pchg>30' };
    if (f.priceChange5m < MIN_PCHG5) return { ok: false, reason: 'pchg<-10' };
  }
  return { ok: true };
}

function stats(arr) {
  const pnls = arr.map(x => x.pnl);
  const wins = pnls.filter(x => x > 0);
  const losses = pnls.filter(x => x <= 0);
  const cats = pnls.filter(x => x <= CATASTROPHE);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sortedW = [...wins].sort((a, b) => b - a);
  const gwNoTop = sortedW.slice(1).reduce((a, b) => a + b, 0);
  return {
    n: arr.length, wins: wins.length, losses: losses.length,
    catastrophes: cats.length,
    catastropheRate: arr.length ? (cats.length / arr.length) * 100 : 0,
    wr: arr.length ? (wins.length / arr.length) * 100 : 0,
    avgW: wins.length ? gw / wins.length : 0,
    avgL: losses.length ? -gl / losses.length : 0,
    pf: gl > 0 ? gw / gl : Infinity,
    pfBase: gl > 0 ? gwNoTop / gl : Infinity,
    sum: gw - gl,
    bestW: sortedW[0] || 0,
  };
}

function row(label, s) {
  return `${label.padEnd(28)} n=${String(s.n).padStart(4)} W/L=${String(s.wins).padStart(3)}/${String(s.losses).padStart(4)} WR=${s.wr.toFixed(1).padStart(5)}% | cat=${String(s.catastrophes).padStart(2)}(${s.catastropheRate.toFixed(1).padStart(4)}%) | aW=${s.avgW.toFixed(1).padStart(5)}% aL=${s.avgL.toFixed(1).padStart(6)}% | PF=${s.pf.toFixed(2)}x base=${s.pfBase.toFixed(2)}x | sum=${s.sum.toFixed(0).padStart(5)}% best=+${s.bestW.toFixed(0)}%`;
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT id, opened_at_ms, pnl_percent, entry_mcap, snapshot_json
  FROM dry_run_positions WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ? AND strategy_id IN ('degen','degen_filtered_v1')
  ORDER BY opened_at_ms ASC
`).all(FROM, TO);

const items = rows.map(r => {
  let snap = {};
  try { snap = JSON.parse(r.snapshot_json); } catch {}
  return { id: r.id, pnl: Number(r.pnl_percent), feat: extract(snap, r.entry_mcap) };
});

const trainCount = Math.floor(items.length * TRAIN_FRAC);
const train = items.slice(0, trainCount);
const test = items.slice(trainCount);

console.log(`Pool: ${items.length} closed positions (id ${FROM}-${TO})`);
console.log(`Split: TRAIN n=${train.length}, TEST n=${test.length}\n`);
console.log(`Pre-stated avoid filter (no sweep):`);
console.log(`  vol5m ≤ ${MAX_VOL5M}     entryMcap ≥ ${MIN_ENTRY_MCAP}`);
console.log(`  priceChange5m ∈ [${MIN_PCHG5}%, ${MAX_PCHG5}%]`);
console.log(`Pre-stated success bar: catΔ ≥ 3pp, pfBaseΔ ≥ -0.05x, moonshot ≥ 80%\n`);

// TRAIN
const trainBase = stats(train);
const trainKept = train.filter(x => passes(x.feat).ok);
const trainStat = stats(trainKept);
console.log('═══ TRAIN ═══');
console.log(row('baseline', trainBase));
console.log(row('avoid-filter applied', trainStat));
console.log(`  kept ${trainKept.length}/${train.length} = ${(trainKept.length/train.length*100).toFixed(0)}%\n`);

// TEST
const testBase = stats(test);
const testKept = test.filter(x => passes(x.feat).ok);
const testStat = stats(testKept);
console.log('═══ TEST (out-of-sample, verdict) ═══');
console.log(row('baseline', testBase));
console.log(row('avoid-filter applied', testStat));
console.log(`  kept ${testKept.length}/${test.length} = ${(testKept.length/test.length*100).toFixed(0)}%`);

// Rejection breakdown
const rejected = test.filter(x => !passes(x.feat).ok);
const reasons = {};
for (const r of rejected) {
  const reason = passes(r.feat).reason;
  reasons[reason] = (reasons[reason] || 0) + 1;
}
console.log(`  rejection reasons:`, reasons);

// Verdict
const catDrop = testBase.catastropheRate - testStat.catastropheRate;
const pfBaseDelta = testStat.pfBase - testBase.pfBase;
const moonshotKept = testBase.bestW > 0 ? (testStat.bestW / testBase.bestW * 100) : 100;

console.log(`\n═══ VERDICT ═══`);
console.log(`  Catastrophe drop: ${baseFmt(catDrop)}pp  (need ≥ 3pp)        ${pass(catDrop >= 3)}`);
console.log(`  PF base delta:    ${baseFmt(pfBaseDelta)}x   (need ≥ -0.05x)  ${pass(pfBaseDelta >= -0.05)}`);
console.log(`  Moonshot kept:    ${moonshotKept.toFixed(0)}%   (need ≥ 80%)     ${pass(moonshotKept >= 80)}`);

const overallPass = catDrop >= 3 && pfBaseDelta >= -0.05 && moonshotKept >= 80;
console.log(`\n  ${overallPass ? 'ALL PASS — safe to ship.' : 'FAIL — do NOT deploy.'}`);
if (overallPass) {
  console.log(`\n  Translate to strategy fields:`);
  console.log(`    max_trending_volume_5m_usd: ${MAX_VOL5M}`);
  console.log(`    min_mcap_usd: ${MIN_ENTRY_MCAP}     (currently 5000 on degen, raise to ${MIN_ENTRY_MCAP})`);
  console.log(`    max_price_change_5m_pct: ${MAX_PCHG5}`);
  console.log(`    min_price_change_5m_pct: ${MIN_PCHG5}`);
}

function pass(b) { return b ? '✓' : '✗'; }
function baseFmt(n) { return (n >= 0 ? '+' : '') + n.toFixed(2); }
