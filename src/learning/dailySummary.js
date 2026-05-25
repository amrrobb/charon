import { db } from '../db/connection.js';
import { now, safeJson } from '../utils.js';
import { sendTelegram } from '../telegram/send.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildDailySummary(windowMs = DAY_MS) {
  const cutoff = now() - windowMs;

  // Per-strategy closed-trade metrics
  const closed = db.prepare(`
    SELECT strategy_id, pnl_percent
    FROM dry_run_positions
    WHERE status = 'closed' AND COALESCE(execution_mode,'dry_run') = 'dry_run'
      AND closed_at_ms >= ?
  `).all(cutoff);

  const byStrategy = new Map();
  for (const row of closed) {
    const key = row.strategy_id || 'unknown';
    const bucket = byStrategy.get(key) || { strategy: key, wins: [], losses: [] };
    const pnl = Number(row.pnl_percent || 0);
    if (pnl > 0) bucket.wins.push(pnl); else bucket.losses.push(pnl);
    byStrategy.set(key, bucket);
  }

  const opened = db.prepare(`
    SELECT strategy_id, COUNT(*) AS c
    FROM dry_run_positions
    WHERE opened_at_ms >= ? AND COALESCE(execution_mode,'dry_run') = 'dry_run'
    GROUP BY strategy_id
  `).all(cutoff);
  const openedBy = Object.fromEntries(opened.map(r => [r.strategy_id || 'unknown', r.c]));

  const strategies = [...byStrategy.values()].map(b => {
    const n = b.wins.length + b.losses.length;
    const grossW = b.wins.reduce((a, b) => a + b, 0);
    const grossL = Math.abs(b.losses.reduce((a, b) => a + b, 0));
    const sortedW = [...b.wins].sort((a, b) => b - a);
    const grossWnoTop = sortedW.slice(1).reduce((a, b) => a + b, 0);
    return {
      strategy: b.strategy,
      opened: openedBy[b.strategy] || 0,
      closed: n,
      wins: b.wins.length,
      losses: b.losses.length,
      wr: n ? (b.wins.length / n) * 100 : 0,
      pf: grossL > 0 ? grossW / grossL : null,
      pfBase: grossL > 0 ? grossWnoTop / grossL : null,
      sumPnl: grossW - grossL,
      avgWin: b.wins.length ? grossW / b.wins.length : 0,
      avgLoss: b.losses.length ? -grossL / b.losses.length : 0,
    };
  }).sort((a, b) => b.closed - a.closed);

  // Filter rejection breakdown across all strategies
  const candidates = db.prepare(`
    SELECT status, filter_result_json
    FROM candidates
    WHERE created_at_ms >= ?
  `).all(cutoff);

  const rejectionReasons = {};
  let passed = 0, filtered = 0;
  for (const c of candidates) {
    if (c.status === 'candidate') { passed += 1; continue; }
    if (c.status === 'filtered') {
      filtered += 1;
      const fr = safeJson(c.filter_result_json, {});
      const first = (fr.failures || [])[0] || 'unknown';
      const key = first.split(':')[0];
      rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
    }
  }

  return { windowMs, strategies, passed, filtered, rejectionReasons };
}

function fmtPct(n, d = 1) { return n == null ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`; }
function fmtPf(n) { return n == null ? 'n/a' : `${n.toFixed(2)}x`; }

export function formatDailySummary(summary) {
  const lines = ['📊 <b>Daily Summary (24h)</b>', ''];
  if (!summary.strategies.length) {
    lines.push('<i>No closed positions in window.</i>');
  } else {
    for (const s of summary.strategies) {
      lines.push(`<b>${s.strategy}</b>`);
      lines.push(`  opened: ${s.opened}  closed: ${s.closed}  W/L: ${s.wins}/${s.losses}  WR: ${s.wr.toFixed(1)}%`);
      lines.push(`  PF: ${fmtPf(s.pf)}  PF base: ${fmtPf(s.pfBase)}  sum: ${fmtPct(s.sumPnl, 0)}`);
      lines.push(`  avgWin: ${fmtPct(s.avgWin)}  avgLoss: ${fmtPct(s.avgLoss)}`);
      lines.push('');
    }
  }
  const total = summary.passed + summary.filtered;
  if (total > 0) {
    const rejectRate = (summary.filtered / total * 100).toFixed(0);
    lines.push(`<b>Candidates</b>: ${summary.passed} passed, ${summary.filtered} filtered (${rejectRate}% rejected)`);
    const top = Object.entries(summary.rejectionReasons).sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [reason, count] of top) {
      lines.push(`  • ${reason}: ${count}`);
    }
  }
  return lines.join('\n');
}

let lastSentMs = 0;
const COOLDOWN_MS = 23 * 60 * 60 * 1000;

export async function sendDailySummaryIfDue() {
  if (now() - lastSentMs < COOLDOWN_MS) return;
  try {
    const summary = buildDailySummary();
    const text = formatDailySummary(summary);
    await sendTelegram(text, { parse_mode: 'HTML' });
    lastSentMs = now();
  } catch (err) {
    console.log(`[daily-summary] failed: ${err.message}`);
  }
}
