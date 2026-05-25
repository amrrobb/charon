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

## Pre-conditions for the next optimization attempt

1. Expand `snapshot_json` capture: vol1h, grad_age, saved-wallet count, twitter narrative score, holder change rates. **The current 2-feature toolkit is too thin to find real signal.**
2. Reserve a chronological holdout (e.g., last 30% of closed positions = test set). Never look at test until after picking the filter.
3. Compute W/L median + distribution overlap *before* any threshold sweep. If features overlap heavily, **don't sweep**.
4. Pre-state the filter and its thesis in writing. Reject sweep-derived thresholds without independent rationale.
5. Pre-state the go/no-go criteria for live performance.
6. Pre-flight verify the filter actually fires on the data shape it'll see in production.
