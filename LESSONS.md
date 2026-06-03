# Lessons — degen_filtered_v1 cycle (2026-05-24/25)

## What we did
1. Looked at Telegram batch table (Batches 1-4, n=400). PF base = 0.57x → outlier-dependent.
2. Wrote `scripts/backtestTranche.js`. Tested 4 TP-ladder variants. **All worse than baseline.** Killed the ladder plan.
3. Pivoted to entry filters. Built `scripts/winnerLoserDiff.js` and `scripts/entryFilterSweep.js`.
4. Swept 14 filter combinations on B3+B4 (id 245-404, n=159).
5. **Picked the best by PF base**: `top10 ≤ 55% AND vol5m ≤ 1000` (in-sample PF base 0.77x → 1.15x).
6. Wired in code, seeded `degen_filtered_v1`, deployed to VPS, flipped.
7. **9 hours and 45 trades later: PF base 0.54x — below the 0.77x baseline.**
8. Reverted to `degen`.

## What the numbers actually said

| Metric | In-sample claim | Out-of-sample (45 trades, 9h) | Δ |
|---|---|---|---|
| Win Rate | 37.5% | 26.7% | -10.8pp |
| PF | 1.81x | 0.66x | -1.15x |
| PF base | 1.15x | 0.54x | **-0.61x** |
| Sum PnL | +446% | -190% | wipeout |
| Best winner | +178% (sim) | +68% | tail clipped |

Live baseline `degen` over same days: WR 26.5%, avg -2.8%. Filtered: WR 26.7%, avg -4.2%. **Filter did nothing for win rate, made average return worse.**

## Lessons

### L1. Cherry-picking from N-variant sweeps regresses to baseline or worse.
We tested 14 filter combinations and reported the one with the best PF base. Per multiple-comparisons statistics, the best-of-N is *expected* to regress. We saw exactly that: in-sample 1.15x → out-of-sample 0.54x (54% degradation). **Rule for next time: pre-state the filter and its thesis. Don't sweep-then-pick.**

### L2. "Statistical significance" of a sweep result is illusory without out-of-sample test.
B3+B4 had 159 trades. That's enough to compute PF base. It's not enough to validate a 2-threshold filter chosen from 14 options. Required: train on B3, validate on B4 (or vice versa). We didn't, and paid for it.

### L3. The W/L feature diff itself was the warning sign.
Winner top10 median was 57.08%. Loser top10 median was 57.13%. **Identical.** A genuine signal would show separation. The filter "worked" in-sample by clipping the right tail of the loser distribution at threshold 55 — pure tail-clipping on noise. Going forward: **if W/L medians overlap, no threshold on that feature is real signal.**

### L4. A filter that doesn't change Win Rate is not actually selecting better trades.
Live: degen 26.5% WR, degen_filtered_v1 26.7% WR. Statistically identical. The filter just rejected trades randomly within the original distribution while killing the right tail. **Win Rate is the cheapest sanity check — if it doesn't move, the filter doesn't discriminate.**

### L5. Killing the moonshot tail destroys the strategy.
Pre-filter best winner was MOGMAN +360%. Post-filter best was Pumba +68%. The whole strategy's PF survival depends on 1-2 moonshots per ~150 trades. Any filter that reduces *maximum* upside without proportionally reducing downside is destroying expected value. **For lottery-tail strategies, optimize on the *minimum* of trade outcomes, not the median.**

### L6. The "expected vs actual filter behavior" gap was huge and unmonitored.
The vol5m filter was supposed to fire on 25% of dual_source trades (based on data availability in B3+B4). In live, 38 of 45 closed trades had no vol5m data — the filter effectively reduced to just `top10 ≤ 55`. We deployed without verifying the filter would actually run on the candidates it was designed for. **Required: pre-flight check that the data needed by a filter is present at decision time on a representative sample of candidates.**

### L7. The article (overfitting by @dikibagast) framework is correct.
For every proposed optimization, *pre-state* the answers:
- How much does expected value improve, with confidence interval?
- What opportunity cost does this create?
- What loss is meaningfully reduced?
- Is the thesis concrete enough that you'd defend it to someone hostile?
- Does implementation match the thesis, not just produce the number?

We failed Q4 and Q5 explicitly. The "top10 ≤ 55" threshold has no defensible thesis — it's the bin that produced the best PF base in our sweep. That's not a thesis, that's a result.

### L8. The TP-ladder backtest at the start was the *correct* call.
Killed a bad plan with data before deploying. The whole framework worked there. Why didn't it catch the entry-filter overfit? Because the backtest *was* the in-sample fit — there was no separate test set. **The discipline of "backtest before deploy" only protects against bugs in the simulator, not against fitting noise.**

## What we keep from this loop
- `scripts/backtestTranche.js` — works, useful for next exit-rule experiments
- `scripts/entryFilterSweep.js` — useful but **must be used with train/test split, not best-of-N**
- `scripts/winnerLoserDiff.js` — useful sanity check; result here ("medians identical") was the warning we should have heeded
- `scripts/testFilterWire.js` — wiring smoke test, keep
- Lesson governance code (`storeLearningRun` ≥30 gate, MAX_ACTIVE rotation) — independent of this loop, keep
- Daily summary code (`/summary`, hourly tick) — independent, keep
- `degen_filtered_v1` strategy row — left in DB as `enabled=0`. Available if we want to reuse the filter fields with different thresholds.

---

# Lessons — degen_favor_v1 cycle (2026-05-26)

## What happened
1. Pattern analyzer (patternAnalyzer.js) found `holderChange5m > +5%` as the only bucket with positive avg PnL on both TRAIN (+13.7%) and TEST (+10.5%).
2. Backtest with pre-stated thesis passed all 3 criteria on TEST (n=15): avg +6.64%, cat 0%, WR 46.7%.
3. **Deployed. 93 trades later: avg -4.34%, WR 22.6%, PF 0.66x. Worse than baseline.**

### L9. n=15 test samples are noise, not signal.
The favor filter "passed" on 15 TEST trades. 15 is far too few — even a coin flip produces 46% WR on n=15 regularly. **Minimum credible TEST size: n≥50, preferably n≥100.**

### L10. Data coverage determines filter power.
`holderChange5m` was present on only 17% of TEST trades (59/342). The filter was effectively operating on a tiny fraction of candidates. A filter that can't see most of its data is guessing on the rest. **Pre-flight: verify ≥70% data coverage before deploying any feature-based filter.**

---

# Lessons — GMGN deep analysis + degen_sw_v1 (2026-05-27)

## What happened
1. Discovered GMGN `stat`, `wallet_tags_stat`, `dev` fields are captured at 100% coverage but never analyzed.
2. Eyeball test: compared 18 moonshots vs 18 catastrophes on all GMGN fields.
3. **Most "mechanical" theses died:**
   - `creator_token_status == "creator_close"` → 17/18 moonshots ALSO had this. CTO pattern: dev sells, community pumps.
   - `creator_created_count` → serial creators MOONSHOT more, not less. Horatio (+434%) creator made 450 tokens.
   - `bot_degen_rate` → full overlap (range 0.01-0.77 on both sides).
   - `bundler_pct` → full overlap.
4. One survivor: `smart_wallets` count. Moonshots had more (median ~3 vs ~0.5 for catastrophes).
5. Industry web search confirmed: GMGN smart wallets is a known alpha signal. Industry WR benchmark: 30-40%.
6. Pattern analysis on `smart_wallets` buckets:
   - `sw=0` is consistently terrible (TRAIN: -5.6% avg, TEST: -14.3% avg)
   - `sw>=1` (reject zero): TRAIN neutral (pfBaseΔ +0.01x), TEST improves (pfBaseΔ +0.15x, catΔ +3.5pp, moonshot 100%).
7. Pre-stated threshold was `sw>=3` but advisor recommended `sw>=1` as strictly more defensible (TRAIN-neutral vs TRAIN-harmful). Documented swap.
8. **Deployed as `degen_sw_v1` with `min_smart_wallets: 1`.**

### L11. "Dev dumped = rug" is empirically wrong for meme tokens.
CTO (community takeover) is common — dev sells and community pumps. 94% of our moonshots had creator_close status. **Don't assume dev behavior predicts token outcome on pump.fun graduates.**

### L12. "Serial creator = rugger" is empirically backwards.
Horatio (+434%) had creator_created_count=450. MOGMAN (+360%) had 2179. @GROK (+163%) had 9176. Serial creators sometimes produce moonshots. **Test assumptions against data before building features around them.**

### L13. Train/test asymmetry (filter hurts TRAIN, helps TEST) ≠ overfitting.
Overfit filters look great on TRAIN and collapse on TEST. A filter that's neutral on TRAIN and helps TEST suggests a regime shift — the signal got stronger in recent data. For `sw>=1`: recent trades have more sw=0 tokens (20% vs 12%) and those tokens perform worse (-14.3% vs -5.6%). **When you see this pattern, check whether the underlying data distribution shifted between time periods.**

### L14. 100% data coverage changes everything.
All previous filters (vol5m, holderChange5m, priceChange5m) had 17-35% coverage. GMGN stat/wallet_tags_stat fields have 100% coverage. A filter that can see ALL candidates is fundamentally different from one that sees 1 in 5.

### L15. Industry benchmarks matter.
Pump.fun has 98.6% rug rate (Solidus Labs). Our 9% catastrophe rate means basic filters already work. Profitable meme bots run 30-40% WR. Our 26.7% is below but not dramatically — the gap is ~3-13pp, not 50pp. **Know the ceiling before optimizing toward it.**

## Pre-stated revert criteria for degen_sw_v1
- After 30 live trades: if pfBase < 0.80x (TEST baseline), revert.
- After 100 trades: if pfBase < 0.85x, revert.
- **This is the LAST entry-filter experiment.** If sw>=1 fails live, the next move is either: (a) build dev-wallet live monitoring as a post-entry exit signal, or (b) declare entry-filter optimization exhausted on this signal mix.

---

# Lessons — bonding curve monitor incident (2026-05-30)

## What happened
1. Phase 1 bonding curve monitor (commits d75b128, d2119a4) added `startWebsocket()` to **server mode** so the Helius WS would run on the VPS (previously WS only ran in standalone mode, which the VPS doesn't use).
2. The WS `logsSubscribe` on the full pump.fun program is a firehose — 484 alerts/hr means tens of thousands of underlying TRADE events.
3. Helius started returning **429 (rate limited)** on the WS upgrade. The pre-existing `feeClaim.js startWebsocket()` reconnect is a **fixed 5s retry with no backoff** (lines 98-102) — so it hammered Helius every 5s for ~22 hours: **15,692 reconnect attempts logged**.
4. The Helius key is **shared with Meridian** (user's other live bot). Meridian was also seeing 429s.
5. Reverted commit d2119a4 (server-mode WS) to stop the bleed. Charon's core `degen_sw_v1` is HTTP-fed from the signal server, so it kept trading unaffected (20 positions/2h through the incident).

## L16. A shared API key is a shared blast radius.
Adding a high-volume consumer (WS firehose) on a key shared with a live system (Meridian) degraded both. **Before adding any new high-volume API consumer, check what else uses the key.** The CLAUDE.md rule "VPS is personal projects only" exists for exactly this isolation reason.

## L17. Diagnose causation before assuming it.
First instinct was "my WS spam caused Meridian's 429s." Checking the timeline disproved it: Meridian's 429s fire on a **precise clock-aligned 5-min cadence** (20:45:00, 20:50:00, 21:00:00...) — its own scheduled wallet-poll exceeding the shared key's quota. They predated Charon's WS and continued after it died. Charon added load but was not the root cause. **Pull the actual timestamps; don't infer causation from coincidence.**

## L18. Any reconnect loop needs exponential backoff + jitter + cap.
`feeClaim.js startWebsocket()` retries every fixed 5s. Dormant for months because WS never ran in server mode; the moment it did + hit 429, it became a 5s DoS against our own key. **Before re-enabling any WS here: add backoff (5s → cap 60s), jitter, and a max-retry circuit breaker.** This is unfixed as of the revert — do NOT re-enable the WS without fixing it first.

## L19. The bonding curve monitor is PARKED, not dead.
Phase 1 proved the detection works (1.8x graduation lift at 3 SOL, 3.3x at 10 SOL threshold; graduated tokens had median 15.5 SOL in vs 8.2 for non-grad). But it **cannot run on the shared Helius key** — it needs its own dedicated key (or a paid Helius tier with higher WS/credit limits). This is a prerequisite for Phase 3, not an optional nicety. Surface as a cost/key decision to the user before resuming.

## L20. The dedicated free Helius key burns out in ~a day, and getHealth lies about it.
After moving the firehose to a dedicated free key (`d7ec735f…fa481f`, 1M credits/mo), Phase 2.7 path-tracking captured **zero** rows (`bc_tracks` empty). Root cause was NOT the code (the mcap/startTrack fixes in 0050392 are fine) — the key's **1M free credits are exhausted**. Diagnosis that worked: `getHealth` returns `ok` even when over budget (cached/free), but any real method exposes it — `getLatestBlockhash` → `{"code":-32429,"message":"max usage reached"}`. The `logsSubscribe` firehose on the full pump.fun program 429'd at startup (3× at 22:47/22:49/22:52), the L18 circuit breaker correctly stopped retrying, and the monitor went silent with no error spam after. **Takeaways:** (1) the pump firehose consumes ~1M Helius credits in under a day — free tier is not sustainable for continuous BC monitoring; (2) to verify a Helius key is actually live, call a *paid* RPC method, never `getHealth`; (3) silent monitor + empty table + no recent `[ws]`/`[bc]` log lines = check credits/429 first, before touching parsing/mcap code. Resuming Phase 2.7 needs either a paid Helius tier (Developer $49/mo, 10M credits) or a credit-cheaper stream (LaserStream gRPC / a non-Helius provider). This is a spend decision for the user.

## L21. Free RPC keys cannot sustain a full-firehose subscription — the constraint is structural, not provider-specific.
Two providers, same death: Helius free (1M credits) lasted **~1 day** of pump `logsSubscribe`; FluxRPC free key lasted **~24 minutes** before being invalidated (`{"error":"invalid api key"}` + WS 401 on reconnect — note: NOT a 429/quota message, the key was outright revoked). The `logsSubscribe(["all"])` firehose is ~200 GB/day / ~1k msg/s; no free tier tolerates that for long. **Conclusion: continuous bonding-curve monitoring is incompatible with free RPC.** Phase 2.7 produced a clean but small snapshot (n=387 tracks, 21 at netSol≥20) that is directional-only. To reach a shippable n≥50–100 requires a *paid* stream — and the efficient choice is Helius's `mentions` filter (~3% the bytes) on a paid Developer tier ($49/mo), NOT another free firehose key. **Stop trying free keys (cat-and-mouse, burns a deploy each time). Surface the paid-tier decision to the user; do not self-serve another free key.** Also: the reconnect path correctly logged the 401 but kept looping silently — when a key is *revoked* (not rate-limited), reconnect can't recover, so the monitor should alert-and-stop rather than loop. Minor: a revoked key returns 401, which our circuit breaker (429-only) doesn't catch — consider treating repeated 401s as a hard stop.

## L22. We spent 2 weeks tuning the strategy the owner built to LOSE. (Codebase review, 2026-06-01)
A full multi-agent review of the repo (intent + public/private boundary + missing cogs, triple-verified against code) reached one structural conclusion: **the public repo is a CLIENT ONLY; the alpha is a withheld private signal server.** Verified facts:
- README.md:20 — "without it [the signal server at api.thecharon.xyz] Charon has nothing to screen." The real-time Pump.fun fee-claim/graduated/trending aggregation is server-side and NOT in the repo. The client computes no proprietary alpha (generic LLM prompt llm.js:101-128, commodity gate thresholds, vanilla Jupiter route, no MEV protection).
- `degen` is the only `use_llm:false` strategy (connection.js:390) → auto-BUY at confidence=100 the instant filters pass (orchestrator.js:44-59). It is seeded **disabled**, with the loosest gates. We enabled and tuned ONLY degen + derivatives → we benchmarked the **deliberate floor**, never the system.
- The owner's default `sniper` is seeded **enabled=1** (connection.js:266) but requires `require_fee_claim:true` + `min_source_count:2` + `use_llm:true` — all of which need the **private server**. So we could never run the owner's real path. `smart_money` (use_llm:true, min_holders:1000) likewise dormant.
- **Our best experiment isn't in version control.** `degen_sw_v1`/`degen_favor_v1` were created via live SQL on the VPS — they are ABSENT from connection.js (only `degen_filtered_v1` is seeded, line 478). A clean checkout loses them.

**Two real bugs surfaced by the review (independently re-verified):**
- **Slippage bug:** `JUPITER_SLIPPAGE_BPS` (config.js:38, default 300) is imported but NEVER set on the Jupiter `/order` URL (liveExecutor.js:65-71 sets only inputMint/outputMint/amount/taker). Live fills silently accept Jupiter-default slippage with no max-slippage abort. One-line fix.
- **Bonding-curve handler orphaned:** `setBondingCurveHandler` is exported (bondingCurve.js:178) but NEVER called → `candidateHandler` stays null → BC alerts never route to the orchestrator/execution. The whole Phase 1-2.7 monitor is structurally observe-only by omission, not just by design.

**The takeaway:** no amount of degen entry-filter/exit tuning could ever have worked — it optimizes the LLM-bypassing crude floor against a signal mix whose quality is owned by someone else. The honest fork: (a) get signal-server access and benchmark sniper+LLM as designed, or (b) declare the public client non-viable standalone. The one genuinely buildable net-new edge that doesn't need the server is **dev/creator-wallet dump detection as a post-entry EXIT signal** (completely ABSENT; it's the #1 Pump.fun rug signal and, as an exit, sidesteps the moonshot-clipping that doomed every entry filter).

## L23. We already had the keys — and never ran the real strategy. (Roadmap review, 2026-06-01)
A judge-panel design workflow (4 strategies, scored synthesis, 3 adversarial stress-tests — one returned survives:FALSE) corrected several beliefs and set the path forward (full plan: .context/ROADMAP.md):
- **Signal-server access is LIVE.** `SIGNAL_SERVER_URL`/`SIGNAL_SERVER_KEY` are set in the VPS `.env` and `/api/signals` returns 200. We were never missing the owner's feed — we consumed it the whole time, but routed it through `degen` (use_llm:false, loose gates) instead of the owner's designed-to-win `sniper` (require_fee_claim:true, min_source_count:2, use_llm:true, seeded enabled=1). **The sniper+LLM path has NEVER run.** First move: run it in dry_run — FREE, zero new code.
- **Meridian is NOT pump alpha.** Verified: it's a PAPER Meteora-DLMM agent that never went live; `deployer-blacklist.json` is EMPTY. Harvest its plumbing (Claude client, blocklist load/save pattern) only — its trading brain transfers zero alpha. (Earlier "Meridian already solved dev tracking" was wrong.)
- **Dry-run PF overstates live PF.** `positions.js:43` records entry_price = candidate quote (zero slippage, no gas/priority). Treat dry-run as an UPPER BOUND; require a margin (e.g. dry-run ≥1.3x to believe >1.0x live).
- **Corrected GO bar:** PF base > **1.0x NET of gas+priority+slippage** — NOT "beat the 0.73x degen floor" (beating a designed-to-lose floor proves nothing).
- **The creator-dump EXIT is more fragile than it looked:** no creator-wallet WS = no latency edge over PANIC_SL/LIQ_DRAIN (same 10s poll); sampled graduated tokens show `devHoldingsPercent:0` (dev already out before we see the token — may fire on an empty set); conditioned-dump cases have collapsed liquidity so modeled FILL (not detection price) may beat existing stops by ~zero. Precondition-check on backfill BEFORE building. L11: 94% of moonshots had dev already sold — naive "dev sold = exit" clips 94% of winners.
- **Hard prerequisite before any new RPC poller:** isolate a dedicated Charon execution key — new consumers default to Meridian's shared key (config.js:21), re-arming L16/L20/L21.
- **Add a STOP gate above everything:** if neither track clears PF>1.0x net within N days, shut down and don't trade. A 30s-poll + LLM-batch + Jupiter client has neither known edge (block-time speed, private order flow) in a 98.6%-rug arena. Run Phase 0 expecting it might say STOP — and obey it.

## L24. Per-strategy data review: the "sniper never ran / is the untested winner" thesis is FALSE. (2026-06-01)
Queried `dry_run_positions` by `strategy_id`. Closed-trade performance:
| strategy | n | WR% | avg | PF base | cat% | period |
|---|---|---|---|---|---|---|
| **sniper** | 81 | 32.1 | −8.4% | **0.34** | 33.3 | 05-11→05-17 (FIRST week) |
| degen | 1454 | 26.7 | −3.3% | 0.74 | 10.4 | 05-16→05-27 |
| degen_sw_v1 | 597 | 29.3 | −2.0% | **0.82** (best) | 10.4 | 05-27→06-01 |
| degen_filtered_v1 | 55 | 25.5 | −0.3% | 0.59 | 3.6 | — |
| degen_favor_v1 | 95 | 22.1 | −4.6% | 0.56 | 7.4 | — |
- **`sniper` + LLM WAS tested** — 81 trades over the project's first week, with the LLM active (1,822 `llm_decisions` and ALL 1,700 `llm_batches` fall in that window; batches stopped once degen/use_llm:false took over). The roadmap/panel claim "the designed-to-win sniper+LLM path has never once run" is empirically **false**. (smart_money and dip_buy genuinely never ran.)
- **But it's not a clean test, AND it still lost.** The live sniper row that ran had `sl_percent:-75` and **no panic_sl/liq_drain** (those rug protections didn't exist yet in that early regime), plus a different mcap band (50K–500K). That broke exits explain much of the 33% cat rate (only 6/81 hit the −75 SL). HOWEVER, normalizing losses to a proper −25% SL only lifts sniper from −8.4% → **−3.4% avg ≈ degen's −3.3%**. So the **LLM screening added NO edge** — the "quality" path is no better than the crude floor once exits are equalized.
- **Implication for the roadmap:** Phase 0 was framed as "run the never-tested winner." Correction: it was tested, the LLM didn't help, and every strategy in the client is −EV (best is degen_sw_v1 at PF base 0.82, still <1.0x). The edge is **absent, not mis-selected.** A clean apples-to-apples sniper re-run (sniper entry + LLM + the CURRENT hardened exit stack) is still worth one cheap pass since the original had broken exits — but expectations are low (~−3.4% normalized), and this materially raises the weight on the STOP gate (L23). Do NOT assert sniper is the untested path to profit.

## L25. The early-entry (BC netSol≥20) signal PASSED an honest out-of-sample gate — the project's first. (2026-06-01)
Validated `bc_tracks` netSol≥20 at n=38 clean ended tracks (up from 27), pre-committed gate = trail30 / 6% haircut / PF>1.0x NET & avg>0:
| exit | flat 6% | flat 12% | depth-aware |
|---|---|---|---|
| **trail30** | **PF 1.66, avg +11.5%, WR 39%** | **1.26** | **1.44** |
| trail20 | 1.07 | 0.73 | 0.89 |
| trail40 | 1.06 | 0.84 | 0.94 |
- **trail30 clears >1.0x under every cost model** (flat 6/12% and the new depth-aware book-fill via `last_curve_sol`). Held across three windows: 6%-haircut PF went 1.88 (n=27) → 1.66 (n=38) — DECAYED as expected out-of-sample but did NOT collapse. This is the first signal in the project to survive an honest, cost-adjusted, out-of-sample bar (degen 0.74, sniper 0.34, all entry filters <baseline).
- WR ~39% vs 27% baseline = the netSol filter genuinely SELECTS better tokens (43% graduation vs 5%), not tail-clipping.
- **Caveats:** only trail30 works (trail20/40 marginal — result is exit-param sensitive, though trail30 was best at all three sample sizes, so consistent not cherry-picked); depth-proxy coverage only 11/38 (rest fall back to flat 6%); n=38 is modest.
- **The wall:** "signal validated" ≠ "tradeable." Executing early entry needs on-bonding-curve BUY code that does not exist (buying only at graduation throws away the edge). That execution gap — not signal quality — is the next obstacle, and the only one now worth building toward.
- **Infra:** ran on Helius mentions mode (~24 GB/day, ~8× lighter than the FluxRPC firehose that died), with the now-restart-safe auto-stop (DB row-count + persisted deadline) — confirmed working: it fired immediately on a reboot when the DB already held 55≥45. Credits bounded, key healthy. The L20/L21 drain pattern is fixed.

## L26. PRE-COMMITTED latency gate (written before the data, autonomous mode). (2026-06-01)
Running a bounded collection of entry-latency-aware BC tracks (`entry_delayed_mcap_sol` = price ~5s after alert). A netSol≥20 alert means the token already pulled 20+ SOL, so the price 5s later may be +15–40% above alert — this gate can legitimately flip PF 1.66 to <1.0, and that is the point. **Kill line, fixed now so it can't be rationalized post-hoc:**
- Metric: **trail30**, charging **entry-slip** (delayed/instant − 1) **+ 6% round-trip cost** + depth-aware loss haircut, on **n≥30 latency-aware netSol≥20 tracks**.
- **GO** (build Phase 2 dry-run execution) only if **PF > 1.0x net AND avg > 0**.
- **0.85–1.0x** → inconclusive, collect more, do NOT build.
- **< 0.85x** → the edge was a measurement artifact (fill latency eats it) → STOP, do not build on-curve execution.
- Required reporting at re-gate: count of tracks with NULL `entry_delayed` (tokens that died/graduated inside 5s) and the explicit decision to drop/keep them; and a plain statement that the entry-slip haircut is an approximation (it does not fully re-baseline the trail/SL path) — adequate for go/no-go only.
- Autonomous-mode hard stops (do NOT cross without the user): any paid subscription ($49 RPC), any live real-money trade, any new unbounded firehose.

## L27. Latency gate: INCONCLUSIVE (not GO, not KILL) — the data can't settle it, so it's a user decision. (2026-06-02)
Ran the L26 latency gate on n=32 latency-aware netSol≥20 tracks (`entry_delayed` = price ~5s post-alert). It does NOT resolve, because two estimators are oppositely biased and stored data can't break the tie:
- **Subtract-slip** (charge positive entry-slip off the instant return): **PF 0.57** — but over-penalizes the high-slip winners (the fast movers you fill +30–100% higher; the lottery tail).
- **Method B / exact re-base** (`exit_mcap/delayed − 1`): **PF 2.79** — but over-credits tokens that *peaked within the 5s window* (their recorded trail exit was computed off the instant-baseline peak, not the post-delayed-entry peak).
- The advisor's **arming-hybrid was degenerate**: `peak_mcap` is the global max and `entry_delayed` is one sample, so `peak ≥ delayed` is a near-tautology → 0/32 never-armed → it collapses to method B (2.79). No discrimination.
- **True PF is bracketed [~0.57, ~2.79]** — uselessly wide. Resolving it needs intra-path peak *timing* relative to the 5s mark, which is not stored.
- **Free diagnostic:** `entry_delayed/peak_mcap` median **0.46** (fills sit well below the peak; 18/32 below half-peak) → leans method-B-defensible / not obviously dead.
- **BUT the perfect-fill ceiling is decaying:** instant-entry PF went **1.88 (n=27) → 1.66 (n=38) → 1.15 (n=32)** across samples — the same out-of-sample decay signature that killed degen_filtered (1.15→0.54), sw_v1 (1.17→0.91), favor (+6.6→−4.3). The ceiling is collapsing toward 1.0 *independent of latency*.
- **Decision (NOT taken autonomously, per L26 hard-stops + L5/L24):** definitively resolving the bracket requires building a delayed-entry RE-SIMULATION (a 2nd virtual position re-based at the fill price with its own trail/SL) + another bounded free re-collect + re-gate (days, more of the free key). And even a GO there lands at the next wall (on-curve execution build + $49 RPC + real-fill dry-run vs block-time snipers). "Collect one more cycle because it's not definitively dead" is the exact trap this project has repeated — so this is a stop-and-ask. Bot left on `degen_sw_v1`.

## L28. Early-entry edge is DEAD — honest delayed-entry re-sim settles it. KILL. (2026-06-03)
Built the delayed-entry re-simulation (2nd virtual position re-based at the realistic fill price, own peak/SL/trail — removes both estimator biases of L27). Collected n=30 ended re-sim tracks (free key, no paid RPC). Decisive result:
- **ALL netSol≥20, trail30, +6% cost: PF 0.54, avg −9.5%, WR 33% → KILL** (pre-committed bar was PF>1.0x net).
- Early n=10 peek was PF 1.23 → collapsed to 0.54 at n=30. Same small-sample regression as every prior signal (degen_filtered 1.15→0.54, sw_v1 1.17→0.91, favor +6.6→−4.3, instant-ceiling 1.88→1.66→1.15).
- The honest re-sim lands the L27 bracket [0.57, 2.79] at the **pessimistic end (~0.54)**. The 1.66/2.79 readings were artifacts of assuming you fill at the alert price — you can't; by the time you'd fill, the fast movers (the lottery tail) have already run.
- **No token characteristic rescues it** — every segment <1.0x: netSol 20–30 = 0.79 (best), entry-slip 0–15% = 0.73, vel≥500 = 0.63. Sub-selecting doesn't cross break-even.
- **This is the process working, not failing:** killed the project's last +EV candidate for the cost of a bounded *free* collection, BEFORE building on-curve execution + paying $49 RPC + risking live SOL. That avoided build was the whole point of the discipline.

## TERMINAL CONCLUSION (after ~2,580 trades, 1,680 BC tracks, 28 lessons)
Trench *trading* is not doable with anything reachable from this client:
- Late-follower momentum (degen/sniper/smart_money + all 5 entry filters): −EV, proven.
- LLM screening (sniper): added zero edge vs the crude floor.
- Early-entry / bonding-curve front-running (netSol≥20): signal is real for *graduation* (8× lift) but the trade is −EV once you charge realistic fill latency — you cannot buy the winners at alert price.
The edge isn't mis-selected — it's absent at this latency tier (30s poll / post-detection fill) in a 98.6%-rug, negative-sum arena. The durable money is the house and block-time insiders, not the follower. Next move is a real pivot (stop trading / different game), not another trading iteration.

## L29. Launcher hypothesis tested (economics model): −EV without distribution. (2026-06-03)
Tested "be the house / pump.fun creator (fee collection)" via a transparent EV model (scripts/.. ad-hoc; fee 0.95% of volume, cost ~0.07 SOL/launch, fee|grad ≈$323 @200 SOL vol, fee|tracked ≈$42, grounded in our 2,525 tracks' 2.7% tracked-cohort graduation + public base rates). Result:
- **−EV at base rates:** P(grad)~0.5–1.15% (pump.fun base) → −$7 to −$9/launch (−$20–27K/mo @100 launches/day).
- **Break-even needs P(grad) ≥ 2.6%** (2.5–5× base), OR ~3× higher fees-per-graduate.
- The ONLY lever to lift your tokens above base = **distribution (an audience that buys what you launch)** — and research shows bot-launched tokens graduate LESS (artificial volume detected), so pure automation pushes you BELOW base.
- **Same structural verdict as trading:** engineering is the easy part; the edge is owned elsewhere. Trading → speed/order-flow (insiders). Launching → attention (audiences). Code can't manufacture attention; automation damages it.
- Conclusion: launching is +EV ONLY with pre-existing distribution. That's a marketing/community asset, not an engineering one — out of scope for a code-built bot. Model is sensitive to fees-per-graduate; qualitative conclusion (distribution is the binding constraint) is robust.

## Pre-conditions for the next optimization attempt

1. Expand `snapshot_json` capture: ✅ DONE (entrySignals block, commit b82c4e9).
2. Reserve a chronological holdout: ✅ DONE (70/30 split, used consistently since L2).
3. Compute W/L median + distribution overlap before sweeping: ✅ DONE (via patternAnalyzer.js).
4. Pre-state the filter and thesis: ✅ DONE (sw>=3 stated, sw>=1 shipped with documented rationale).
5. Pre-state go/no-go criteria: ✅ DONE (pfBase thresholds above).
6. Pre-flight coverage: ✅ DONE (100% for GMGN fields, verified).
7. **NEW: Verify the filter doesn't kill moonshots** — eyeball top-18 before any backtest.
8. **NEW: Check TRAIN direction** — if filter hurts TRAIN, investigate regime shift before shipping.
