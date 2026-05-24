#!/usr/bin/env node
// Find what separates winners from losers in the snapshot data.
// Read-only. Surfaces medians + quartiles of entry-time signals for both
// cohorts so we can build a better entry filter (not a better exit ladder).

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 404);

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * p)];
}
function fmt(n, d = 2) { return n == null ? 'n/a' : Number(n).toFixed(d); }

function summarize(label, arr) {
  return {
    label,
    n: arr.length,
    p25: pct(arr, 0.25),
    median: pct(arr, 0.5),
    p75: pct(arr, 0.75),
    mean: arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null,
  };
}

const db = new Database(DB_PATH, { readonly: true });
const positions = db.prepare(`
  SELECT id, symbol, entry_mcap, pnl_percent, exit_reason, strategy_id, snapshot_json
  FROM dry_run_positions
  WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ?
`).all(FROM, TO);

const features = {
  entry_mcap: { win: [], loss: [] },
  age_ms:     { win: [], loss: [] },
  source_count: { win: [], loss: [] },
  holders:    { win: [], loss: [] },
  top20_pct:  { win: [], loss: [] },
  fee_claim_sol: { win: [], loss: [] },
  llm_confidence: { win: [], loss: [] },
};
const exitCounts = { win: {}, loss: {} };
const routes = { win: {}, loss: {} };

for (const p of positions) {
  const bucket = Number(p.pnl_percent) > 0 ? 'win' : 'loss';
  let snap = {};
  try { snap = JSON.parse(p.snapshot_json || '{}'); } catch {}
  const c = snap.candidate || {};
  if (p.entry_mcap) features.entry_mcap[bucket].push(Number(p.entry_mcap));
  if (c.token?.ageMs) features.age_ms[bucket].push(Number(c.token.ageMs));
  if (c.signals?.sourceCount) features.source_count[bucket].push(Number(c.signals.sourceCount));
  if (c.holders?.total) features.holders[bucket].push(Number(c.holders.total));
  if (c.holders?.top20Percent) features.top20_pct[bucket].push(Number(c.holders.top20Percent));
  if (c.feeClaim?.totalSol) features.fee_claim_sol[bucket].push(Number(c.feeClaim.totalSol));
  if (snap.llm?.confidence) features.llm_confidence[bucket].push(Number(snap.llm.confidence));
  const route = c.signals?.route || c.signals?.label || 'unknown';
  routes[bucket][route] = (routes[bucket][route] || 0) + 1;
  exitCounts[bucket][p.exit_reason || 'unknown'] = (exitCounts[bucket][p.exit_reason || 'unknown'] || 0) + 1;
}

const totalWin = positions.filter(p => Number(p.pnl_percent) > 0).length;
const totalLoss = positions.filter(p => Number(p.pnl_percent) <= 0).length;
console.log(`Range id ${FROM}-${TO}: ${positions.length} closed, ${totalWin} wins, ${totalLoss} losses\n`);

console.log('Feature              | Win n  median (p25..p75)    | Loss n  median (p25..p75)   | Diff');
console.log('-'.repeat(110));
for (const [name, buckets] of Object.entries(features)) {
  const w = summarize('win', buckets.win);
  const l = summarize('loss', buckets.loss);
  const diff = (w.median != null && l.median != null) ? ((w.median - l.median) / Math.abs(l.median || 1) * 100).toFixed(1) + '%' : 'n/a';
  console.log(`${name.padEnd(20)} | ${String(w.n).padStart(3)}  ${String(fmt(w.median)).padStart(10)} (${fmt(w.p25)}..${fmt(w.p75)})`.padEnd(60) +
              ` | ${String(l.n).padStart(3)}  ${String(fmt(l.median)).padStart(10)} (${fmt(l.p25)}..${fmt(l.p75)})`.padEnd(40) +
              ` | ${diff}`);
}

console.log('\nExit reasons:');
console.log('  Wins:  ', exitCounts.win);
console.log('  Losses:', exitCounts.loss);

console.log('\nRoutes:');
console.log('  Wins:  ', routes.win);
console.log('  Losses:', routes.loss);
