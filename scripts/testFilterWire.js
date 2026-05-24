#!/usr/bin/env node
// End-to-end smoke test for the new filter wiring:
//   1. Init a temp DB; verify sniper_filtered_v1 is seeded with the new fields
//   2. Replay every closed B3+B4 dry-run candidate through filterCandidate()
//      with sniper_filtered_v1 active, count pass/fail, and compare against
//      the JS backtester's "Tighter: vol5m<=1000 AND top10<=55" cohort to
//      confirm the in-code filter agrees with the simulator.
//
// Read-only against ./charon_slim.sqlite; mutates ./tmp_filter_test.sqlite only.

import fs from 'fs';
import Database from 'better-sqlite3';

const SOURCE = process.env.DB_PATH || './charon_slim.sqlite';
const TMP = './tmp_filter_test.sqlite';
fs.rmSync(TMP, { force: true });

process.env.DB_PATH = TMP;
const { initDb, db } = await import('../src/db/connection.js');
initDb();

const strat = db.prepare("SELECT id, name, enabled, config_json FROM strategies WHERE id='degen_filtered_v1'").get();
if (!strat) { console.error('FAIL: degen_filtered_v1 not seeded'); process.exit(1); }
const cfg = JSON.parse(strat.config_json);
const expect = { max_top10_holder_percent: 55, max_trending_volume_5m_usd: 1000, mint_cooldown_ms: 3600000 };
for (const [k, v] of Object.entries(expect)) {
  if (cfg[k] !== v) { console.error(`FAIL: ${k}=${cfg[k]} (expected ${v})`); process.exit(1); }
}
console.log(`[ok] degen_filtered_v1 seeded with top10=${cfg.max_top10_holder_percent}, vol5m=${cfg.max_trending_volume_5m_usd}`);

// Enable degen_filtered_v1 as the active strategy (disables others)
db.prepare("UPDATE strategies SET enabled = 0").run();
db.prepare("UPDATE strategies SET enabled = 1 WHERE id='degen_filtered_v1'").run();

const { filterCandidate } = await import('../src/pipeline/candidateBuilder.js');

const src = new Database(SOURCE, { readonly: true });
const rows = src.prepare("SELECT id, pnl_percent, snapshot_json FROM dry_run_positions WHERE id BETWEEN 245 AND 404 AND status='closed'").all();
src.close();

let kept = 0, dropped = 0;
const reasons = {};
const keptRows = [];
for (const r of rows) {
  let snap = {};
  try { snap = JSON.parse(r.snapshot_json); } catch {}
  const c = snap.candidate;
  if (!c) { dropped++; reasons['no_candidate'] = (reasons['no_candidate'] || 0) + 1; continue; }
  // Filter relies on fields that may not all be present in historical snapshots;
  // fill the shape defensively so the call doesn't crash on null.
  const candidate = {
    metrics: c.metrics || {},
    holders: c.holders || {},
    savedWalletExposure: c.savedWalletExposure || { holderCount: 0 },
    feeClaim: c.feeClaim ?? null,
    gmgn: c.gmgn ?? null,
    graduation: c.graduation ?? null,
    trending: c.trending ?? null,
    chart: c.chart ?? null,
  };
  // top10Percent was added after these snapshots were captured; reconstruct from holders array.
  if (candidate.holders.holders && candidate.holders.top10Percent == null) {
    candidate.holders.top10Percent = candidate.holders.holders.slice(0, 10).reduce((a, h) => a + (h.percent || 0), 0);
  }
  const result = filterCandidate(candidate);
  if (result.passed) {
    kept++;
    keptRows.push({ id: r.id, pnl: Number(r.pnl_percent) });
  } else {
    dropped++;
    for (const f of result.failures) {
      const key = f.split(':')[0];
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
}

const w = keptRows.filter(r => r.pnl > 0);
const l = keptRows.filter(r => r.pnl < 0);
const grossW = w.reduce((a, b) => a + b.pnl, 0);
const grossL = Math.abs(l.reduce((a, b) => a + b.pnl, 0));
const sortedW = [...w].sort((a, b) => b.pnl - a.pnl);
const grossWnoTop = sortedW.slice(1).reduce((a, b) => a + b.pnl, 0);

console.log(`\nReplayed ${rows.length} positions through filterCandidate() with degen_filtered_v1`);
console.log(`  kept:    ${kept}`);
console.log(`  dropped: ${dropped}`);
console.log(`  drop reasons:`, reasons);
console.log(`\nCohort metrics for kept positions:`);
console.log(`  W/L:      ${w.length}/${l.length}  WR=${(w.length / kept * 100).toFixed(1)}%`);
console.log(`  PF:       ${(grossW / grossL).toFixed(2)}x`);
console.log(`  PF base:  ${(grossWnoTop / grossL).toFixed(2)}x`);
console.log(`  Sum PnL:  ${(grossW - grossL).toFixed(0)}%`);

fs.rmSync(TMP, { force: true });
console.log('\n[ok] cleanup done');
