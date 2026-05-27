#!/usr/bin/env python3
import sqlite3, os, json
from datetime import datetime, timezone

DB = os.environ.get("DB_PATH", "/opt/charon/charon.sqlite")
c = sqlite3.connect(DB)

rows = c.execute("""
  SELECT id, pnl_percent, exit_reason, opened_at_ms, closed_at_ms, entry_mcap,
    high_water_mcap, size_sol, snapshot_json, strategy_id
  FROM dry_run_positions WHERE status='closed' AND strategy_id='degen'
  ORDER BY opened_at_ms ASC
""").fetchall()

n = len(rows)
wins = [r for r in rows if r[1] > 0]
big_wins = [r for r in rows if r[1] >= 50]
moonshots = [r for r in rows if r[1] >= 100]
losses = [r for r in rows if r[1] <= 0]

print("=== WHAT WORKS (winning trades) ===")
print(f"  Total: {n} trades")
print(f"  Wins (>0%):      {len(wins)} ({len(wins)/n*100:.1f}%)")
print(f"  Big wins (>50%): {len(big_wins)} ({len(big_wins)/n*100:.1f}%)")
print(f"  Moonshots (>100%): {len(moonshots)} ({len(moonshots)/n*100:.1f}%)")
gl = abs(sum(r[1] for r in losses))
print(f"  Big wins gross:  +{sum(r[1] for r in big_wins):.0f}% = {sum(r[1] for r in big_wins)/gl*100:.0f}% of gross loss")

# ROUTE ANALYSIS
print(f"\n=== BY ROUTE ===")
route_data = {}
for r in rows:
    s = json.loads(r[8] or "{}")
    route = s.get("candidate",{}).get("signals",{}).get("route","unknown")
    route_data.setdefault(route, []).append(r[1])

print(f"  {'Route':<28} {'n':>5} {'WR':>6} {'Avg':>8} {'PF':>6} {'Cats':>5} {'Best':>7}")
for route, ps in sorted(route_data.items(), key=lambda x: -len(x[1])):
    w = [p for p in ps if p > 0]
    cats = [p for p in ps if p <= -25]
    gw = sum(w); glo = abs(sum(p for p in ps if p <= 0))
    pf = gw/glo if glo else 0
    print(f"  {route:<28} {len(ps):>5} {len(w)/len(ps)*100:>5.1f}% {sum(ps)/len(ps):>+7.2f}% {pf:>5.2f}x {len(cats):>5} {max(ps):>+6.1f}%")

# TIME PERIOD
print(f"\n=== BY TIME PERIOD ===")
chunks = [("First 300", rows[:300]),("301-600", rows[300:600]),("601-900", rows[600:900]),("901-1200", rows[900:1200]),("1201+", rows[1200:])]
for label, chunk in chunks:
    if not chunk: continue
    ps = [r[1] for r in chunk]
    w = [p for p in ps if p > 0]
    cats = [p for p in ps if p <= -25]
    gw = sum(p for p in ps if p > 0); glo = abs(sum(p for p in ps if p <= 0))
    pf = gw/glo if glo else 0
    ds = datetime.fromtimestamp(chunk[0][3]/1000, tz=timezone.utc).strftime("%m/%d")
    de = datetime.fromtimestamp(chunk[-1][3]/1000, tz=timezone.utc).strftime("%m/%d")
    print(f"  {label:<12} ({ds}-{de}) n={len(ps):>4} WR={len(w)/len(ps)*100:>5.1f}% avg={sum(ps)/len(ps):>+6.2f}% PF={pf:.2f}x cats={len(cats):>3}")

# EXIT REASON
print(f"\n=== EXIT REASON ===")
exits = {}
for r in rows:
    exits.setdefault(r[2] or "unknown", []).append(r[1])

print(f"  {'Exit':<15} {'n':>5} {'WR':>6} {'Avg PnL':>9} {'When loss':>10}")
for ex, ps in sorted(exits.items(), key=lambda x: -len(x[1])):
    w = [p for p in ps if p > 0]; l = [p for p in ps if p <= 0]
    avgl = sum(l)/len(l) if l else 0
    print(f"  {ex:<15} {len(ps):>5} {len(w)/len(ps)*100:>5.1f}% {sum(ps)/len(ps):>+8.2f}% {avgl:>+9.1f}%")

# HOLD TIME
print(f"\n=== HOLD TIME ===")
hold_bins = [(0,2,"0-2min"),(2,5,"2-5min"),(5,15,"5-15min"),(15,60,"15-60min"),(60,300,"1-5hr"),(300,99999,">5hr")]
for lo, hi, label in hold_bins:
    ib = [r for r in rows if r[4] and r[3] and lo <= (r[4]-r[3])/60000 < hi]
    if not ib: continue
    ps = [r[1] for r in ib]
    w = [p for p in ps if p > 0]; cats = [p for p in ps if p <= -25]
    print(f"  {label:<10} n={len(ib):>4}  WR={len(w)/len(ib)*100:>5.1f}%  avg={sum(ps)/len(ps):>+6.2f}%  cats={len(cats):>3}({len(cats)/len(ib)*100:.0f}%)")

# MCAP BUCKETS
print(f"\n=== ENTRY MCAP ===")
mbins = [(0,10000,"<10K"),(10000,20000,"10-20K"),(20000,40000,"20-40K"),(40000,80000,"40-80K"),(80000,999999,">80K")]
for lo, hi, label in mbins:
    ib = [r for r in rows if r[5] and lo <= r[5] < hi]
    if not ib: continue
    ps = [r[1] for r in ib]
    w = [p for p in ps if p > 0]; cats = [p for p in ps if p <= -25]
    gw = sum(p for p in ps if p > 0); glo = abs(sum(p for p in ps if p <= 0))
    pf = gw/glo if glo else 0
    print(f"  {label:<10} n={len(ib):>4}  WR={len(w)/len(ib)*100:>5.1f}%  avg={sum(ps)/len(ps):>+6.2f}%  PF={pf:.2f}x  cats={len(cats):>3}({len(cats)/len(ib)*100:.0f}%)")

# PEAK vs REALIZED
print(f"\n=== PEAK vs REALIZED (winners) ===")
givebacks = []
for r in wins:
    em, hwm = r[5], r[6]
    if em and hwm and em > 0:
        peak = (hwm/em - 1)*100
        realized = r[1]
        if peak > 0:
            gb = (peak - realized) / peak * 100
            givebacks.append((peak, realized, gb))
if givebacks:
    gbs = sorted(givebacks, key=lambda x: x[2])
    print(f"  n={len(gbs)} winners with peak data")
    print(f"  Median giveback: {gbs[len(gbs)//2][2]:.0f}% of peak")
    print(f"  Mean giveback:   {sum(g[2] for g in gbs)/len(gbs):.0f}% of peak")
    actual = sum(g[1] for g in gbs)
    kept80 = sum(g[0]*0.8 for g in gbs)
    print(f"  If kept 80% of peak: +{kept80:.0f}% vs actual +{actual:.0f}% (delta +{kept80-actual:.0f}%)")
