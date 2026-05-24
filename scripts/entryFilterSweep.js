#!/usr/bin/env node
// Sweep hypothetical entry filters over closed positions and report
// the impact on PF / PF-base / WR / sum-PnL%.
//
// Each filter is a predicate over snapshot fields. A position is KEPT
// when the predicate returns true; rejected positions are excluded from
// the cohort entirely (as if the entry never happened).

import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './charon.sqlite';
const FROM = Number(process.argv[2] || 245);
const TO   = Number(process.argv[3] || 404);

function feature(snap) {
  const c = snap.candidate || {};
  const sig = c.signals || {};
  const trend = c.trending || {};
  return {
    route: sig.route || 'unknown',
    hasFee: !!sig.hasFeeClaim,
    hasGrad: !!sig.hasGraduated,
    hasTrend: !!sig.hasTrending,
    vol5m: Number(trend.volume5m ?? trend.v5m ?? NaN),
    buys5m: Number(trend.buys5m ?? trend.buys ?? NaN),
    sells5m: Number(trend.sells5m ?? trend.sells ?? NaN),
    top10: (c.holders?.holders || []).slice(0, 10).reduce((a, h) => a + (h.percent || 0), 0),
    holders: Number(c.holders?.count ?? NaN),
    jupLiq: Number(c.jupiterAsset?.liquidity ?? NaN),
    entryMcap: Number(c.metrics?.mcap ?? c.token?.mcap ?? NaN),
  };
}

function pf(kept) {
  if (!kept.length) return { n: 0 };
  const w = kept.filter(p => p.pnl > 0);
  const l = kept.filter(p => p.pnl < 0);
  const grossW = w.reduce((a, b) => a + b.pnl, 0);
  const grossL = Math.abs(l.reduce((a, b) => a + b.pnl, 0));
  const sortedW = [...w].sort((a, b) => b.pnl - a.pnl);
  const grossWnoTop = sortedW.slice(1).reduce((a, b) => a + b.pnl, 0);
  return {
    n: kept.length,
    wins: w.length,
    losses: l.length,
    wr: kept.length ? (w.length / kept.length) * 100 : 0,
    avgW: w.length ? grossW / w.length : 0,
    avgL: l.length ? -grossL / l.length : 0,
    pf: grossL > 0 ? grossW / grossL : Infinity,
    pfBase: grossL > 0 ? grossWnoTop / grossL : Infinity,
    sumPnl: grossW - grossL,
  };
}

function row(label, s) {
  if (!s.n) return `${label.padEnd(45)} | NO TRADES`;
  return `${label.padEnd(45)} | n=${String(s.n).padStart(3)} W/L=${String(s.wins).padStart(2)}/${String(s.losses).padStart(3)} WR=${s.wr.toFixed(1).padStart(5)}% | aW=${s.avgW.toFixed(1).padStart(6)}% aL=${s.avgL.toFixed(1).padStart(6)}% | PF=${s.pf.toFixed(2)}x base=${s.pfBase.toFixed(2)}x | sum=${s.sumPnl.toFixed(0)}%`;
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT id, pnl_percent, snapshot_json
  FROM dry_run_positions
  WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ?
`).all(FROM, TO);

const positions = rows.map(r => {
  let snap = {};
  try { snap = JSON.parse(r.snapshot_json); } catch {}
  return { id: r.id, pnl: Number(r.pnl_percent), feat: feature(snap) };
});

const filters = [
  ['BASELINE (all)', () => true],
  ['Drop dual_source', f => f.route !== 'dual_source'],
  ['dual_source requires hasFee', f => f.route !== 'dual_source' || f.hasFee],
  ['dual_source requires hasGrad', f => f.route !== 'dual_source' || f.hasGrad],
  ['dual_source requires hasFee OR hasGrad', f => f.route !== 'dual_source' || f.hasFee || f.hasGrad],
  ['vol5m <= 1500 (all)', f => !Number.isFinite(f.vol5m) || f.vol5m <= 1500],
  ['vol5m <= 2000 (dual_source only)', f => f.route !== 'dual_source' || !Number.isFinite(f.vol5m) || f.vol5m <= 2000],
  ['vol5m <= 1500 (dual_source only)', f => f.route !== 'dual_source' || !Number.isFinite(f.vol5m) || f.vol5m <= 1500],
  ['top10 <= 55%', f => !Number.isFinite(f.top10) || f.top10 <= 55],
  ['top10 <= 50%', f => !Number.isFinite(f.top10) || f.top10 <= 50],
  ['holders >= 120', f => !Number.isFinite(f.holders) || f.holders >= 120],
  ['Drop dual_source + vol5m<=1500', f => f.route !== 'dual_source' && (!Number.isFinite(f.vol5m) || f.vol5m <= 1500)],
  ['Keep dual_source ONLY if vol5m<=1500 AND top10<=60', f => f.route !== 'dual_source' || ((!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 60))],
  ['Drop dual_source unless hasFee or hasGrad; + vol5m<=2000', f => {
    if (f.route === 'dual_source' && !f.hasFee && !f.hasGrad) return false;
    if (Number.isFinite(f.vol5m) && f.vol5m > 2000) return false;
    return true;
  }],
  // Refinement sweep around the winner
  ['WINNER: dual_source only if vol5m<=1500 AND top10<=60', f => f.route !== 'dual_source' || ((!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 60))],
  ['Tighter: dual_source vol5m<=1000 AND top10<=55', f => f.route !== 'dual_source' || ((!Number.isFinite(f.vol5m) || f.vol5m <= 1000) && (!Number.isFinite(f.top10) || f.top10 <= 55))],
  ['Tighter: dual_source vol5m<=1500 AND top10<=55', f => f.route !== 'dual_source' || ((!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 55))],
  ['Wider: dual_source vol5m<=2000 AND top10<=65', f => f.route !== 'dual_source' || ((!Number.isFinite(f.vol5m) || f.vol5m <= 2000) && (!Number.isFinite(f.top10) || f.top10 <= 65))],
  ['ALL ROUTES: vol5m<=1500 AND top10<=60', f => (!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 60)],
  ['ALL ROUTES: vol5m<=1500 AND top10<=55', f => (!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 55)],
  ['Winner + drop fee_trending (small n, weak)', f => {
    if (f.route === 'fee_trending') return false;
    if (f.route === 'dual_source') return (!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 60);
    return true;
  }],
  ['Winner + jupLiq >= 5000', f => {
    if (Number.isFinite(f.jupLiq) && f.jupLiq < 5000) return false;
    if (f.route === 'dual_source') return (!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 60);
    return true;
  }],
  ['Winner + entryMcap >= 10000', f => {
    if (Number.isFinite(f.entryMcap) && f.entryMcap < 10000) return false;
    if (f.route === 'dual_source') return (!Number.isFinite(f.vol5m) || f.vol5m <= 1500) && (!Number.isFinite(f.top10) || f.top10 <= 60);
    return true;
  }],
];

console.log(`Range id ${FROM}-${TO}: ${positions.length} closed positions\n`);
console.log('Filter'.padEnd(45) + ' | stats');
console.log('-'.repeat(140));
for (const [label, pred] of filters) {
  const kept = positions.filter(p => pred(p.feat));
  console.log(row(label, pf(kept)));
}
