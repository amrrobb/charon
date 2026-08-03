---
date: 2026-08-03
topic: liquidity-gate-forward-test
status: RUNNING (started 2026-08-03 05:19 UTC)
---

# Forward Test — Liquidity Gate + Loose Trail (Kaiser/Charon)

**Pre-registered before data collection. Do not edit the kill conditions after
results start arriving — that is the whole point of writing them down first.**

## Hypothesis

On Kaiser/Charon, entry-filtering to `liquidity >= $13k` combined with early
trailing arm (5%), a loose trail (20%), and a 30-minute max hold produces a
**non-negative** book going forward.

## What changed

| Setting | Before | After | Source |
|---|---:|---:|---|
| `tp_percent` (arms trailing, NOT a sell) | 30 | **5** | our sweep |
| `trailing_percent` | 10 | **20** | our sweep + user's runner argument |
| `max_hold_ms` | 0 | **1800000** (30m) | Kaiser |
| `min_liquidity_usd` | — (didn't exist) | **13000** | our backtest + Kaiser BACKTEST_EDGE |

Code: `d082f72` on `feat/liquidity-gate` — adds the `min_liquidity_usd` gate to
`filterCandidate()` (13 lines). No other code change. Rollback tag on VPS:
`deployed-2026-08-03-liqgate-pre`. Config backup: `degen_sw_v1.config.bak.*.json`.

Mode: **DRY_RUN** (`trading_mode=dry_run`, 0 live positions ever recorded).

## Backtest basis (n=5,322 closed `degen_sw_v1`, replayed on `position_snapshots`)

| Config | SOL | WR | HALF-1 | HALF-2 |
|---|---:|---:|---:|---:|
| live before (arm30 tr10) | −14.23 | 25.8% | −7.86 | −6.36 |
| arm5 tr20, **no** liq gate | −9.34 | 26.5% | −5.63 | −3.71 |
| arm5 tr20 + **liq ≥13k** | **+0.10** | 34.7% | ~+0.05 | ~+0.07 |

Baseline reproduced the recorded book exactly (−14.23 vs −14.21 actual), so the
replay harness is trusted. Liquidity was the only **monotonic** entry
discriminator found: WR 20.5% (<$5k) → 25.1% ($5–10k) → 26.1% ($10–15k) →
32.7% ($20k+). The $5–10k bucket alone carried −9.04 SOL of the −14.2 SOL book.

## Kill conditions (PRE-REGISTERED)

Evaluate at **≥150 new closed positions** on the new config.

| Metric | PASS | KILL |
|---|---|---|
| Book (SOL) | ≥ 0 | < −0.5 |
| Win rate | ≥ 30% | < 25% |
| Trades/day | ≥ 5 | < 2 (gate too strict → no data) |

If KILL on any row: revert config from backup, `git checkout deployed-2026-08-03-liqgate-pre`,
and record "liquidity gate did not replicate forward" as the outcome. Do not
loosen the threshold and re-run — that is the best-of-N regression LESSONS.md L1
already documented.

## Known limitations — state these when reporting the result

1. **Thin edge.** +0.10 SOL over 826 backtest trades ≈ **+0.0001 SOL/trade**.
   Real memecoin slippage is 1–3% per round trip. This edge may not survive
   execution costs at all. Dry-run `pnl_sol = size_sol × pnl_percent` models
   **zero** slippage.
2. **Small n.** Only ~8–16% of candidates pass the gate. Expect 2–4 trades/day,
   so 150 trades takes roughly 5–8 weeks.
3. **ATR dynamic SL NOT included.** Kaiser's ATR stop added ~0.9 SOL in backtest
   but was measured with a *proxy* (snapshot volatility), not his real Jupiter
   candle feed. Deliberately excluded to keep this test to one code change.
4. **In-sample origin.** The 13k threshold was chosen from this same dataset.
   The time-split is a replication check, not a true holdout. This forward test
   IS the holdout.
5. **Runner thesis not supported.** Runners (≥+100% peak) are not separable at
   entry: median liquidity $10,010 for runners vs $9,767 for non-runners. The
   gate *raises* WR but *lowers* runner rate (3.79% → 1.24%). This config wins by
   many small wins, not one moonshot. 3,737 losers at −16.8% would need a single
   **+6,000%** win to cover; best ever observed in 6,999 positions was **+516%**.

## Open positions at switchover

10 paper positions were open. They keep their original per-position tp/sl
(stored at open), so they close under the OLD config. **Exclude positions opened
before 2026-08-03 05:19 UTC from the evaluation.**

## Evaluation query

```sql
SELECT COUNT(*) n,
       ROUND(SUM(pnl_sol),3) sol,
       ROUND(100.0*SUM(CASE WHEN pnl_percent>0 THEN 1 ELSE 0 END)/COUNT(*),1) wr
FROM dry_run_positions
WHERE status='closed' AND strategy_id='degen_sw_v1'
  AND opened_at_ms > 1785734340000;  -- 2026-08-03 05:19 UTC
```
