---
date: 2026-06-05
topic: meridian-dlmm-pivot
focus: Pivot Charon (dead -EV trenches) → Meridian DLMM + Meteora limit orders; modular config; council agents; cheap-cron/rare-LLM
---

# Ideation: Charon → Meridian DLMM + Limit-Order Pivot

## Codebase Context (grounding)
- **Charon** (pump.fun trench trader): conclusively −EV over ~2,580 trades / 31 lessons (PF 0.73). Dead. Reusable parts: execution/router, telegram, db, learning/lessons (the self-improving loop). Dead parts: signals/{axiom,bondingCurve,graduated} (trench-specific).
- **Meridian** (Meteora DLMM maker, JS, `@meteora-ag/dlmm` SDK): 1,004 closed deploys / 296 pools. Overall dry-run PF ~0.97, WR 59–69% (INVERTED shape — many small wins, rare big losses, worst −$227). `single_sided_reseed` PF 1.58 **but 93% from 3 of 77 pools** (ex-top-3 = 1.04, break-even); `spot` 1.01 dry → **0.94 live** (dry-run roughly honest, unlike Charon's collapse); `bid_ask` 0.38–0.59 (the dog). **Live era PF 0.75** (mostly bid_ask; spot alone 0.94). Hold 0–30m loses −$311; 2–8h holds +$140 @ WR 73%. Currently runs 2 deliberately-uncorrelated agents (Agent1: bins70-150 spot30/bidask70 1h conservative; Agent2: bins30-70 full-spot 5m balanced).
- **Meteora limit orders**: single-sided bins, fill passively, earn 50% of fees, **NO impermanent loss**, not-guaranteed-fill. A pool is EITHER LP-mode OR limit-mode. single_sided ≈ limit orders — best dry-run signal, **never run live**.
- **evonic**: LLM multi-agent ORCHESTRATION framework (A2A, safety) — NOT a genetic/evolutionary optimizer, no backtester, no perf-based selection. Orchestration only.
- **Hard-won discipline (31 lessons)**: dry-run overstates, small samples regress, pre-committed kill-gates, held-out validation; the validation harness itself is the most valuable asset.

## Ranked Ideas (survivors)

### 1. Edge-Validation Gauntlet — settle the pivot's foundation BEFORE building (free → tiny)
**Description:** (a) FREE: re-run `single_sided` in dry-run in the current June regime on a *held-out, non-top-3* pool set + autopsy the 3 winner pools' ex-ante features (fee tier, bin step, vol/TVL, volatility) and test if they predict the other 74 pools OOS. (b) If it generalizes, a *tiny* live probe (≤0.1 SOL) on held-out pools with a pre-committed bar. Pre-commit: reproduce PF >1.0 net on non-top-3 pools, else KILL the pivot.
**Rationale:** The entire pivot rests on whether single_sided's 1.58 is a learnable property or 3 lucky pools (ex-top-3 = 1.04). Settling it costs ~$0 and prevents building on an overfit headline. Dry-run is roughly honest here, so the test is informative.
**Downsides:** Could kill the pivot (that's the point). Needs the held-out discipline applied honestly.
**Confidence:** 90% **Complexity:** Low **Status:** Unexplored

### 2. Kill the dog + hold-time discipline — cheap backtest wins on existing data
**Description:** Hard-disable `bid_ask` (PF 0.38–0.59) behind a flag and counterfactually reallocate its capital to spot/single_sided. Enforce the empirical hold-time edge: suppress <30m exits (which bled −$311) absent a hard stop; mandatory exit by ~8h; wrap in a volatility breaker that halts NEW deploys in hostile regimes. All re-simulated over the existing 1,004 deploys.
**Rationale:** Negative-EV pruning is the highest-confidence, zero-new-signal improvement — removing the known loser + the worst hold-time bucket likely lifts blended PF from 0.97 toward >1.0. Pure policy, no capital.
**Downsides:** Hold-time/vol rules risk mild overfit — validate on time-split.
**Confidence:** 80% **Complexity:** Low **Status:** Unexplored

### 3. Modular DLMM strategy engine — the "enable limit-order / LP / both" build
**Description:** A `StrategyModule` interface (`eligible / plan / manage / exit`) with pluggable units (spot-LP, single-sided/limit, others) in a registry; a deterministic **Pool-Mode Router** that tags each pool LP-mode vs limit-mode (disjoint sets) before any LLM call; a **Unified Position** abstraction that models limit orders' UNFILLED→FILLED lifecycle + zero-IL correctly; **Config Schema v2** (the 2 agents become 2 config profiles); and a thin **Charon→Meridian infra port** (reuse execution/telegram/lessons, drop trench signals).
**Rationale:** Directly delivers the user's modular ask. Mode-routing as a cheap pre-LLM filter cuts tokens. Build ONLY after #1 validates an edge.
**Downsides:** Real engineering; premature if #1 fails. Limit-order PnL must be modeled mode-aware or reporting is silently wrong.
**Confidence:** 70% **Complexity:** Medium–High **Status:** Unexplored

### 4. Replay harness that runs the LIVE strategy code
**Description:** A backtest/replay module that feeds recorded pool snapshots through the EXACT `StrategyModule` code paths the live engine uses — swapping only data-source and execution adapters (real swap vs modeled fill; single-sided gets a fill-probability). Outputs per-pool/per-strategy PF with held-out splits baked in.
**Rationale:** Every prior PF claim died OOS because backtest code diverged from live code with no holdout. Making replay run the live modules verbatim closes the sim-to-live gap — the project's #1 recurring failure.
**Downsides:** Fill-probability modeling for limit orders is the hard part; get it wrong and it overstates.
**Confidence:** 75% **Complexity:** Medium **Status:** Unexplored

### 5. Discipline-as-code council (cheap deterministic cron + rare LLM)
**Description:** Two-tier loop: a high-frequency **deterministic cron** (screen/size/close via rules, ~0 tokens) emits decision packets; a low-frequency **LLM council** wakes only periodically OR on a deterministic *surprise* trigger (sample-floor crossed, live-vs-dry divergence, revert trigger). The council's seats are **hard-coded kill-gates = the 31 lessons** (Regression Sentinel, Distribution-Overlap Auditor, Moonshot-Clip Guard, Coverage Cop, Dry-Run Discount, Pool-Concentration Inspector) plus an **Adversarial Red-Team seat** scored on past calls and a **STOP-the-game gate**. The LLM gathers evidence FOR gates but **cannot override them**; it never places a trade directly. A **pre-registered experiment ledger** the council can't retroactively edit. evonic = orchestration/transport only.
**Rationale:** Answers the user's council + cost-split idea AND bakes the project's most valuable asset (validation discipline) into the architecture so the LLM literally can't rationalize past it (the repeated failure mode). LLM fires ~4–12×/day, not per-cron.
**Downsides:** Over-engineering risk if the strategy isn't validated first; the gates must be genuinely deterministic.
**Confidence:** 72% **Complexity:** Medium **Status:** Unexplored

### 6. Survival & honest-accounting layer
**Description:** Portfolio-level **drawdown kill-switch** (cap the −$227 tail across all positions); **live-vs-dry reconciliation ledger** (per-strategy "dry-run honesty score"); **net-of-ops PF** (debit RPC, LLM tokens, gas, VPS — a strategy is profitable only if it clears fully-loaded cost); **isolated RPC per agent + paid-method heartbeat** (not getHealth) + **external dead-man's-switch watchdog**; **live-PF-gated capital allocator** (unvalidated strategies capped at probe size; size unlocks only on live PF threshold).
**Rationale:** Encodes every operational scar (burned keys, getHealth lies, silent death, tail losses, Charon looked-alive-while-−EV). Makes "enable both strategies" safe to run with real money instead of a faster way to bleed.
**Downsides:** Pure infra — no edge by itself; necessary not sufficient.
**Confidence:** 78% **Complexity:** Medium **Status:** Unexplored

### 7. Diversification-as-product — uncorrelated small agents (maybe blue-chip)
**Description:** Stop hunting THE winning strategy. Run several *near-break-even but uncorrelated* agents at small size (trench-style negative-skew, DLMM high-WR/big-loss, blue-chip LP boring-yield) and treat the *portfolio's* risk-adjusted return — not any single strategy's PF — as the product. Optionally restrict DLMM to blue-chip pairs (SOL/USDC) to remove adversarial selection / rug exposure entirely.
**Rationale:** The one hypothesis the whole journey never tested. Every single strategy regresses to ~1.0 but their failure modes are orthogonal; a basket can have a smoother equity curve than any leg. The user ALREADY runs 2 uncorrelated agents — this names the edge.
**Downsides:** "Diversification of break-even bets" can still net ~0 after costs; needs the net-of-ops PF (#6) to be honest. Blue-chip yield may be too thin at 0.5 SOL.
**Confidence:** 60% **Complexity:** Medium **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Regime gate (standalone) | Premature — build only after #1 validates an edge; folds into #2/#3 |
| 2 | Fee-capture mechanics (bin-step/fee-tier mining) | Untested speculation; defer until base edge proven |
| 3 | Per-pool meta-controller / strategy auctioning | Premature sophistication on an unproven edge; high burden |
| 4 | "Go pure passive, drop LP entirely" | A strategy decision that should FALL OUT of validation (#1), not be pre-committed |
| 5 | Individual modular pieces (interface, router, position, config, port) | Merged into survivor #3 |
| 6 | LLM-gating variants (surprise-trigger, deterministic-first, token-budget) | Merged into survivor #5 |
| 7 | Sell the validation harness / sell rug-data product | Off-thesis (user wants to trade DLMM, not become a SaaS vendor) — noted as fallback |
| 8 | Pre-commit exit plan (standalone) | Folded into #5's STOP-the-game gate |
| 9 | "Right side of the latency/attention asymmetry" reframe | True but too abstract to be a buildable idea — it's the philosophical backdrop |
| 10 | "Collect 90 days clean live data" (standalone) | Folded into #1's live-probe phase |

## Session Log
- 2026-06-05: Initial ideation — 40 candidates across 5 frames (edge/validation, modular architecture, agent/decision, cost/ops/risk, inversion), 7 survivors after merge + cross-cutting synthesis + adversarial filtering.
