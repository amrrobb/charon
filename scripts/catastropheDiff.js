#!/usr/bin/env node
// Find entry-time signals that separate catastrophic losses (≤-25%, i.e.
// trades where SL/PANIC/LIQ_DRAIN didn't save us — rugs that gapped past
// the stop in a single snapshot tick) from normal outcomes.
//
// Different goal from winnerLoserDiff: don't try to predict winners.
// Just predict the trades that nuke. Even a weak predictor here pays
// — eliminating a -80% rug is worth more than catching a +30% winner.

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 1392);
const CATASTROPHE_THRESHOLD = Number(process.argv[4] || -25);

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT id, symbol, pnl_percent, exit_reason, snapshot_json, entry_mcap
  FROM dry_run_positions
  WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ? AND strategy_id IN ('degen', 'degen_filtered_v1')
`).all(FROM, TO);

function feat(snap, entryMcap) {
  const c = snap.candidate || {};
  // Prefer the new flat block if present (post-deploy candidates).
  const e = c.entrySignals || {};
  const t = c.trending || {};
  const s5 = t.stats5m || {};
  const holders = c.holders?.holders || [];
  return {
    entryMcap: Number(entryMcap),
    liquidity: Number(e.liquidityUsd ?? c.metrics?.liquidityUsd ?? t.liquidity ?? c.jupiterAsset?.liquidity ?? NaN),
    holderCount: Number(e.holderCount ?? c.holders?.count ?? c.metrics?.holderCount ?? NaN),
    top1: Number(e.top1HolderPct ?? holders[0]?.percent ?? NaN),
    top10: Number(e.top10HolderPct ?? holders.slice(0, 10).reduce((a, h) => a + (h.percent || 0), 0)) || NaN,
    top20: Number(e.top20HolderPct ?? c.holders?.top20Percent ?? NaN),
    vol5m: Number(e.vol5mUsd ?? t.volume5m ?? NaN),
    vol24h: Number(e.vol24hUsd ?? t.volume24h ?? NaN),
    holderChange5m: Number(e.holderChange5mPct ?? s5.holderChange ?? NaN),
    liquidityChange5m: Number(e.liquidityChange5mPct ?? s5.liquidityChange ?? NaN),
    priceChange5m: Number(e.priceChange5mPct ?? s5.priceChange ?? t.change5m ?? NaN),
    organicScore: Number(e.organicScore ?? t.organicScore ?? NaN),
    gradAgeMs: Number(e.gradAgeMs ?? NaN),
    mcapToLiqRatio: NaN, // computed below
    buySellRatio: Number(e.buySellRatio ?? NaN),
    route: e.route || c.signals?.route || 'unknown',
  };
}

const cat = [];   // catastrophic losses
const norm = [];  // everything else
for (const r of rows) {
  let snap = {};
  try { snap = JSON.parse(r.snapshot_json); } catch {}
  const f = feat(snap, r.entry_mcap);
  if (Number.isFinite(f.entryMcap) && Number.isFinite(f.liquidity) && f.liquidity > 0) {
    f.mcapToLiqRatio = f.entryMcap / f.liquidity;
  }
  const bucket = Number(r.pnl_percent) <= CATASTROPHE_THRESHOLD ? cat : norm;
  bucket.push(f);
}

function quartiles(arr) {
  const x = arr.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!x.length) return null;
  return {
    n: x.length,
    p25: x[Math.floor(x.length * 0.25)],
    median: x[Math.floor(x.length * 0.5)],
    p75: x[Math.floor(x.length * 0.75)],
    mean: x.reduce((a, b) => a + b, 0) / x.length,
  };
}

function fmt(n) { return n == null ? 'n/a' : Number(n).toFixed(2); }

console.log(`Range id ${FROM}-${TO} (strategy IN degen, degen_filtered_v1)`);
console.log(`Catastrophe threshold: pnl ≤ ${CATASTROPHE_THRESHOLD}%`);
console.log(`Cohort:  catastrophic ${cat.length}  |  normal ${norm.length}  |  rate ${(cat.length / (cat.length + norm.length) * 100).toFixed(1)}%\n`);

const features = ['entryMcap','liquidity','holderCount','top1','top10','top20','vol5m','vol24h','holderChange5m','liquidityChange5m','priceChange5m','organicScore','gradAgeMs','mcapToLiqRatio','buySellRatio'];
console.log('Feature              | cat n  median (p25..p75)            | norm n  median (p25..p75)         | Δ median');
console.log('-'.repeat(120));
for (const f of features) {
  const cv = cat.map(x => x[f]);
  const nv = norm.map(x => x[f]);
  const cq = quartiles(cv);
  const nq = quartiles(nv);
  if (!cq || !nq) { console.log(`${f.padEnd(20)} | insufficient data`); continue; }
  const delta = nq.median !== 0 ? ((cq.median - nq.median) / Math.abs(nq.median) * 100) : NaN;
  const flag = Math.abs(delta) >= 20 ? ' <- SIGNAL' : '';
  console.log(`${f.padEnd(20)} | ${String(cq.n).padStart(3)}  ${fmt(cq.median).padStart(12)} (${fmt(cq.p25).padStart(10)}..${fmt(cq.p75).padStart(10)})  | ${String(nq.n).padStart(3)}  ${fmt(nq.median).padStart(12)} (${fmt(nq.p25).padStart(10)}..${fmt(nq.p75).padStart(10)}) | ${Number.isFinite(delta) ? delta.toFixed(1) + '%' : 'n/a'}${flag}`);
}

// Route breakdown
const routeCount = (arr, key) => arr.reduce((m, x) => (m[x.route] = (m[x.route] || 0) + 1, m), {});
const cByRoute = routeCount(cat);
const nByRoute = routeCount(norm);
console.log('\nCatastrophe rate by route:');
const allRoutes = new Set([...Object.keys(cByRoute), ...Object.keys(nByRoute)]);
for (const r of allRoutes) {
  const c = cByRoute[r] || 0, n = nByRoute[r] || 0;
  const rate = (c + n) > 0 ? (c / (c + n) * 100).toFixed(1) : '0';
  console.log(`  ${r.padEnd(30)} cat=${String(c).padStart(3)} norm=${String(n).padStart(4)} rate=${rate}%`);
}
