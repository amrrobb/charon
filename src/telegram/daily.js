import { bot } from './bot.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';

// Bucket closed positions by UTC calendar day. Aggregates: pnl% sum, trade
// count, win count. Wins use realized pnl_percent > 0.
function aggregateByDay(daysBack = 14) {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', closed_at_ms / 1000, 'unixepoch') AS day,
      COUNT(*) AS trades,
      SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN pnl_percent < 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(pnl_percent), 2) AS pnl_pct_sum,
      ROUND(SUM(pnl_sol), 4) AS pnl_sol,
      ROUND(SUM(size_sol), 4) AS deployed_sol
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms >= ?
    GROUP BY day
    ORDER BY day DESC
  `).all(cutoff);
  return rows;
}

export function dailyText(daysBack = 14) {
  const rows = aggregateByDay(daysBack);
  if (rows.length === 0) {
    return `📅 <b>Daily PnL</b>\n\nNo closed trades in the last ${daysBack} days.`;
  }
  let totalPnlSol = 0;
  let totalTrades = 0;
  let totalWins = 0;
  for (const r of rows) {
    totalPnlSol += Number(r.pnl_sol || 0);
    totalTrades += Number(r.trades || 0);
    totalWins += Number(r.wins || 0);
  }
  const totalWr = totalTrades ? (totalWins / totalTrades * 100).toFixed(1) : '0';

  const header = [
    '📅 <b>Daily PnL — last ' + daysBack + ' days</b>',
    '',
    `<b>Total:</b> ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL · ${totalTrades} trades · ${totalWr}% WR`,
    '',
    '<pre>',
    'Day        | PnL SOL    | Pct% sum  | Trades  | WR',
    '-----------+------------+-----------+---------+------',
  ];
  for (const r of rows) {
    const wr = r.trades ? (r.wins / r.trades * 100).toFixed(0) : '0';
    const pnlSol = Number(r.pnl_sol || 0);
    const pnlSolStr = (pnlSol >= 0 ? '+' : '') + pnlSol.toFixed(4);
    const pctStr = (Number(r.pnl_pct_sum) >= 0 ? '+' : '') + Number(r.pnl_pct_sum).toFixed(0) + '%';
    header.push(
      `${r.day} | ${pnlSolStr.padStart(10)} | ${pctStr.padStart(9)} | ${String(r.trades).padStart(6)}  | ${wr.padStart(3)}%`
    );
  }
  header.push('</pre>');
  header.push('');
  header.push('Use <code>/day YYYY-MM-DD</code> for one day\'s trades.');
  return header.join('\n');
}

export function dayDetailText(dayStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
    return 'Usage: <code>/day 2026-05-17</code>';
  }
  const rows = db.prepare(`
    SELECT id, symbol, mint, pnl_percent, pnl_sol, exit_reason, entry_mcap, exit_mcap,
      opened_at_ms, closed_at_ms, strategy_id,
      json_extract(snapshot_json, '$.candidate.signals.route') AS route
    FROM dry_run_positions
    WHERE status = 'closed'
      AND strftime('%Y-%m-%d', closed_at_ms / 1000, 'unixepoch') = ?
    ORDER BY closed_at_ms ASC
  `).all(dayStr);
  if (rows.length === 0) {
    return `No closed trades on ${escapeHtml(dayStr)}.`;
  }
  let netSol = 0, wins = 0;
  for (const r of rows) {
    netSol += Number(r.pnl_sol || 0);
    if (Number(r.pnl_percent) > 0) wins += 1;
  }
  const wr = (wins / rows.length * 100).toFixed(0);

  const out = [
    `📅 <b>${escapeHtml(dayStr)}</b>`,
    `${netSol >= 0 ? '+' : ''}${netSol.toFixed(4)} SOL · ${rows.length} trades · ${wr}% WR · ${wins}W/${rows.length - wins}L`,
    '',
  ];
  // Telegram message limit ~4096 chars; cap at 30 rows for safety.
  const LIMIT = 30;
  const shown = rows.slice(0, LIMIT);
  for (const r of shown) {
    const icon = Number(r.pnl_percent) > 0 ? '✅' : '❌';
    const holdMin = Math.round((r.closed_at_ms - r.opened_at_ms) / 60000);
    const holdStr = holdMin >= 60 ? `${Math.floor(holdMin / 60)}h${holdMin % 60}m` : `${holdMin}m`;
    const pnlPct = Number(r.pnl_percent || 0);
    const pct = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%';
    const route = r.route || '?';
    out.push(
      `${icon} <b>${escapeHtml(r.symbol || short(r.mint))}</b> #${r.id} ${pct}`,
      `<code>${escapeHtml(r.exit_reason || '?')}</code> · ${holdStr} · ${fmtUsd(r.entry_mcap)} → ${fmtUsd(r.exit_mcap)} · <i>${escapeHtml(route)}</i> · ${escapeHtml(r.strategy_id || '?')}`,
      ''
    );
  }
  if (rows.length > LIMIT) {
    out.push(`<i>... ${rows.length - LIMIT} more trades not shown (cap ${LIMIT})</i>`);
  }
  return out.join('\n');
}

export async function sendDaily(chatId, daysBack = 14) {
  return bot.sendMessage(chatId, dailyText(daysBack), { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendDayDetail(chatId, dayStr) {
  return bot.sendMessage(chatId, dayDetailText(dayStr), { parse_mode: 'HTML', disable_web_page_preview: true });
}
