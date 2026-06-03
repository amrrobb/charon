// Phase 1: Bonding curve monitor.
// Parses CREATE and TRADE events from the existing pump.fun WebSocket,
// tracks per-token velocity, and emits candidates when thresholds are met.
//
// Event discriminators (first 8 bytes of SHA-256("global:<event_name>")):
//   CreateEvent:   see DISC_CREATE below
//   TradeEvent:    see DISC_TRADE below
//   CompleteEvent: see DISC_COMPLETE below (graduation)
//
// Data is read from "Program data:" log lines (base64 encoded), same as
// feeClaim.js does for DistributeFees events.

import { createHash } from 'crypto';
import { now, pruneSeen, discMatch, readPubkey, readU64, readI64, lamToSol } from '../utils.js';
import { storeSignalEvent } from './trending.js';
import { sendTelegram } from '../telegram/send.js';
import { db } from '../db/connection.js';
import { setting, setSetting } from '../db/settings.js';

// Phase 2.7: post-alert path tracking. For tokens crossing the track
// threshold (netSol >= TRACK_NET_SOL), simulate SL + trailing exits live
// off the TRADE event stream so we MEASURE real death-loss and achievable
// exit instead of assuming them. No execution — pure measurement.
db.exec(`
  CREATE TABLE IF NOT EXISTS bc_tracks (
    mint TEXT PRIMARY KEY,
    alert_at_ms INTEGER NOT NULL,
    entry_mcap_sol REAL,
    alert_net_sol REAL,
    alert_sol_in REAL,
    alert_vel REAL,
    alert_bsr REAL,
    alert_buyers INTEGER,
    peak_mcap_sol REAL,
    peak_ret_pct REAL,
    sl_ret_pct REAL,
    trail20_ret_pct REAL,
    trail30_ret_pct REAL,
    trail40_ret_pct REAL,
    graduated INTEGER DEFAULT 0,
    trade_count INTEGER DEFAULT 0,
    last_mcap_sol REAL,
    last_at_ms INTEGER,
    ended_reason TEXT
  );
`);
// Liquidity-depth proxy (net SOL in the curve at last observed trade) so exit
// fills can be modeled against book depth, not detection-time price (loss-side
// realism — rugged tokens have collapsed depth). Migrate existing tables.
try { db.exec('ALTER TABLE bc_tracks ADD COLUMN last_curve_sol REAL'); } catch { /* column exists */ }
// Entry-latency realism: the validated PF assumes we fill at the ALERT price.
// In reality we detect, then a buy lands a few seconds later — into a rising
// curve, at a worse price. Capture the price BC_ENTRY_DELAY_MS after alert so
// analysis can charge that entry-slip and test whether the edge survives
// realistic fill latency (the go/no-go before building live execution).
try { db.exec('ALTER TABLE bc_tracks ADD COLUMN entry_delayed_mcap_sol REAL'); } catch { /* column exists */ }
// Delayed-entry RE-SIMULATION (L27): a second virtual position that ENTERS at the
// realistic delayed fill price and runs its OWN peak/SL/trail re-based from there —
// the only honest way to settle the latency bracket [0.57, 2.79]. These returns are
// measured relative to entry_delayed_mcap_sol, not the instant alert price.
for (const col of ['delayed_sl_ret_pct','delayed_trail20_ret_pct','delayed_trail30_ret_pct','delayed_trail40_ret_pct','delayed_peak_ret_pct']) {
  try { db.exec(`ALTER TABLE bc_tracks ADD COLUMN ${col} REAL`); } catch { /* exists */ }
}

const TRACK_NET_SOL = Number(process.env.BC_TRACK_NET_SOL || 20);
const ENTRY_DELAY_MS = Number(process.env.BC_ENTRY_DELAY_MS || 5000);
const SL_PCT = -20;
const TRAILS = [20, 30, 40];
const tracks = new Map(); // mint -> live track state
const TRACK_TTL_MS = 60 * 60 * 1000; // measure up to 60 min post-alert

// Burst budget: stop the WS after the bc_tracks table holds enough
// netSol>=TRACK_NET_SOL rows (ABSOLUTE, DB-backed) or after a wall-clock
// deadline — both survive process restarts (L20/L21: an in-memory counter +
// setTimeout reset on every restart and let the monitor run for hours, draining
// a free key). 0 = disabled (run continuously).
const BURST_NETSOL_TARGET = Number(process.env.BC_BURST_NETSOL_TARGET || 0);  // absolute row count in DB
const BURST_MAX_MS = Number(process.env.BC_BURST_MAX_MS || 0);
let burstStop = null;

function netSolRowCount() {
  return db.prepare('SELECT COUNT(*) n FROM bc_tracks WHERE alert_net_sol >= ?').get(TRACK_NET_SOL).n;
}
function checkBurstBudget() {
  if (!burstStop) return;
  if (BURST_NETSOL_TARGET > 0) {
    const n = netSolRowCount();
    if (n >= BURST_NETSOL_TARGET) {
      console.log(`[bc] burst target reached (${n} netSol>=${TRACK_NET_SOL} rows >= ${BURST_NETSOL_TARGET}) — stopping WS`);
      burstStop(`netSol target ${BURST_NETSOL_TARGET}`); burstStop = null; return;
    }
  }
  const deadline = Number(setting('bc_burst_deadline_ms', '0'));
  if (deadline > 0 && now() > deadline) {
    console.log(`[bc] burst deadline passed — stopping WS`);
    burstStop('time deadline'); burstStop = null;
  }
}
export function setBurstStop(fn) {
  burstStop = fn;
  if (!fn) return;
  // Persist an absolute deadline ONCE (survives restarts). Don't reset it on reboot.
  if (BURST_MAX_MS > 0 && Number(setting('bc_burst_deadline_ms', '0')) <= 0) {
    setSetting('bc_burst_deadline_ms', now() + BURST_MAX_MS);
  }
  checkBurstBudget();                 // already over budget? stop immediately on boot
  setInterval(checkBurstBudget, 60_000); // backstop so the deadline fires even with no new tracks
}

function startTrack(curve, summary) {
  if (tracks.has(curve.mint)) return;
  const entry = curve.mcapSol || 0;
  if (entry <= 0) return;
  const t = {
    mint: curve.mint,
    alertAt: now(),
    entryMcap: entry,
    netSol: summary.netSol,
    solIn: summary.solIn,
    vel: summary.velocitySolPerMin,
    bsr: summary.buySellRatio,
    buyers: summary.uniqueBuyers,
    peak: entry,
    slRet: null,
    trailRet: { 20: null, 30: null, 40: null },
    graduated: false,
    tradeCount: 0,
    lastMcap: entry,
    lastCurveSol: summary.netSol,
    entryDelayed: null,   // price BC_ENTRY_DELAY_MS after alert (fill-latency realism)
    delayedPeak: null,    // delayed-entry re-sim: peak observed AFTER the delayed fill
    delayedSlRet: null,
    delayedTrailRet: { 20: null, 30: null, 40: null },
  };
  tracks.set(curve.mint, t);
  db.prepare(`
    INSERT OR IGNORE INTO bc_tracks
      (mint, alert_at_ms, entry_mcap_sol, alert_net_sol, alert_sol_in, alert_vel, alert_bsr, alert_buyers, peak_mcap_sol, last_mcap_sol, last_at_ms, last_curve_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.mint, t.alertAt, entry, t.netSol, t.solIn, t.vel, t.bsr, t.buyers, entry, entry, t.alertAt, t.lastCurveSol);
  checkBurstBudget(); // restart-safe stop check (DB row count + deadline)
}

function updateTrack(mint, mcapSol, curveSol) {
  const t = tracks.get(mint);
  if (!t || !(mcapSol > 0)) return;
  t.tradeCount += 1;
  t.lastMcap = mcapSol;
  if (curveSol !== undefined && curveSol !== null) t.lastCurveSol = curveSol;
  // First trade at/after the fill-latency window fixes our realistic entry price.
  if (t.entryDelayed === null && now() - t.alertAt >= ENTRY_DELAY_MS) t.entryDelayed = mcapSol;
  // Delayed-entry RE-SIM: once filled, run a position re-based at entry_delayed with
  // its OWN peak/SL/trail. Removes both estimator biases (L27) — exact, not approximate.
  if (t.entryDelayed !== null) {
    if (t.delayedPeak === null) t.delayedPeak = t.entryDelayed; // first post-fill obs = our entry
    if (mcapSol > t.delayedPeak) t.delayedPeak = mcapSol;
    const dRet = (mcapSol / t.entryDelayed - 1) * 100;
    if (t.delayedSlRet === null && dRet <= SL_PCT) t.delayedSlRet = dRet;
    for (const trail of TRAILS) {
      if (t.delayedTrailRet[trail] === null && t.delayedPeak > t.entryDelayed) {
        const drop = (mcapSol / t.delayedPeak - 1) * 100;
        if (drop <= -trail) t.delayedTrailRet[trail] = dRet;
      }
    }
  }
  if (mcapSol > t.peak) t.peak = mcapSol;
  const retFromEntry = (mcapSol / t.entryMcap - 1) * 100;
  // SL from entry
  if (t.slRet === null && retFromEntry <= SL_PCT) t.slRet = retFromEntry;
  // Trailing from peak (only after armed = peak above entry)
  for (const trail of TRAILS) {
    if (t.trailRet[trail] === null) {
      const dropFromPeak = (mcapSol / t.peak - 1) * 100;
      if (t.peak > t.entryMcap && dropFromPeak <= -trail) {
        t.trailRet[trail] = retFromEntry;
      }
    }
  }
  persistTrack(t);
}

function persistTrack(t, reason = null) {
  const peakRet = (t.peak / t.entryMcap - 1) * 100;
  db.prepare(`
    UPDATE bc_tracks SET
      peak_mcap_sol=?, peak_ret_pct=?, sl_ret_pct=?,
      trail20_ret_pct=?, trail30_ret_pct=?, trail40_ret_pct=?,
      graduated=?, trade_count=?, last_mcap_sol=?, last_at_ms=?, last_curve_sol=?, entry_delayed_mcap_sol=?,
      delayed_sl_ret_pct=?, delayed_trail20_ret_pct=?, delayed_trail30_ret_pct=?, delayed_trail40_ret_pct=?, delayed_peak_ret_pct=?,
      ended_reason=?
    WHERE mint=?
  `).run(t.peak, peakRet, t.slRet, t.trailRet[20], t.trailRet[30], t.trailRet[40],
    t.graduated ? 1 : 0, t.tradeCount, t.lastMcap, now(), t.lastCurveSol ?? null, t.entryDelayed ?? null,
    t.delayedSlRet ?? null, t.delayedTrailRet[20], t.delayedTrailRet[30], t.delayedTrailRet[40],
    (t.entryDelayed && t.delayedPeak) ? (t.delayedPeak / t.entryDelayed - 1) * 100 : null,
    reason, t.mint);
}

function endTrack(mint, reason) {
  const t = tracks.get(mint);
  if (!t) return;
  t.graduated = t.graduated || reason === 'graduated';
  persistTrack(t, reason);
  tracks.delete(mint);
}

function pruneTracks() {
  const cutoff = now() - TRACK_TTL_MS;
  for (const [mint, t] of tracks) {
    if (t.alertAt < cutoff) endTrack(mint, 'ttl');
  }
}
setInterval(pruneTracks, 60_000);

function anchorDisc(eventName) {
  return Buffer.from(createHash('sha256').update(`global:${eventName}`).digest()).subarray(0, 8);
}

// Pump.fun program event discriminators
const DISC_CREATE   = anchorDisc('create');
const DISC_TRADE    = anchorDisc('buy');       // TradeEvent emitted on both buy AND sell
const DISC_COMPLETE = anchorDisc('complete');   // CompleteEvent = graduation

// Fallback: the actual event discriminators may differ from instruction names.
// Pump.fun uses Anchor events which hash as "event:<EventName>".
// Try both patterns — the parser will match whichever fires.
const DISC_CREATE_EVENT   = Buffer.from(createHash('sha256').update('event:CreateEvent').digest()).subarray(0, 8);
const DISC_TRADE_EVENT    = Buffer.from(createHash('sha256').update('event:TradeEvent').digest()).subarray(0, 8);
const DISC_COMPLETE_EVENT = Buffer.from(createHash('sha256').update('event:CompleteEvent').digest()).subarray(0, 8);

// In-memory state: track active bonding curves
// Map<mint, { createdAt, creator, name, symbol, trades[], solIn, uniqueBuyers, graduated }>
const curves = new Map();
const MAX_CURVES = 5000;
const CURVE_TTL_MS = 30 * 60 * 1000; // drop curves after 30min of no activity
const SOL_USD_REF = Number(process.env.SOL_USD_REF || 170); // rough USD conv for display only

let candidateHandler = null;
export function setBondingCurveHandler(fn) { candidateHandler = fn; }

// Thresholds for triggering candidate (Phase 1 = alert only, Phase 3 = execute)
const MIN_SOL_IN = Number(process.env.BC_MIN_SOL_IN || 3);           // min SOL deposited
const MIN_UNIQUE_BUYERS = Number(process.env.BC_MIN_UNIQUE_BUYERS || 8);
const MAX_AGE_MS = Number(process.env.BC_MAX_AGE_MS || 5 * 60 * 1000); // within first 5 min
const ALERT_COOLDOWN_MS = 60_000;
let lastAlertMs = 0;
let alertCount = 0;

function parseCreateEvent(data) {
  // CreateEvent layout (after 8-byte discriminator):
  // name: string (4-byte len prefix + utf8)
  // symbol: string (4-byte len prefix + utf8)
  // uri: string (4-byte len prefix + utf8)
  // mint: pubkey (32)
  // bondingCurve: pubkey (32)
  // user: pubkey (32)
  try {
    let offset = 8;
    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name = data.subarray(offset, offset + nameLen).toString('utf8'); offset += nameLen;
    const symbolLen = data.readUInt32LE(offset); offset += 4;
    const symbol = data.subarray(offset, offset + symbolLen).toString('utf8'); offset += symbolLen;
    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri = data.subarray(offset, offset + uriLen).toString('utf8'); offset += uriLen;
    const mint = readPubkey(data, offset); offset += 32;
    const bondingCurve = readPubkey(data, offset); offset += 32;
    const user = readPubkey(data, offset);
    return { mint, bondingCurve, creator: user, name, symbol, uri };
  } catch {
    return null;
  }
}

function parseTradeEvent(data) {
  // TradeEvent layout (after 8-byte discriminator):
  // mint: pubkey (32)
  // solAmount: u64 (8)
  // tokenAmount: u64 (8)
  // isBuy: bool (1)
  // user: pubkey (32)
  // timestamp: i64 (8)
  // virtualSolReserves: u64 (8)
  // virtualTokenReserves: u64 (8)
  // realSolReserves: u64 (8)
  // realTokenReserves: u64 (8)
  try {
    let offset = 8;
    const mint = readPubkey(data, offset); offset += 32;
    const solAmount = readU64(data, offset); offset += 8;
    const tokenAmount = readU64(data, offset); offset += 8;
    const isBuy = data[offset] === 1; offset += 1;
    const user = readPubkey(data, offset); offset += 32;
    const timestamp = readI64(data, offset); offset += 8;
    const virtualSolReserves = readU64(data, offset); offset += 8;
    const virtualTokenReserves = readU64(data, offset); offset += 8;
    const realSolReserves = offset + 8 <= data.length ? readU64(data, offset) : 0n; offset += 8;
    const realTokenReserves = offset + 8 <= data.length ? readU64(data, offset) : 0n;
    return { mint, solAmount, tokenAmount, isBuy, user, timestamp, virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves };
  } catch {
    return null;
  }
}

function pruneOldCurves() {
  const cutoff = now() - CURVE_TTL_MS;
  for (const [mint, curve] of curves) {
    if (curve.lastTradeAt < cutoff) curves.delete(mint);
  }
  if (curves.size > MAX_CURVES) {
    const sorted = [...curves.entries()].sort((a, b) => a[1].lastTradeAt - b[1].lastTradeAt);
    for (let i = 0; i < sorted.length - MAX_CURVES; i++) curves.delete(sorted[i][0]);
  }
}

function handleCreate(event) {
  if (!event || curves.has(event.mint)) return;
  curves.set(event.mint, {
    mint: event.mint,
    bondingCurve: event.bondingCurve,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    uri: event.uri,
    createdAt: now(),
    lastTradeAt: now(),
    solIn: 0,
    solOut: 0,
    buyCount: 0,
    sellCount: 0,
    uniqueBuyers: new Set(),
    uniqueSellers: new Set(),
    graduated: false,
    alerted: false,
    mcapEstimate: 0,
  });
}

function handleTrade(event) {
  if (!event) return;
  let curve = curves.get(event.mint);
  if (!curve) {
    curve = {
      mint: event.mint, bondingCurve: null, creator: null, name: null, symbol: null, uri: null,
      createdAt: now(), lastTradeAt: now(), solIn: 0, solOut: 0, buyCount: 0, sellCount: 0,
      uniqueBuyers: new Set(), uniqueSellers: new Set(), graduated: false, alerted: false, mcapEstimate: 0,
    };
    curves.set(event.mint, curve);
  }
  curve.lastTradeAt = now();
  const sol = lamToSol(Number(event.solAmount));
  if (event.isBuy) {
    curve.solIn += sol;
    curve.buyCount += 1;
    curve.uniqueBuyers.add(event.user);
  } else {
    curve.solOut += sol;
    curve.sellCount += 1;
    curve.uniqueSellers.add(event.user);
  }
  // Price/mcap from the trade's OWN fill: price = solAmount/tokenAmount
  // (SOL per token), mcap = price * 1B supply. More reliable than virtual
  // reserves (which parse as 0 for some event layouts). solAmount parses
  // correctly — solIn accumulates sensibly. Fallback to reserves if needed.
  const solAmt = lamToSol(Number(event.solAmount));
  const tokAmt = Number(event.tokenAmount) / 1e6; // 6 decimals
  if (tokAmt > 0 && solAmt > 0) {
    const pricePerToken = solAmt / tokAmt;
    curve.mcapSol = pricePerToken * 1_000_000_000;
    curve.mcapEstimate = curve.mcapSol * SOL_USD_REF;
  } else if (event.virtualSolReserves && event.virtualTokenReserves) {
    const vSol = lamToSol(Number(event.virtualSolReserves));
    const vToken = Number(event.virtualTokenReserves) / 1e6;
    if (vToken > 0) {
      curve.mcapSol = (vSol / vToken) * 1_000_000_000;
      curve.mcapEstimate = curve.mcapSol * SOL_USD_REF;
    }
  }
  // Feed the path tracker if this mint is being measured (pass curve depth =
  // net SOL in the curve, as the exit-fill liquidity proxy)
  if (curve.mcapSol > 0) updateTrack(event.mint, curve.mcapSol, curve.solIn - curve.solOut);
  checkThresholds(curve);
}

function handleComplete(data) {
  // CompleteEvent: mint is at offset 8 + 32 (after user pubkey)
  try {
    let offset = 8;
    const user = readPubkey(data, offset); offset += 32;
    const mint = readPubkey(data, offset);
    const curve = curves.get(mint);
    if (curve) curve.graduated = true;
    endTrack(mint, 'graduated');
    console.log(`[bc] GRADUATED: ${mint.slice(0, 8)}... ${curve?.symbol || '?'} (${curve?.solIn.toFixed(2)} SOL in, ${curve?.uniqueBuyers.size} buyers)`);
  } catch {}
}

async function checkThresholds(curve) {
  if (curve.alerted || curve.graduated) return;
  const age = now() - curve.createdAt;
  if (age > MAX_AGE_MS) return;
  if (curve.solIn < MIN_SOL_IN) return;
  if (curve.uniqueBuyers.size < MIN_UNIQUE_BUYERS) return;

  curve.alerted = true;
  const velocity = curve.solIn / (age / 60000); // SOL per minute
  const buySellRatio = (curve.buyCount + curve.sellCount) > 0
    ? curve.buyCount / (curve.buyCount + curve.sellCount) : 0;

  const summary = {
    mint: curve.mint,
    symbol: curve.symbol,
    name: curve.name,
    creator: curve.creator,
    solIn: curve.solIn,
    solOut: curve.solOut,
    netSol: curve.solIn - curve.solOut,
    buyCount: curve.buyCount,
    sellCount: curve.sellCount,
    uniqueBuyers: curve.uniqueBuyers.size,
    uniqueSellers: curve.uniqueSellers.size,
    ageMs: age,
    velocitySolPerMin: velocity,
    buySellRatio,
    mcapEstimate: curve.mcapEstimate,
    mcapSol: curve.mcapSol || 0,
  };

  console.log(`[bc] ALERT: ${curve.symbol || curve.mint.slice(0, 8)} | ${curve.solIn.toFixed(1)} SOL in ${(age/1000).toFixed(0)}s | ${curve.uniqueBuyers.size} buyers | vel ${velocity.toFixed(2)} SOL/min | mcap ~$${curve.mcapEstimate.toFixed(0)}`);

  storeSignalEvent(curve.mint, 'bonding_curve_velocity', 'pump_logs', summary);

  // Phase 2.7: track EVERY alert's path (records alert_net_sol so analysis
  // can slice by any threshold). Tracking is measurement-only and cheap.
  startTrack(curve, summary);

  // Telegram alert (rate-limited)
  if (now() - lastAlertMs > ALERT_COOLDOWN_MS) {
    alertCount += 1;
    lastAlertMs = now();
    const text = [
      `🔥 <b>Bonding Curve Alert #${alertCount}</b>`,
      `<b>${curve.symbol || '?'}</b> (${curve.name || '?'})`,
      `${curve.solIn.toFixed(1)} SOL in ${(age / 1000).toFixed(0)}s (${velocity.toFixed(1)} SOL/min)`,
      `${curve.uniqueBuyers.size} unique buyers, ${curve.buyCount} buys`,
      `Buy/sell: ${buySellRatio.toFixed(2)} | Net: ${(curve.solIn - curve.solOut).toFixed(1)} SOL`,
      `Mcap est: $${curve.mcapEstimate.toFixed(0)}`,
      `Creator: <code>${(curve.creator || '?').slice(0, 12)}...</code>`,
      `<a href="https://pump.fun/coin/${curve.mint}">pump.fun</a> | <a href="https://gmgn.ai/sol/token/${curve.mint}">GMGN</a>`,
    ].join('\n');
    sendTelegram(text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  }
}

export function processBondingCurveLog(data) {
  if (!data || data.length < 8) return false;
  if (discMatch(data, DISC_CREATE) || discMatch(data, DISC_CREATE_EVENT)) {
    handleCreate(parseCreateEvent(data));
    return true;
  }
  if (discMatch(data, DISC_TRADE) || discMatch(data, DISC_TRADE_EVENT)) {
    handleTrade(parseTradeEvent(data));
    return true;
  }
  if (discMatch(data, DISC_COMPLETE) || discMatch(data, DISC_COMPLETE_EVENT)) {
    handleComplete(data);
    return true;
  }
  return false;
}

// Periodic prune
setInterval(pruneOldCurves, 60_000);

// Stats for /summary
export function bondingCurveStats() {
  return {
    activeCurves: curves.size,
    alertCount,
    graduated: [...curves.values()].filter(c => c.graduated).length,
    tracking: tracks.size,
  };
}

// Phase 2.7 measured results: realized return distribution per trailing config
export function bcTrackStats() {
  const rows = db.prepare(`
    SELECT graduated, sl_ret_pct, trail20_ret_pct, trail30_ret_pct, trail40_ret_pct,
           peak_ret_pct, ended_reason
    FROM bc_tracks WHERE ended_reason IS NOT NULL
  `).all();
  if (!rows.length) return { n: 0 };
  // Realized return per token under each exit policy:
  //   sl hit first → sl_ret; else trailing hit → trail_ret; else final peak-ish.
  function realized(r, trailCol) {
    const sl = r.sl_ret_pct;
    const tr = r[trailCol];
    // Whichever triggered (both are first-touch). If neither, token still
    // running or graduated — approximate with peak * 0.7 (held to end).
    const candidates = [sl, tr].filter(v => v !== null);
    if (candidates.length) return Math.max(...candidates); // trailing usually > sl
    return (r.peak_ret_pct || 0) * 0.7;
  }
  const policies = { trail20: 'trail20_ret_pct', trail30: 'trail30_ret_pct', trail40: 'trail40_ret_pct' };
  const out = { n: rows.length, graduated: rows.filter(r => r.graduated).length };
  for (const [name, col] of Object.entries(policies)) {
    const rets = rows.map(r => realized(r, col));
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    out[name] = { avg };
  }
  return out;
}
