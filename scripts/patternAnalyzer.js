#!/usr/bin/env node
// Pattern analyzer — Meridian-style bucketing per the dikibagast article.
//
// For each feature: bucket the trades, compute avg PnL/WR/catastrophe rate
// per bucket, AND cross-validate by splitting train/test chronologically.
// A pattern is real ONLY if it shows the same tendency on BOTH halves.
//
// Goal: find buckets with consistent + generalizable + actionable behavior.
//   - "Consistent": same direction (loss/win) in TRAIN and TEST
//   - "Generalizable": has a thesis a human can defend
//   - "Actionable": opportunity cost is small (kept enough trades) or
//     loss avoidance is large
//
// No threshold optimization. No best-of-N. Read the patterns and decide.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 9999999);
const TRAIN_FRAC = 0.7;
const CATASTROPHE = -25;

function extractFeatures(snap, entryMcap) {
  const c = snap.candidate || {};
  const e = c.entrySignals || {};
  const t = c.trending || {};
  const s5 = t.stats5m || {};
  const holders = c.holders?.holders || [];
  return {
    entryMcap: Number(entryMcap),
    liquidity: Number(e.liquidityUsd ?? c.metrics?.liquidityUsd ?? t.liquidity ?? NaN),
    holderCount: Number(e.holderCount ?? c.holders?.count ?? NaN),
    top1: Number(e.top1HolderPct ?? holders[0]?.percent ?? NaN),
    top10: Number(e.top10HolderPct ?? holders.slice(0, 10).reduce((a, h) => a + (h.percent || 0), 0)) || NaN,
    vol5m: Number(e.vol5mUsd ?? t.volume5m ?? NaN),
    vol24h: Number(e.vol24hUsd ?? t.volume24h ?? NaN),
    priceChange5m: Number(e.priceChange5mPct ?? s5.priceChange ?? t.change5m ?? NaN),
    holderChange5m: Number(e.holderChange5mPct ?? s5.holderChange ?? NaN),
    liquidityChange5m: Number(e.liquidityChange5mPct ?? s5.liquidityChange ?? NaN),
    organicScore: Number(e.organicScore ?? t.organicScore ?? NaN),
    route: e.route || c.signals?.route || 'unknown',
  };
}

// Bucket definitions — chosen for thesis-clarity, not optimization.
const BUCKETS = {
  priceChange5m: [
    ['<-10%',  v => v < -10],
    ['-10..0%', v => v >= -10 && v < 0],
    ['0..+10%', v => v >= 0 && v < 10],
    ['+10..+30%', v => v >= 10 && v < 30],
    ['>+30%', v => v >= 30],
  ],
  holderChange5m: [
    ['<-5%',  v => v < -5],
    ['-5..0%', v => v >= -5 && v < 0],
    ['0..+5%', v => v >= 0 && v < 5],
    ['>+5%', v => v >= 5],
  ],
  vol5mUSD: [
    ['<500',     v => v < 500],
    ['500-1500', v => v >= 500 && v < 1500],
    ['1500-3000', v => v >= 1500 && v < 3000],
    ['3000-6000', v => v >= 3000 && v < 6000],
    ['>6000',    v => v >= 6000],
  ],
  organicScore: [
    ['0-20',  v => v >= 0 && v < 20],
    ['20-40', v => v >= 20 && v < 40],
    ['40-60', v => v >= 40 && v < 60],
    ['60-80', v => v >= 60 && v < 80],
    ['80-100', v => v >= 80],
  ],
  top1: [
    ['<20%',  v => v < 20],
    ['20-30%', v => v >= 20 && v < 30],
    ['30-40%', v => v >= 30 && v < 40],
    ['40-50%', v => v >= 40 && v < 50],
    ['>50%',  v => v >= 50],
  ],
  entryMcap: [
    ['<10K',  v => v < 10000],
    ['10-20K', v => v >= 10000 && v < 20000],
    ['20-40K', v => v >= 20000 && v < 40000],
    ['40-80K', v => v >= 40000 && v < 80000],
    ['>80K',  v => v >= 80000],
  ],
};

function bucketStats(items, featureKey, bucketDefs) {
  const rows = [];
  for (const [label, pred] of bucketDefs) {
    const inBucket = items.filter(x => Number.isFinite(x.feat[featureKey]) && pred(x.feat[featureKey]));
    if (inBucket.length === 0) { rows.push({ label, n: 0 }); continue; }
    const pnls = inBucket.map(x => x.pnl);
    const wins = pnls.filter(x => x > 0);
    const cats = pnls.filter(x => x <= CATASTROPHE);
    rows.push({
      label, n: inBucket.length,
      wr: (wins.length / inBucket.length) * 100,
      avgPnl: pnls.reduce((a, b) => a + b, 0) / inBucket.length,
      catRate: (cats.length / inBucket.length) * 100,
      median: pnls.sort((a, b) => a - b)[Math.floor(pnls.length / 2)],
    });
  }
  return rows;
}

function fmt(n, d = 1) { return n == null ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(d); }

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
  return { id: r.id, pnl: Number(r.pnl_percent), feat: extractFeatures(snap, r.entry_mcap) };
});

const trainCount = Math.floor(items.length * TRAIN_FRAC);
const train = items.slice(0, trainCount);
const test = items.slice(trainCount);

console.log(`Pool: ${items.length} trades`);
console.log(`Split: TRAIN n=${train.length}, TEST n=${test.length}`);
console.log(`Catastrophe = pnl ≤ ${CATASTROPHE}%\n`);

const FEATURES = [
  ['priceChange5m', 'priceChange5m'],
  ['holderChange5m', 'holderChange5m'],
  ['vol5m', 'vol5mUSD'],
  ['organicScore', 'organicScore'],
  ['top1', 'top1'],
  ['entryMcap', 'entryMcap'],
];

for (const [featKey, bucketKey] of FEATURES) {
  const tBuckets = bucketStats(train, featKey, BUCKETS[bucketKey]);
  const vBuckets = bucketStats(test,  featKey, BUCKETS[bucketKey]);
  console.log(`\n=== ${featKey} ===`);
  console.log('bucket'.padEnd(13) + ' | TRAIN: n   WR   avgPnL  catRate   |  TEST: n   WR   avgPnL  catRate  |  CONSISTENT?');
  console.log('-'.repeat(115));
  for (let i = 0; i < tBuckets.length; i++) {
    const t = tBuckets[i], v = vBuckets[i];
    const trainCell = t.n === 0 ? '            n/a              ' :
      `n=${String(t.n).padStart(3)}  WR=${t.wr.toFixed(0).padStart(3)}%  ${fmt(t.avgPnl).padStart(7)}%  cat=${t.catRate.toFixed(0).padStart(3)}%`;
    const testCell = v.n === 0 ? '            n/a              ' :
      `n=${String(v.n).padStart(3)}  WR=${v.wr.toFixed(0).padStart(3)}%  ${fmt(v.avgPnl).padStart(7)}%  cat=${v.catRate.toFixed(0).padStart(3)}%`;
    // Consistency: both buckets non-empty, same sign of avgPnl, both catRates within 5pp
    let consistent = '';
    if (t.n >= 10 && v.n >= 10) {
      const sameSign = (t.avgPnl >= 0) === (v.avgPnl >= 0);
      const catGap = Math.abs(t.catRate - v.catRate);
      if (sameSign && catGap < 5) consistent = '  ✓ CONSISTENT';
      else if (sameSign) consistent = '  ~ direction agrees';
      else consistent = '  ✗ flips';
    }
    console.log(t.label.padEnd(13) + ' | ' + trainCell + '  |  ' + testCell + '  |' + consistent);
  }
}

// Route-level
console.log(`\n=== route ===`);
console.log('route'.padEnd(28) + ' | TRAIN: n   WR   avgPnL  catRate   |  TEST: n   WR   avgPnL  catRate');
console.log('-'.repeat(115));
const routes = [...new Set(items.map(x => x.feat.route))];
for (const r of routes) {
  const tIn = train.filter(x => x.feat.route === r);
  const vIn = test.filter(x => x.feat.route === r);
  function s(arr) {
    if (!arr.length) return null;
    const pnls = arr.map(x => x.pnl);
    const w = pnls.filter(x => x > 0).length;
    const c = pnls.filter(x => x <= CATASTROPHE).length;
    return { n: arr.length, wr: w / arr.length * 100, avg: pnls.reduce((a, b) => a + b, 0) / arr.length, cat: c / arr.length * 100 };
  }
  const t = s(tIn), v = s(vIn);
  const tc = t ? `n=${String(t.n).padStart(3)}  WR=${t.wr.toFixed(0).padStart(3)}%  ${fmt(t.avg).padStart(7)}%  cat=${t.cat.toFixed(0).padStart(3)}%` : '            n/a              ';
  const vc = v ? `n=${String(v.n).padStart(3)}  WR=${v.wr.toFixed(0).padStart(3)}%  ${fmt(v.avg).padStart(7)}%  cat=${v.cat.toFixed(0).padStart(3)}%` : '            n/a              ';
  console.log(r.padEnd(28) + ' | ' + tc + '  |  ' + vc);
}
