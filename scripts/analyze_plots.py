#!/usr/bin/env python3
"""
Pattern visualization for Charon trade data.

Loads closed dry-run trades + their snapshot features into a DataFrame,
then generates plots that surface what works vs what doesn't:
  1. PnL distribution histogram (overall + by bucket)
  2. Feature scatter plots: feature value vs PnL outcome, colored by W/L
  3. Heatmap: avg PnL across 2D feature pairs (find sweet/sour zones)
  4. Train/test consistency check: per-bucket avg PnL with confidence
  5. Catastrophe vs moonshot overlap: do they share the same feature space?

Output: ./charts/*.png

Usage: DB_PATH=./charon_v2.sqlite python3 scripts/analyze_plots.py [from_id] [to_id]
"""
import os, sys, json, sqlite3
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path

DB_PATH = os.environ.get('DB_PATH', './charon.sqlite')
FROM = int(sys.argv[1]) if len(sys.argv) > 1 else 245
TO = int(sys.argv[2]) if len(sys.argv) > 2 else 9999999
TRAIN_FRAC = 0.7
CATASTROPHE = -25
MOONSHOT = 100

OUT_DIR = Path('./charts')
OUT_DIR.mkdir(exist_ok=True)

# --- Load data ----------------------------------------------------------------
con = sqlite3.connect(DB_PATH)
rows = con.execute(f"""
  SELECT id, opened_at_ms, pnl_percent, exit_reason, entry_mcap, snapshot_json
  FROM dry_run_positions
  WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'
    AND id >= ? AND id <= ? AND strategy_id IN ('degen','degen_filtered_v1')
  ORDER BY opened_at_ms ASC
""", (FROM, TO)).fetchall()

def feat(snap_json, entry_mcap):
    try: s = json.loads(snap_json)
    except: s = {}
    c = s.get('candidate', {})
    e = c.get('entrySignals') or {}
    t = c.get('trending') or {}
    s5 = t.get('stats5m') or {}
    holders = c.get('holders', {}).get('holders') or []
    def n(x):
        try: return float(x) if x is not None else np.nan
        except: return np.nan
    return {
        'entry_mcap': n(entry_mcap),
        'liquidity': n(e.get('liquidityUsd') or c.get('metrics', {}).get('liquidityUsd') or t.get('liquidity')),
        'holders': n(e.get('holderCount') or c.get('holders', {}).get('count')),
        'top1': n(e.get('top1HolderPct') or (holders[0].get('percent') if holders else None)),
        'top10': n(e.get('top10HolderPct') or sum((h.get('percent') or 0) for h in holders[:10])),
        'vol5m': n(e.get('vol5mUsd') or t.get('volume5m')),
        'vol24h': n(e.get('vol24hUsd') or t.get('volume24h')),
        'pchg5m': n(e.get('priceChange5mPct') or s5.get('priceChange') or t.get('change5m')),
        'holder_chg5m': n(e.get('holderChange5mPct') or s5.get('holderChange')),
        'liq_chg5m': n(e.get('liquidityChange5mPct') or s5.get('liquidityChange')),
        'organic': n(e.get('organicScore') or t.get('organicScore')),
        'route': e.get('route') or c.get('signals', {}).get('route') or 'unknown',
    }

records = []
for r in rows:
    pid, opened, pnl, exit_r, em, snap = r
    f = feat(snap, em)
    f['id'] = pid
    f['opened_ms'] = opened
    f['pnl'] = pnl
    f['exit'] = exit_r
    records.append(f)

df = pd.DataFrame(records)
df['bucket'] = pd.cut(df['pnl'], bins=[-200, -25, 0, 50, 100, 1000],
                     labels=['catastrophe', 'normal_loss', 'small_win', 'mid_win', 'moonshot'])
df['is_win'] = df['pnl'] > 0
df['is_cat'] = df['pnl'] <= CATASTROPHE
df['is_moon'] = df['pnl'] >= MOONSHOT

split = int(len(df) * TRAIN_FRAC)
df['split'] = ['TRAIN'] * split + ['TEST'] * (len(df) - split)

print(f"Loaded {len(df)} trades. TRAIN={split}, TEST={len(df)-split}")
print(f"Outcomes: wins={df['is_win'].sum()}, losses={(~df['is_win']).sum()}, cat={df['is_cat'].sum()}, moonshots={df['is_moon'].sum()}")
print(f"Output dir: {OUT_DIR.absolute()}\n")

# --- 1. PnL distribution overview --------------------------------------------
fig, axes = plt.subplots(1, 2, figsize=(14, 5))
axes[0].hist(df['pnl'].clip(-100, 500), bins=80, color='steelblue', edgecolor='black')
axes[0].axvline(0, color='black', linestyle='--', alpha=0.5)
axes[0].axvline(CATASTROPHE, color='red', linestyle='--', alpha=0.7, label=f'catastrophe ≤{CATASTROPHE}%')
axes[0].axvline(MOONSHOT, color='green', linestyle='--', alpha=0.7, label=f'moonshot ≥{MOONSHOT}%')
axes[0].set_title(f'PnL distribution (n={len(df)})')
axes[0].set_xlabel('pnl_percent (clipped to [-100, 500])')
axes[0].set_ylabel('count')
axes[0].legend()

bucket_counts = df['bucket'].value_counts().reindex(['catastrophe', 'normal_loss', 'small_win', 'mid_win', 'moonshot'])
colors = ['darkred', 'salmon', 'lightgreen', 'green', 'gold']
axes[1].bar(bucket_counts.index, bucket_counts.values, color=colors, edgecolor='black')
for i, v in enumerate(bucket_counts.values):
    axes[1].text(i, v + 5, f'{v}\n({v/len(df)*100:.1f}%)', ha='center', fontsize=10)
axes[1].set_title('Outcome buckets')
axes[1].set_ylabel('count')
plt.tight_layout()
plt.savefig(OUT_DIR / '1_pnl_distribution.png', dpi=100)
plt.close()
print("  ✓ 1_pnl_distribution.png")

# --- 2. Per-feature: bucket × avg PnL, TRAIN vs TEST consistency check ------
features_to_check = [
    ('pchg5m', 'priceChange5m %', [-50, -10, 0, 10, 30, 200]),
    ('vol5m', 'vol5m USD', [0, 500, 1500, 3000, 6000, 100000]),
    ('entry_mcap', 'entry_mcap USD', [0, 10000, 20000, 40000, 80000, 1000000]),
    ('top1', 'top1 holder %', [0, 20, 30, 40, 50, 100]),
    ('organic', 'organicScore', [0, 20, 40, 60, 80, 100]),
    ('holder_chg5m', 'holderChange5m %', [-50, -5, 0, 5, 50]),
]

fig, axes = plt.subplots(2, 3, figsize=(18, 10))
for idx, (col, label, bins) in enumerate(features_to_check):
    ax = axes.flatten()[idx]
    bin_labels = [f'{bins[i]}..{bins[i+1]}' for i in range(len(bins)-1)]
    df[f'{col}_bin'] = pd.cut(df[col], bins=bins, labels=bin_labels, include_lowest=True)
    grouped = df.groupby([f'{col}_bin', 'split'], observed=True)['pnl'].agg(['mean', 'count']).unstack('split')
    if 'mean' not in grouped.columns.get_level_values(0):
        ax.set_title(f'{label}: insufficient data')
        continue
    means = grouped['mean']
    counts = grouped['count']
    # Reindex by the exact bin_labels so x and y always match length
    train_means = means.get('TRAIN', pd.Series(dtype=float)).reindex(bin_labels).fillna(0)
    test_means  = means.get('TEST',  pd.Series(dtype=float)).reindex(bin_labels).fillna(0)
    x = np.arange(len(bin_labels))
    w = 0.35
    ax.bar(x - w/2, train_means.values, w, label='TRAIN', color='steelblue', edgecolor='black')
    ax.bar(x + w/2, test_means.values,  w, label='TEST',  color='orange',    edgecolor='black')
    ax.axhline(0, color='black', linewidth=0.8)
    ax.set_title(label)
    ax.set_xticks(x)
    ax.set_xticklabels(bin_labels, rotation=20, fontsize=8)
    ax.set_ylabel('avg PnL %')
    ax.legend(loc='lower right', fontsize=8)
    # Annotate sample counts
    for i, bl in enumerate(bin_labels):
        try:
            n_tr = int(counts.get('TRAIN', pd.Series()).get(bl, 0) or 0)
            n_te = int(counts.get('TEST',  pd.Series()).get(bl, 0) or 0)
            ax.text(i, ax.get_ylim()[1] * 0.92, f'{n_tr}/{n_te}', ha='center', fontsize=7, color='gray')
        except Exception:
            pass

plt.suptitle('Per-feature bucket avg PnL: TRAIN vs TEST (n shown as train/test count above each pair)', fontsize=13)
plt.tight_layout()
plt.savefig(OUT_DIR / '2_feature_buckets_train_test.png', dpi=100)
plt.close()
print("  ✓ 2_feature_buckets_train_test.png")

# --- 3. Catastrophe vs moonshot overlap (the key question) ------------------
fig, axes = plt.subplots(1, 3, figsize=(18, 5))

pairs = [('pchg5m', 'vol5m'), ('pchg5m', 'entry_mcap'), ('top1', 'vol5m')]
for ax, (xcol, ycol) in zip(axes, pairs):
    sub = df.dropna(subset=[xcol, ycol]).copy()
    sub_n = sub[~sub['is_cat'] & ~sub['is_moon']]
    sub_c = sub[sub['is_cat']]
    sub_m = sub[sub['is_moon']]
    ax.scatter(sub_n[xcol], sub_n[ycol], c='lightgray', s=15, alpha=0.5, label=f'normal n={len(sub_n)}')
    ax.scatter(sub_c[xcol], sub_c[ycol], c='red', s=40, alpha=0.8, label=f'catastrophe n={len(sub_c)}', marker='x')
    ax.scatter(sub_m[xcol], sub_m[ycol], c='green', s=80, alpha=0.9, label=f'moonshot n={len(sub_m)}', marker='*')
    if ycol == 'vol5m' or ycol == 'entry_mcap':
        ax.set_yscale('log')
    ax.set_xlabel(xcol)
    ax.set_ylabel(ycol)
    ax.set_title(f'{xcol} vs {ycol}: where do cats and moons live?')
    ax.legend(fontsize=8)

plt.tight_layout()
plt.savefig(OUT_DIR / '3_catastrophe_vs_moonshot_overlap.png', dpi=100)
plt.close()
print("  ✓ 3_catastrophe_vs_moonshot_overlap.png")

# --- 4. Heatmap: avg PnL across 2D feature grid -----------------------------
def heatmap(ax, df_in, xcol, ycol, xbins, ybins, title):
    sub = df_in.dropna(subset=[xcol, ycol]).copy()
    if len(sub) < 50:
        ax.set_title(f'{title}: n={len(sub)} too small')
        return
    sub['xb'] = pd.cut(sub[xcol], bins=xbins)
    sub['yb'] = pd.cut(sub[ycol], bins=ybins)
    pivot = sub.pivot_table(values='pnl', index='yb', columns='xb', aggfunc='mean', observed=True)
    counts = sub.pivot_table(values='pnl', index='yb', columns='xb', aggfunc='count', observed=True).fillna(0)
    # Mask cells with <5 samples
    pivot_masked = pivot.where(counts >= 5)
    im = ax.imshow(pivot_masked.values, cmap='RdYlGn', aspect='auto', vmin=-30, vmax=30)
    ax.set_xticks(range(len(pivot.columns)))
    ax.set_xticklabels([f'{int(c.left)}-{int(c.right)}' for c in pivot.columns], rotation=30, fontsize=8)
    ax.set_yticks(range(len(pivot.index)))
    ax.set_yticklabels([f'{int(c.left)}-{int(c.right)}' for c in pivot.index], fontsize=8)
    ax.set_xlabel(xcol)
    ax.set_ylabel(ycol)
    ax.set_title(title)
    # Annotate cells with n
    for i in range(len(pivot.index)):
        for j in range(len(pivot.columns)):
            v = pivot.iloc[i, j] if i < len(pivot) and j < len(pivot.columns) else None
            n = counts.iloc[i, j] if i < len(counts) and j < len(counts.columns) else 0
            if pd.notna(v) and n >= 5:
                ax.text(j, i, f'{v:+.0f}\nn={int(n)}', ha='center', va='center', fontsize=7,
                       color='black' if abs(v) < 15 else 'white')
    plt.colorbar(im, ax=ax, label='avg PnL %')

fig, axes = plt.subplots(1, 2, figsize=(16, 6))
heatmap(axes[0], df, 'pchg5m', 'vol5m',
        xbins=[-100, -10, 0, 10, 30, 200],
        ybins=[0, 500, 1500, 3000, 6000, 100000],
        title='avg PnL: priceChange5m × vol5m')
heatmap(axes[1], df, 'entry_mcap', 'top1',
        xbins=[0, 10000, 20000, 40000, 80000, 1000000],
        ybins=[0, 20, 30, 40, 50, 100],
        title='avg PnL: entry_mcap × top1 holder')
plt.tight_layout()
plt.savefig(OUT_DIR / '4_heatmap_2d_avg_pnl.png', dpi=100)
plt.close()
print("  ✓ 4_heatmap_2d_avg_pnl.png")

# --- 5. Cumulative PnL over time ---------------------------------------------
df_sorted = df.sort_values('opened_ms').copy()
df_sorted['cum_pnl_pct'] = df_sorted['pnl'].cumsum()
df_sorted['cum_pnl_sol_est'] = df_sorted['pnl'] / 100 * 0.1  # 0.1 SOL per trade
df_sorted['cum_pnl_sol'] = df_sorted['cum_pnl_sol_est'].cumsum()
df_sorted['trade_idx'] = range(len(df_sorted))

fig, axes = plt.subplots(1, 2, figsize=(16, 5))
axes[0].plot(df_sorted['trade_idx'], df_sorted['cum_pnl_pct'], color='steelblue', linewidth=1)
axes[0].axvline(split, color='red', linestyle='--', alpha=0.5, label=f'TRAIN/TEST split')
axes[0].set_title('Cumulative PnL % over trade sequence')
axes[0].set_xlabel('trade #')
axes[0].set_ylabel('cumulative PnL %')
axes[0].axhline(0, color='black', linewidth=0.5)
axes[0].legend()

axes[1].plot(df_sorted['trade_idx'], df_sorted['cum_pnl_sol'], color='darkgreen', linewidth=1)
axes[1].axvline(split, color='red', linestyle='--', alpha=0.5)
axes[1].set_title('Cumulative PnL SOL (assuming 0.1 SOL per trade, NO fees)')
axes[1].set_xlabel('trade #')
axes[1].set_ylabel('cumulative SOL')
axes[1].axhline(0, color='black', linewidth=0.5)

plt.tight_layout()
plt.savefig(OUT_DIR / '5_cumulative_pnl.png', dpi=100)
plt.close()
print("  ✓ 5_cumulative_pnl.png")

# --- 6. Summary table to console ---------------------------------------------
print("\n=== Summary table (TRAIN vs TEST consistency) ===")
for col, label, bins in features_to_check:
    bin_labels = [f'{bins[i]}..{bins[i+1]}' for i in range(len(bins)-1)]
    df[f'{col}_bin'] = pd.cut(df[col], bins=bins, labels=bin_labels, include_lowest=True)
    g = df.groupby([f'{col}_bin', 'split'], observed=True).agg(
        n=('pnl', 'count'), avg=('pnl', 'mean'), cat=('is_cat', 'mean')
    ).unstack('split')
    g['consistent'] = ''
    for b in bin_labels:
        try:
            t = g.loc[b, ('avg', 'TRAIN')]
            v = g.loc[b, ('avg', 'TEST')]
            n_t = g.loc[b, ('n', 'TRAIN')]
            n_v = g.loc[b, ('n', 'TEST')]
            if n_t >= 10 and n_v >= 10 and pd.notna(t) and pd.notna(v):
                if (t > 0) == (v > 0):
                    g.loc[b, 'consistent'] = '✓ same sign'
                else:
                    g.loc[b, 'consistent'] = '✗ flips'
        except Exception:
            pass
    print(f"\n{label}:")
    print(g.to_string())

print(f"\nAll charts saved to {OUT_DIR.absolute()}/")
