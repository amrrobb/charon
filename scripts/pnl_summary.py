#!/usr/bin/env python3
import sqlite3, os
DB = os.environ.get("DB_PATH", "/opt/charon/charon.sqlite")
c = sqlite3.connect(DB)

strategies = ["degen", "degen_filtered_v1", "degen_favor_v1"]
hdr = f"{'Strategy':<25} {'n':>5} {'WR':>6} {'Avg PnL':>9} {'Avg Win':>9} {'Avg Loss':>9} {'PF':>6} {'PF base':>8} {'Sum PnL%':>10} {'Cats':>5} {'Best':>7}"
print(hdr)
print("-" * len(hdr))

for sid in strategies:
    rows = c.execute("SELECT pnl_percent FROM dry_run_positions WHERE strategy_id=? AND status='closed'", (sid,)).fetchall()
    if not rows: continue
    pnls = [r[0] for r in rows if r[0] is not None]
    w = [p for p in pnls if p > 0]
    l = [p for p in pnls if p <= 0]
    cats = [p for p in pnls if p <= -25]
    gw, gl = sum(w), abs(sum(l))
    sw = sorted(w, reverse=True)
    gwnt = sum(sw[1:]) if sw else 0
    pf = gw / gl if gl else 0
    pfb = gwnt / gl if gl else 0
    wr = len(w) / len(pnls) * 100
    avg = (gw - gl) / len(pnls)
    avgw = gw / len(w) if w else 0
    avgl = sum(l) / len(l) if l else 0
    print(f"{sid:<25} {len(pnls):>5} {wr:>5.1f}% {avg:>+8.2f}% {avgw:>+8.1f}% {avgl:>+8.1f}% {pf:>5.2f}x {pfb:>7.2f}x {gw-gl:>+9.1f}% {len(cats):>5} {sw[0] if sw else 0:>+6.1f}%")

all_rows = c.execute("SELECT pnl_percent, size_sol FROM dry_run_positions WHERE status='closed' AND COALESCE(execution_mode,'dry_run')='dry_run'").fetchall()
pnls = [r[0] for r in all_rows if r[0] is not None]
w = [p for p in pnls if p > 0]; l = [p for p in pnls if p <= 0]
cats = [p for p in pnls if p <= -25]
gw, gl = sum(w), abs(sum(l)); sw = sorted(w, reverse=True); gwnt = sum(sw[1:]) if sw else 0
pf = gw / gl if gl else 0; pfb = gwnt / gl if gl else 0
print()
print(f"{'ALL (total)':<25} {len(pnls):>5} {len(w)/len(pnls)*100:>5.1f}% {(gw-gl)/len(pnls):>+8.2f}% {gw/len(w) if w else 0:>+8.1f}% {sum(l)/len(l) if l else 0:>+8.1f}% {pf:>5.2f}x {pfb:>7.2f}x {gw-gl:>+9.1f}% {len(cats):>5} {sw[0] if sw else 0:>+6.1f}%")

total_sol = sum(r[1] * r[0] / 100 for r in all_rows if r[0] is not None and r[1] is not None)
fee_est = len(pnls) * 0.0102
slip_est = sum(r[1] for r in all_rows if r[1]) * 0.03
net_sol = total_sol - fee_est - slip_est
sol_price = 170
print(f"\n=== SOL / USD summary ===")
print(f"  Realized PnL:        {total_sol:>+8.4f} SOL  (${total_sol*sol_price:>+8.2f})")
print(f"  Est fees ({len(pnls)} trades): {-fee_est:>+8.4f} SOL  (${-fee_est*sol_price:>+8.2f})")
print(f"  Est slippage (3%):   {-slip_est:>+8.4f} SOL  (${-slip_est*sol_price:>+8.2f})")
print(f"  Net after costs:     {net_sol:>+8.4f} SOL  (${net_sol*sol_price:>+8.2f})")

opens = c.execute("SELECT p.size_sol, (SELECT unrealized_pnl_percent FROM position_snapshots WHERE position_id=p.id ORDER BY at_ms DESC LIMIT 1) FROM dry_run_positions p WHERE status='open'").fetchall()
unreal = sum(o[0] * (o[1] or 0) / 100 for o in opens)
print(f"  Open unrealized:     {unreal:>+8.4f} SOL  (${unreal*sol_price:>+8.2f})")
