import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMP_AMM, DISC_DIST_FEES, SOLANA_WS_URL } from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';
import { processBondingCurveLog } from './bondingCurve.js';

export const seenFeeClaims = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60 * 1000);
  if (seenFeeClaims.has(key)) return;
  seenFeeClaims.set(key, now());
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8) continue;
    // Try bonding curve events first (CREATE, TRADE, COMPLETE)
    if (processBondingCurveLog(data)) continue;
    // Then fee claim events
    if (!discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

// Reconnect with exponential backoff + jitter + cap + circuit breaker.
// Lesson L18: a fixed 5s reconnect with no backoff became a 15,692-attempt
// DoS against our own Helius key when the WS hit 429. Never again.
export function startWebsocket(wsUrl = SOLANA_WS_URL, { subscribeAll = false } = {}) {
  if (!wsUrl) {
    console.log('[ws] no WS URL configured, websocket disabled');
    return;
  }
  let ws;
  let pingTimer;
  let attempt = 0;
  let consecutive429 = 0;
  let stopped = false; // set by stop() — burst budget reached; do not reconnect
  const BASE_DELAY = 5000;
  const MAX_DELAY = 120_000;        // cap at 2 min
  const CIRCUIT_BREAK_429 = 20;     // after 20 consecutive 429s, stop trying for a long while
  const CIRCUIT_COOLDOWN = 30 * 60 * 1000; // 30 min pause when breaker trips

  function nextDelay(rateLimited) {
    // Exponential backoff with full jitter; 429 escalates faster.
    const factor = rateLimited ? 3 : 2;
    const ceil = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(factor, Math.min(attempt, 8)));
    return Math.floor(BASE_DELAY + Math.random() * (ceil - BASE_DELAY));
  }

  function scheduleReconnect(rateLimited) {
    if (stopped) return; // burst budget reached — stay down
    if (rateLimited && consecutive429 >= CIRCUIT_BREAK_429) {
      console.log(`[ws] circuit breaker tripped (${consecutive429} consecutive 429s) — pausing ${CIRCUIT_COOLDOWN / 60000}min`);
      consecutive429 = 0;
      attempt = 0;
      setTimeout(connect, CIRCUIT_COOLDOWN);
      return;
    }
    const delay = nextDelay(rateLimited);
    console.log(`[ws] reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${attempt}${rateLimited ? ', rate-limited' : ''})`);
    setTimeout(connect, delay);
  }

  function connect() {
    attempt += 1;
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log('[ws] connected');
      attempt = 0;
      consecutive429 = 0;
      if (subscribeAll) {
        // Provider ignores {mentions} (e.g. FluxRPC) — subscribe to the full
        // firehose and filter client-side (see message handler pre-filter).
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: ['all'],
        }));
        console.log('[ws] subscribed: logsSubscribe(all) + client-side pump filter');
      } else {
        for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'logsSubscribe',
            params: [{ mentions: [program] }, { commitment: 'confirmed' }],
          }));
        }
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      // Cheap raw-substring pre-filter for the firehose path: ~97% of mainnet
      // logs never mention the pump programs, so skip JSON.parse on those.
      if (subscribeAll) {
        const s = typeof raw === 'string' ? raw : raw.toString();
        if (!s.includes(PUMP_PROGRAM) && !s.includes(PUMP_AMM)) return;
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    let lastErrorWas429 = false;
    ws.on('unexpected-response', (_req, res) => {
      lastErrorWas429 = res.statusCode === 429;
      if (lastErrorWas429) consecutive429 += 1;
      console.log(`[ws] unexpected response: ${res.statusCode}`);
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      scheduleReconnect(lastErrorWas429);
      lastErrorWas429 = false;
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();

  // Burst budget control (L20/L21): close the WS and never reconnect once the
  // caller decides enough data is collected — prevents a continuous firehose
  // from silently draining a free key/credit budget.
  function stop(reason = 'budget') {
    if (stopped) return;
    stopped = true;
    clearInterval(pingTimer);
    try { ws?.close(); } catch {}
    console.log(`[ws] stopped (${reason}) — no further reconnect`);
  }
  return { stop };
}
