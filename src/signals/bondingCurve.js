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
  // Estimate mcap from virtual reserves
  if (event.virtualSolReserves && event.virtualTokenReserves) {
    const vSol = lamToSol(Number(event.virtualSolReserves));
    const vToken = Number(event.virtualTokenReserves) / 1e6; // token decimals = 6
    if (vToken > 0) {
      const pricePerToken = vSol / vToken;
      curve.mcapEstimate = pricePerToken * 1_000_000_000; // total supply ~1B
    }
  }
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
  };

  console.log(`[bc] ALERT: ${curve.symbol || curve.mint.slice(0, 8)} | ${curve.solIn.toFixed(1)} SOL in ${(age/1000).toFixed(0)}s | ${curve.uniqueBuyers.size} buyers | vel ${velocity.toFixed(2)} SOL/min | mcap ~$${curve.mcapEstimate.toFixed(0)}`);

  storeSignalEvent(curve.mint, 'bonding_curve_velocity', 'pump_logs', summary);

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
  };
}
