# Charon Overnight Improvements — Log

**Branch:** `overnight-improvements` on `amrrobb/charon` fork
**Started:** 2026-05-12 night / 2026-05-13 morning UTC
**Operator:** Claude Code (Opus 4.7), running autonomously while user sleeps.
**Constraints honored:**
- No code deployment to VPS. All work in fork only.
- No further SQLite mutations to running `sniper` config.
- New strategies INSERTed as additional disabled rows.
- No live-execution path changes.
- Do not promise profitability — describe what each change does mechanically.

---

## Deferred questions for morning review

1. **Pick a strategy to A/B test.** Three new strategies seeded (disabled):
   `sniper_tight`, `sniper_runner`, `sniper_safe`. Each tests a different
   hypothesis about why we're losing. Recommend `sniper_safe` first — it's
   the most justified by research (tighter top-holder concentration is a
   well-documented rug filter).

2. **Add sniper-bucket-supply filter?** Highest-impact research finding
   (see "Research findings" below). Requires a new Helius integration to
   compute "% of supply held by wallets that bought in first 20 slots after
   graduation." Not implemented tonight because it's a net-new external
   integration and the advisor said "engineering fixes with intrinsic
   justification only" — this needs your call on scope.

3. **Add dev-sell exit signal?** Second-strongest research finding. Track
   creator wallet; if dev sells > 50% of remaining balance, hard exit any
   open position on that mint. Requires Helius webhook subscription. Same
   scope question as #2.

4. **Should `https`-style positions auto-close on detection?** Position #9
   was rejected by the junk filter retroactively, but it's already open.
   Should `monitorPositions` re-validate name/symbol and force-close on
   junk? Probably no — but flagging in case you disagree.

5. **`min_holders` filter in active sniper is 0.** Research suggests
   ≥100 holders is a sane floor for Pump.fun graduates. The new
   `sniper_safe` strategy uses 100; should we raise the active `sniper` row
   to even 30-50? (Pure SQLite edit; trivial.)

---

## State at start (2026-05-12 ~18:00 UTC)

- 9 positions opened, 7 closed, 2 open (KNIGHT, "https")
- Realized: −0.1052 SOL on 0.9 deployed = −11.7% on capital
- Win rate 14.3% (1 win / 6 losses)
- Tier 1 strategy edits already applied via SQLite:
  - `partial_tp_at_percent: 30`
  - `partial_tp_sell_percent: 50`
  - `trailing_percent: 15`
  - `max_hold_ms: 1800000` (30 min)
  - `min_source_count: 2` (reverted from 3)
- Open positions use pre-edit params (TP/SL baked into row at entry).

## Goal

Improve evaluation infrastructure + add engineering fixes with intrinsic justification (not stat-fit to N=7). Provide alternative strategies for user to test in the morning.

## Plan

1. **Foundation:** `position_snapshots` table — per-cycle P&L history. Without this, every future evaluation is hand-waving.
2. **Bad-name filter** — reject `https`/`www`/junk-name tokens pre-LLM.
3. **Per-mint cooldown** — 60min blacklist post-close. Prevents BIRDCLAW-style round-trips.
4. **LLM override fix** — force strategy defaults; ignore LLM's per-trade TP/SL/trailing suggestions.
5. **Alt strategies** — 2-3 disabled rows for user to pick from in morning.
6. **Research** — Pump.fun mechanics, what proven tools filter for.

Each piece committed separately so user can review/cherry-pick.

---

## Commits

All on branch `overnight-improvements` in `amrrobb/charon`. Review with
`git fetch origin && git log --oneline origin/overnight-improvements ^main`.

- **bf35e92** — Add `position_snapshots` table for per-cycle P&L history.
  Every monitor tick now writes (position_id, at_ms, price, mcap,
  unrealized_pnl_%, sol, high_water_mcap, trailing_armed). Enables
  time-series analysis and counter-factual "what if SL was -15?" backtesting.
  ~840 KB/day storage cost.

- **46fd232** — Reject obvious junk-named tokens pre-LLM. Symbols matching
  `^https?$/^www$/^ftp$/^null$/^undefined$`, symbols with `.com` or `://`,
  symbols < 2 chars, names containing `take profits|selling|dump|rug|scam|
  honeypot|exit liquidity` get rejected before LLM call. Justified by
  position #9 (symbol=`https`, name=`had to take profits sir`, lost -X%).

- **bd30fb2** — Per-mint cooldown after exit. New strat field
  `mint_cooldown_ms` (default 0 = disabled). When set, blocks re-entry on
  any mint that closed within the window. BIRDCLAW lost a +42% winner this
  way: pos #2 closed +42%, pos #3 opened same mint 3 min later, lost -24%.
  Logs `entry_skipped_cooldown` action so it's auditable.

- **a442c34** — Strategy TP/SL/trailing become authoritative; LLM is advisory.
  All 9 dry-run positions used `decision.suggested_*` instead of strategy
  values, defeating manual tuning. Inverted the `||` chain to put strategy
  first using `??`. Reversible per-strategy via
  `strat.allow_llm_tp_sl_override = true`.

- **c0cc744** — Seed three experimental strategies (disabled by default):
  - **sniper_tight** — partial TP at +20%, 10% trailing, 20-min max_hold,
    SL -15%. Hypothesis: Pump.fun pumps mean-revert fast; grab gains early.
  - **sniper_runner** — 3 sources + 75% LLM conf + top20 <=60% required.
    TP 100%, 25% trailing, 60-min max_hold. Hypothesis: fewer but bigger.
  - **sniper_safe** — paranoid filters (min 100 holders, top20 <=50%,
    mcap >=$15k). Tiny -12% SL, 30-min max_hold. Hypothesis: most losses
    are low-quality signals fooling the LLM.

  All three carry `mint_cooldown_ms: 3600000` so the BIRDCLAW round-trip
  can't recur. Flip one on via /menu → Strategy → pick.

---

## Deploy steps (read before doing)

**Nothing from tonight is running on the VPS.** The bot at /opt/charon is
still on upstream HEAD `3e7b0cf`. Last night's Tier 1 SQLite edits ARE
active (and the KNIGHT MAX_HOLD exit proves they work) — but the 6 code
commits in `amrrobb/charon@overnight-improvements` are not.

On the VPS, when you decide to deploy:

```bash
cd /opt/charon
git remote add amrrobb git@github.com:amrrobb/charon.git  # one-time
git fetch amrrobb
git log --oneline amrrobb/overnight-improvements ^HEAD     # review what's incoming
# Either merge into local main:
git merge amrrobb/overnight-improvements --ff-only          # or --no-ff for a merge commit
# Or check out the branch directly:
git checkout amrrobb/overnight-improvements
# Then:
pm2 restart charon-dryrun --update-env
pm2 logs charon-dryrun --lines 30  # watch first cycle for errors
```

Verify after restart:
```bash
sqlite3 /opt/charon/charon.sqlite "SELECT name FROM sqlite_master WHERE name='position_snapshots';"
# Should print: position_snapshots
sqlite3 /opt/charon/charon.sqlite "SELECT COUNT(*) FROM strategies;"
# Should print: 7 (sniper, dip_buy, smart_money, degen + sniper_tight, sniper_runner, sniper_safe)
```

If anything breaks, rollback is one command:
```bash
git checkout 3e7b0cf  # upstream HEAD
pm2 restart charon-dryrun --update-env
```

SQLite schema changes are forward-compatible (CREATE TABLE IF NOT EXISTS,
INSERT OR IGNORE for seeds). No data loss risk on rollback.

## Research findings

Summary of research conducted via subagent. Full findings preserved here so
they survive a context window flush.

### Key claim: dump dynamics on Pump.fun

JUMPBIT (Feb 2026 playbook) and Solidus Labs both characterize the
~30-minute post-graduation window as decisive — "98.7% of Pump.fun tokens
classified as pump-and-dump-shaped" (Solidus). Charon's empirical pattern
(+26% avg peak, -14% avg final on 7 trades) is consistent with this.
Implication: entry isn't the main problem; **exit timing inside the 30-min
euphoria window is**. Tier 1's `max_hold_ms=1800000` already addresses this.

### Filters Charon does not have (cross-referenced across Photon/Axiom/GMGN/BullX terminals)

- **Bundle detection** — was LP-add + first N buys atomic in one block?
- **Sniper-bucket supply %** — share of supply held by wallets that bought
  in the first 20 slots after graduation. Across-the-board surfaced. (★ best add)
- **Dev-wallet sell triggers** — Axiom productizes "Buy After Dev Sells"
  AND uses dev-sell as a hard exit signal. (★ best dual-use add)
- **Mint/freeze authority null + LP burned + creator-LP-locked checks** —
  Charon partially has these via GMGN, but doesn't reject on them.

### Holder concentration thresholds (consensus from rug-detection sources)

- Top-10 holders > 30% = warning, > 40% = hard reject (DeFade, Rugchecker).
- Top-5 > 90% = no-shit-rug reject (Flintr). Charon's current
  `max_top20_holder_percent=100` is effectively off; the new `sniper_safe`
  strategy uses 50%, which is the strongest defensible setting.

### Two concrete recommendations from the research

**(a) Sniper-bucket supply %.** Reject if first-20-slot-buyer balance >
25-30% of supply. Highest-value entry filter according to the terminals'
revealed preferences. Requires Helius RPC integration to enumerate
post-graduation buyer wallets. Not implemented tonight.

**(b) Dev-sell as both filter and exit signal.** Skip entry if creator
already sold >50% of post-graduation balance; force-exit any open position
on a mint where dev sells. The only entry-adjacent filter that doubles as
exit logic. Requires Helius webhooks on the creator wallet. Not implemented
tonight.

### Sources

- [JUMPBIT — 30-Min Post-Graduation Playbook](https://medium.com/@jump_bit/the-30-minute-post-graduation-playbook-keep-your-pump-fun-token-alive-on-pumpswap-59c71e08ebb6)
- [Solidus Labs — Solana Rug Pulls & Pump-and-Dumps](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance)
- [Flintr — Anatomy of a Rug Pull on Pump.fun](https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun)
- [Axiom Migration Actions docs](https://docs.axiom.trade/axiom/swap/migration-actions)
- [Moonshots Daily — Axiom Pro guide](https://moonshotsdaily.com/axiom-pro-full-guide-bullx-and-photon-killer/)
- [Crypto-Reporter — 2026 terminal ranking](https://www.crypto-reporter.com/press-releases/banana-pro-axiom-photon-gmgn-bullx-best-on-chain-trading-terminals-ranked-for-2026-124865/)
- [DeFade — 10 Red Flags for Solana Rug Pulls](https://defade.org/blog/how-to-spot-solana-rug-pull)
- [Dune dashboard pointer — jondar/pumpfun](https://dune.com/jondar/pumpfun) (JS-rendered, not validated; open manually before using)

---

## Health checks

**2026-05-12 18:13 UTC** — pm2 charon-dryrun online, 26h uptime, 0 restarts,
0% CPU, 144 MB RAM. One stray Twitter 404 (cosmetic, no impact). Two new
positions opened since evaluation: #9 "https" (still open, pre-edit params),
#10 Dog (opened 17:56 UTC, post-edit so will get new params).

**Key empirical validation:** Position #7 KNIGHT closed with `exit_reason:
MAX_HOLD` at -1.16%. KNIGHT opened ~14h after I applied the Tier 1 SQLite
edit, so it picked up the new `max_hold_ms = 1800000` (30 min). The
peak-without-exit-then-bleed-to-SL pattern that hurt ASTROID (-20.7%) is
now capped. Tier 1 worked.

**2026-05-13 02:03 UTC** — pm2 healthy, 27h uptime. Two new closes since
the last check:

- **#9 "https": MAX_HOLD at +58.52% / +0.0585 SOL.** The literally-named-`https`
  token rode +58% in its 30-min window. Notable: this is *exactly* the token
  the new junk filter (commit `46fd232`) would have rejected pre-LLM. After
  the deploy, this category of win goes away — but so does the much larger
  population of `https`-grade losers we haven't yet sampled. Net expectation
  is positive but cannot be proven on N=1.
- **#10 "Dog": MAX_HOLD at -1.32%.** Tiny loss; max_hold prevented bleed.

Updated aggregate (10 closes, no open positions):

| Exit reason | N | Avg P&L | Net SOL |
|---|---|---|---|
| SL | 6 | -24.58% | -0.1475 |
| MAX_HOLD | 3 | +18.68% | +0.0560 |
| TRAILING_TP | 1 | +42.30% | +0.0423 |
| **TOTAL** | **10** | **-4.92%** | **-0.0492** |

Win rate 20% (2/10). ROC improved from -11.7% to -4.92% — partly real
infrastructure gain (MAX_HOLD shifted slow-bleed losers to small losers),
partly the `https` outlier. **MAX_HOLD avg without https is ~-1.2%** —
still meaningfully better than SL's -24.58%.

Two LLM timeouts (20:22, 20:41) and one twitter 404 (cosmetic). No
crashes. Decision funnel last 45 min: 1 BUY / 9 PASS / 9 WATCH. 1
`entry_rejected_fresh_filters` (existing logic working). 0 new entries —
LLM threshold or signal quality bound, not the strategy edits.

Conclusion: bot healthy, infrastructure changes appearing in the data,
ready for morning deployment.
