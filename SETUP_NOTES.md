# Charon DRY_RUN Setup Notes

Notes prepared 2026-05-11 before next session. Charon is cloned at `~/Documents/charon`,
verified against README. Ready to configure once user has Telegram bot + signal server key.

## Critical blockers (must solve BEFORE pm2 start)

### 1. Signal server — RESOLVED ✓ (2026-05-11)

User received `SIGNAL_SERVER_KEY` from Yunus. Stored in `.env` (gitignored).
Health endpoint verified working: `https://api.thecharon.xyz/api/health` returns
`{"status":"ok","totalSignals":315,"recentSignals":155,"uptime":~36h}` at <1s response.

`.env` already has:
```
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=<48-char hex token>
```

### 2. Telegram bot token — RESOLVED ✓ (2026-05-11)

Bot created via @BotFather: **t.me/serpens_telegram_act2_bot** ("Charon Agent", ID 8764406850).
Token stored in `.env`. Verified via getMe (ok=true). Privacy mode default = on (sees only
/-commands in groups; fine for our use). Token is independent of Meridian's bot.

### 3. Telegram chat ID — RESOLVED ✓ (2026-05-11)

User chose DM with the Charon bot directly (cleanest separation, can mute independently
of Meridian). User sent `/start` to bot; chat ID = `5839244281` (Ammar/@amrrobb private).
Stored in `.env`. Test sendMessage succeeded — bot can DM user (message_id=2).

### 4. LLM API key

Charon supports any OpenAI-compatible endpoint. README defaults to MiniMax M2.7
(same as Meridian). **Same MiniMax key works for both bots.** Charon costs ~1 LLM call
per signal-batch cycle, so usage scales with `SIGNAL_POLL_MS` (default 30s) and
`LLM_CANDIDATE_PICK_COUNT` (default 10). Budget ~2x current Meridian token usage to be safe.

## Mode + execution details

Charon's mode env var: `TRADING_MODE` (not `DRY_RUN` like Meridian).
- `dry_run` — stores simulated buys/sells in SQLite. **No wallet needed.**
- `confirm` — Telegram approve/reject buttons before each live trade.
- `live` — signs and broadcasts Jupiter Ultra swaps.

**For our setup: `TRADING_MODE=dry_run`.** No wallet key required. This is good — means
we don't even share Meridian's wallet during dry-run.

## Minimum viable .env for dry-run

```env
# Telegram (NEW bot, existing chat)
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=<same as Meridian or new>
TELEGRAM_TOPIC_ID=

# Signal server (BLOCKING — get from yunus)
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=<from yunus>
SIGNAL_POLL_MS=30000

# Helius RPC (can reuse Meridian's HELIUS_API_KEY)
HELIUS_API_KEY=<from Meridian's .env>
SOLANA_RPC_URL=
SOLANA_WS_URL=

# GMGN (can reuse Meridian's GMGN_API_KEY)
GMGN_ENABLED=true
GMGN_API_KEY=<from Meridian's .env>
GMGN_REQUEST_DELAY_MS=2500
GMGN_MAX_RETRIES=2

DB_PATH=./charon.sqlite
TRADING_MODE=dry_run

# Live wallet — LEAVE BLANK for dry-run
SOLANA_PRIVATE_KEY=
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02

# LLM (same MiniMax key as Meridian)
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=<same as Meridian>
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=60000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
MAX_OPEN_POSITIONS=3

MIN_FEE_CLAIM_SOL=2
```

## Where to run it (local vs VPS)

Options:
- **Local laptop** — easier to inspect, kill instantly, lower stakes. Downside: laptop must be on.
- **VPS** — runs 24/7, but adds another pm2 process to manage on the same machine as live Meridian.

Recommend local laptop for the dry-run period (5-7 days). DRY_RUN has no risk; if laptop
sleeps overnight, we just lose a few hours of evaluation data, no money loss. After dry-run,
if Charon graduates to live, move to VPS.

## Startup sequence

```bash
cd ~/Documents/charon
npm install                                # already done? verify with `ls node_modules`
cp .env.example .env                       # then fill in values
npm run check                              # syntax-check (no runtime)
node index.js                              # foreground, or:
pm2 start index.js --name charon-dryrun    # background with auto-restart
pm2 logs charon-dryrun --lines 50          # watch first cycle
```

First-cycle checks (paste these into next session for verification):
- Startup banner mentions `TRADING_MODE: dry_run`
- Signal server poll succeeds (no 401 / 403)
- Telegram bot accepts `/menu` from your chat
- At least one candidate batch evaluated within the first 10 minutes
- LLM calls happen and return decisions
- SQLite file `~/Documents/charon/charon.sqlite` is created

## DEPLOYED 2026-05-11 10:36 UTC

Charon running on VPS in dry_run mode:
- pm2 id=1, name=`charon-dryrun`, online
- HEAD `3e7b0cf` (cloned directly from yunus-0x/charon, NOT forked)
- `/opt/charon/charon.sqlite` growing (started at 569KB)
- Telegram bot "Charon Agent" sending notifications to DM with @amrrobb
- Signal poll cycle: every 30s, ~100 signals tracked, 2-3 trigger candidates per cycle, all filtered out so far
- pm2 save executed → auto-restart on VPS reboot

**Note on fork:** cloned from yunus-0x directly, not from your fork. Tradeoff: easier upstream updates via `git pull`, but vulnerable to upstream breaking changes. Fork to amrrobb/charon and re-clone WHEN graduating to live, not before.

## Setup status (2026-05-11)

| Item | Status |
|---|---|
| Signal server URL + key | ✓ Stored, /api/health 200 in <1s |
| Telegram bot token | ✓ Stored, getMe verified ("Charon Agent") |
| Telegram chat ID | ✓ Stored (DM with @amrrobb, test message delivered) |
| Helius RPC URL + WS | ✓ Stored, getHealth returns "ok" |
| HELIUS_API_KEY | ✓ Copied from Meridian (36 chars) |
| GMGN_API_KEY | ✓ Copied from Meridian (37 chars) |
| LLM (MiniMax) | ✓ Copied from Meridian (125 chars), verified returns model list |
| TRADING_MODE | ✓ dry_run |
| SessionStart hook | ✓ Live in settings.json |
| Wallet/Jupiter keys | ✗ INTENTIONALLY EMPTY (not needed for dry_run) |

**All required values configured. All endpoints verified responsive.**

## Open questions for next session

1. Run locally on laptop or on VPS?
2. Do `npm install` (check `~/Documents/charon/node_modules/` exists first)?
3. Start in foreground (`node index.js`) to watch first cycle, or pm2 background immediately?

## RPC rotation decision (2026-05-11)

Meridian uses tools/rpc.js with 4-endpoint round-robin rotation. Charon's .env.example
takes only single SOLANA_RPC_URL. **Path A chosen for dry-run:** single Helius endpoint
shared with Meridian. Dry-run mode does mostly reads (no tx broadcasts), single endpoint
sufficient. **Path B (port tools/rpc.js to Charon) deferred to graduation.**

## What NOT to do

- Don't set `TRADING_MODE=live` or `confirm` during evaluation period
- Don't share Meridian's TELEGRAM_BOT_TOKEN (race condition)
- Don't set `SOLANA_PRIVATE_KEY` until graduating to live (no need for dry_run)
- Don't touch `/opt/charon` on VPS yet — that's for if/when we graduate to live
- Don't tune strategies (sniper/dip_buy/smart_money/degen) on day one — observe defaults

## Evaluation criteria (rerun after 5-7 days dry-run)

| Metric | Pass threshold |
|---|---|
| Hypothetical win rate | ≥ 60% over ≥ 30 decisions |
| Avg hypothetical PnL/trade | Positive after assumed fees + slippage |
| Worst hypothetical single loss | ≤ -8% (matches Meridian's loss tolerance) |
| Decisions/day | ≥ 5 (else signal quality too thin) |
| LLM cost vs hypothetical profit | LLM cost < 10% of net hypothetical profit |

ALL pass → graduate live with 5 SOL on a NEW wallet.
1-2 fail → tune strategies, run another week dry.
3+ fail → shelve Charon, focus on Meridian.
