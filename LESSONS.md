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

## Pre-conditions for the next optimization attempt

1. Expand `snapshot_json` capture: ✅ DONE (entrySignals block, commit b82c4e9).
2. Reserve a chronological holdout: ✅ DONE (70/30 split, used consistently since L2).
3. Compute W/L median + distribution overlap before sweeping: ✅ DONE (via patternAnalyzer.js).
4. Pre-state the filter and thesis: ✅ DONE (sw>=3 stated, sw>=1 shipped with documented rationale).
5. Pre-state go/no-go criteria: ✅ DONE (pfBase thresholds above).
6. Pre-flight coverage: ✅ DONE (100% for GMGN fields, verified).
7. **NEW: Verify the filter doesn't kill moonshots** — eyeball top-18 before any backtest.
8. **NEW: Check TRAIN direction** — if filter hurts TRAIN, investigate regime shift before shipping.
