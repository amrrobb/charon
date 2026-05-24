#!/usr/bin/env node
// Tranche backtest. Read-only. Replays closed dry_run_positions through
// the proposed "de-risk-then-runner" ladder using position_snapshots as
// the price tape, and reports PF / PF-base / win-rate vs actual.
//
// Usage:
//   DB_PATH=/path/to/charon.sqlite node scripts/backtestTranche.js [--from-id N] [--to-id N]
//                                                                 [--ladder 25,60,150,400]
//                                                                 [--sells 35,35,20,10]
//                                                                 [--trail-after-tier 1]
//                                                                 [--trail-pct 35]
//                                                                 [--sl-pct -25]
//                                                                 [--csv out.csv]
//
// Notes:
//   - Operates only on positions with status='closed' AND execution_mode='dry_run'.
//   - Skips positions with <2 snapshots (no tape to replay).
//   - Sell sizes are % of REMAINING position (matches positions.js:198).
//   - "Original" outcome uses the stored pnl_percent (whatever exit fired).

import Database from 'better-sqlite3';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';

function parseArgs(argv) {
  const args = { ladder: [25, 60, 150, 400], sells: [35, 35, 20, 10],
    trailAfterTier: 1, trailPct: 35, slPct: -25, fromId: null, toId: null, csv: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--from-id') { args.fromId = Number(v); i++; }
    else if (k === '--to-id') { args.toId = Number(v); i++; }
    else if (k === '--ladder') { args.ladder = v.split(',').map(Number); i++; }
    else if (k === '--sells') { args.sells = v.split(',').map(Number); i++; }
    else if (k === '--trail-after-tier') { args.trailAfterTier = Number(v); i++; }
    else if (k === '--trail-pct') { args.trailPct = Number(v); i++; }
    else if (k === '--sl-pct') { args.slPct = Number(v); i++; }
    else if (k === '--csv') { args.csv = v; i++; }
  }
  return args;
}

function simulate(snapshots, cfg) {
  // snapshots: ordered ascending by at_ms, each { unrealized_pnl_percent, ... }
  // Returns simulated pnl_percent on ORIGINAL size.
  let remaining = 100;                     // % of original size still held
  let bankedPnlPct = 0;                    // cumulative realized pnl as % of ORIGINAL
  let tier = 0;
  let trailingArmed = false;
  let peakPnl = -Infinity;

  for (const snap of snapshots) {
    const pnl = Number(snap.unrealized_pnl_percent);
    if (!Number.isFinite(pnl)) continue;
    peakPnl = Math.max(peakPnl, pnl);

    // Walk ladder
    while (tier < cfg.ladder.length && pnl >= cfg.ladder[tier]) {
      const sellPctOfRemaining = cfg.sells[tier] ?? cfg.sells[cfg.sells.length - 1] ?? 0;
      const sellSizeOfOriginal = remaining * (sellPctOfRemaining / 100);
      // Realized pnl on the slice exits at current pnl level.
      bankedPnlPct += sellSizeOfOriginal * (pnl / 100);
      remaining -= sellSizeOfOriginal;
      tier += 1;
      if (tier >= cfg.trailAfterTier) trailingArmed = true;
    }

    if (remaining <= 0.0001) {
      return { simPnlPct: bankedPnlPct, exitReason: 'LADDER_FULL', tier, peakPnl };
    }

    // SL on residual (uses absolute SL relative to entry).
    if (pnl <= cfg.slPct) {
      bankedPnlPct += remaining * (pnl / 100);
      return { simPnlPct: bankedPnlPct, exitReason: 'SL', tier, peakPnl };
    }

    // Trailing stop on residual once armed.
    if (trailingArmed) {
      const drop = pnl - peakPnl;
      if (drop <= -Math.abs(cfg.trailPct)) {
        bankedPnlPct += remaining * (pnl / 100);
        return { simPnlPct: bankedPnlPct, exitReason: 'TRAIL', tier, peakPnl };
      }
    }
  }

  // Tape exhausted. Mark residual at final tape pnl (mirrors closed-position outcome).
  const finalPnl = Number(snapshots[snapshots.length - 1]?.unrealized_pnl_percent || 0);
  bankedPnlPct += remaining * (finalPnl / 100);
  return { simPnlPct: bankedPnlPct, exitReason: 'TAPE_END', tier, peakPnl };
}

function aggregate(rows) {
  const closed = rows.filter(r => Number.isFinite(r.actualPnl) && Number.isFinite(r.simPnl));
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const stats = (label, arr) => {
    const wins = arr.filter(r => r[label] > 0);
    const losses = arr.filter(r => r[label] < 0);
    const grossWin = sum(wins.map(r => r[label]));
    const grossLoss = Math.abs(sum(losses.map(r => r[label])));
    const winRate = arr.length ? (wins.length / arr.length) * 100 : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? -grossLoss / losses.length : 0;
    const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
    // Drop top-1 outlier on the gross-win side
    const sortedWinsDesc = [...wins].sort((a, b) => b[label] - a[label]);
    const baseWinSum = sortedWinsDesc.slice(1).reduce((s, r) => s + r[label], 0);
    const pfBase = grossLoss > 0 ? baseWinSum / grossLoss : Infinity;
    return { n: arr.length, wins: wins.length, losses: losses.length, winRate, avgWin, avgLoss, pf, pfBase, grossWin, grossLoss };
  };
  return { actual: stats('actualPnl', closed), simulated: stats('simPnl', closed), n: closed.length };
}

function fmtPct(n) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function fmt(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Set DB_PATH=...`);
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });

  const where = ["status = 'closed'", "COALESCE(execution_mode, 'dry_run') = 'dry_run'"];
  const params = [];
  if (args.fromId != null) { where.push('id >= ?'); params.push(args.fromId); }
  if (args.toId != null)   { where.push('id <= ?'); params.push(args.toId); }
  const positions = db.prepare(`
    SELECT id, mint, symbol, opened_at_ms, closed_at_ms, entry_mcap, pnl_percent, exit_reason
    FROM dry_run_positions
    WHERE ${where.join(' AND ')}
    ORDER BY id ASC
  `).all(...params);

  const snapStmt = db.prepare(`
    SELECT at_ms, unrealized_pnl_percent, mcap, high_water_mcap
    FROM position_snapshots
    WHERE position_id = ?
    ORDER BY at_ms ASC
  `);

  const rows = [];
  for (const pos of positions) {
    const snaps = snapStmt.all(pos.id);
    if (snaps.length < 2) {
      rows.push({ id: pos.id, symbol: pos.symbol, actualPnl: Number(pos.pnl_percent),
        simPnl: null, exitReason: pos.exit_reason, simExit: 'NO_TAPE', tier: 0, peakPnl: null, snaps: snaps.length });
      continue;
    }
    const sim = simulate(snaps, args);
    rows.push({
      id: pos.id, symbol: pos.symbol,
      actualPnl: Number(pos.pnl_percent),
      simPnl: sim.simPnlPct,
      exitReason: pos.exit_reason,
      simExit: sim.exitReason,
      tier: sim.tier,
      peakPnl: sim.peakPnl,
      snaps: snaps.length,
    });
  }

  const agg = aggregate(rows);

  console.log(`\n=== Backtest: ${rows.length} closed dry_run positions, ${agg.n} replayable ===`);
  console.log(`DB:     ${DB_PATH}`);
  console.log(`Ladder: ${args.ladder.join(',')}  Sells: ${args.sells.join(',')}  (% of remaining)`);
  console.log(`Trail:  arm after tier ${args.trailAfterTier}, drop -${args.trailPct}%  SL: ${args.slPct}%\n`);

  const header = ['Metric', 'Actual', 'Simulated'];
  const fmtRow = (label, a, s, suffix = '') =>
    `${label.padEnd(18)} ${String(a).padStart(14)} ${String(s).padStart(14)} ${suffix}`;
  console.log(header.map((h, i) => i === 0 ? h.padEnd(18) : h.padStart(14)).join(' '));
  console.log('-'.repeat(50));
  console.log(fmtRow('Trades',       agg.actual.n,                       agg.simulated.n));
  console.log(fmtRow('Wins',         agg.actual.wins,                    agg.simulated.wins));
  console.log(fmtRow('Losses',       agg.actual.losses,                  agg.simulated.losses));
  console.log(fmtRow('Win Rate',     fmt(agg.actual.winRate, 1) + '%',   fmt(agg.simulated.winRate, 1) + '%'));
  console.log(fmtRow('Avg Win',      fmtPct(agg.actual.avgWin),          fmtPct(agg.simulated.avgWin)));
  console.log(fmtRow('Avg Loss',     fmtPct(agg.actual.avgLoss),         fmtPct(agg.simulated.avgLoss)));
  console.log(fmtRow('Gross Win',    fmtPct(agg.actual.grossWin),        fmtPct(agg.simulated.grossWin)));
  console.log(fmtRow('Gross Loss',   fmtPct(-agg.actual.grossLoss),      fmtPct(-agg.simulated.grossLoss)));
  console.log(fmtRow('PF (w/ outlier)', fmt(agg.actual.pf) + 'x',        fmt(agg.simulated.pf) + 'x'));
  console.log(fmtRow('PF base (-top1)', fmt(agg.actual.pfBase) + 'x',    fmt(agg.simulated.pfBase) + 'x'));

  const totalActual = agg.actual.grossWin - agg.actual.grossLoss;
  const totalSim    = agg.simulated.grossWin - agg.simulated.grossLoss;
  console.log(fmtRow('Sum PnL %',    fmtPct(totalActual),                fmtPct(totalSim)));

  if (args.csv) {
    const lines = ['id,symbol,actual_pnl_pct,sim_pnl_pct,actual_exit,sim_exit,tier_reached,peak_pnl_pct,snapshots'];
    for (const r of rows) {
      lines.push([r.id, r.symbol ?? '', fmt(r.actualPnl), r.simPnl == null ? '' : fmt(r.simPnl),
        r.exitReason ?? '', r.simExit, r.tier, r.peakPnl == null ? '' : fmt(r.peakPnl), r.snaps].join(','));
    }
    fs.writeFileSync(args.csv, lines.join('\n') + '\n');
    console.log(`\nPer-trade CSV written: ${args.csv}`);
  }

  // Outlier sanity check: how dependent is each side on the single biggest winner?
  const closedRows = rows.filter(r => r.simPnl != null);
  const topActual = [...closedRows].sort((a, b) => b.actualPnl - a.actualPnl)[0];
  const topSim    = [...closedRows].sort((a, b) => b.simPnl - a.simPnl)[0];
  if (topActual) console.log(`\nTop actual outlier: id=${topActual.id} ${topActual.symbol ?? ''} ${fmtPct(topActual.actualPnl)} (exit=${topActual.exitReason})`);
  if (topSim)    console.log(`Top sim outlier:    id=${topSim.id} ${topSim.symbol ?? ''} ${fmtPct(topSim.simPnl)} (exit=${topSim.simExit})`);
}

main();
