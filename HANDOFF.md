# Handoff — finish the digital product

Everything else on Fpesa is done and live. This is the one unfinished piece.
It is about four steps and none of them are large.

## Where things stand right now (verified 2026-09-11)

Production is **consistent and safe**. Nothing is half-applied.

```
GET /api/market/config  ->  digitalEnabled: false,  houseEdge: 0.11
fpesa_settle_trade      ->  original text, no digital branch
trades                  ->  436 rows, all trade_type = 'SCALED', 0 open
fpesa_settle_trade      ->  1 overload  (stale payout_rate one dropped)
fpesa_place_trade       ->  2 overloads (14-arg old + 16-arg new — see step 4)
```

The digital product is fully built and **dormant behind `DIGITAL_ENABLED=false`**.
No code path can write a `DIGITAL` row while that flag is off, which is why it is
safe for the settle function to have no digital branch: the branch would have
nothing to serve.

## What is already built and committed

| Piece | Where |
|---|---|
| Pricing (barrier placement, payout) | `server/src/services/digital.ts` |
| Placement | `server/src/services/trading.ts` — `placeTrade`, `tradeType`/`winRate` params |
| Quote endpoint | `server/src/routes/trade.routes.ts` — `GET /api/trades/digital/quote` |
| Columns | `trades.trade_type` (default `'SCALED'`), `trades.barrier_price` |
| 16-arg place_trade | applied, takes `p_trade_type` and `p_barrier` |
| Feature flag | `DIGITAL_ENABLED` (env, default false), published on `/api/market/config` |

Not built: **the client UI**. The trader app never sends `tradeType`, so it always
gets `SCALED`. That is deliberate — the UI comes after the mechanics are proven.

## The product, in one paragraph

The scaled product pays in proportion to how far price moved, which pins the win
rate below 50%: the spread has to be crossed before a position is worth anything,
and at zero spread it is exactly a coin flip. A digital is decided by one
comparison at expiry against a barrier fixed at open, so the win rate is wherever
you put the barrier, and the payout follows from it:

```
payout = ((1 - winRate) - edge) / winRate
```

At 70% and a 3% edge: **+38.6% of stake on a win, the full stake on a loss,
expected result −3% either way** — identical to the scaled product at the same
edge. Same revenue, different shape.

Three things that matter in the wiring:

- A digital opens **at the mid with no spread applied**. Its edge is in the
  payout; marking the entry as well would charge it twice.
- `max_profit` carries the **win payout**, which is exactly what the solvency
  guard should reserve — so the guard needs no change.
- `stop_out` and `take_profit` are **null**, and `track()` returns early on a
  null stop-out, so the tick-by-tick barrier scan never sees a digital. They
  settle at expiry only.

## The four remaining steps

### 1. Apply the settle branch

Paste `supabase/manual/2026-09-11-digital-settle-branch.sql` into the Supabase
SQL editor and run it. Idempotent; safe to run twice.

The SCALED path inside it is the current function line for line, inside an
`else`. The only structural change is `v_payout` moving to after the branch,
which is free — payout does not depend on status and status does not depend on
payout. **Step 3 measures that rather than trusting it.**

Undo: `supabase/manual/2026-09-11-digital-settle-revert.sql`.

### 2. Enable the flag

Render → service `srv-dadfbtpt0dsc738cfao0` (`fpesa`) → Environment →
`DIGITAL_ENABLED` = `true` → Save.

**Then check that uptime actually reset** — `GET /api/health`. An env save did
*not* restart the process once today, and the old value stayed live for ten
minutes. If uptime did not reset, trigger a deploy manually.

Confirm with `GET /api/market/config` → `digitalEnabled: true`.

**Order matters: step 1 before step 2.** Flag on without the branch means a
digital would settle through the scaled path and pay roughly nothing.

### 3. Test end to end, on demo money

Register a throwaway account through the public API and place positions on the
**demo** balance (10,000 by default, touches nothing real).

Check all of:

- `GET /api/trades/digital/quote?symbol=FPX100&durationSec=10` — barrier sits
  below entry for BUY and above for SELL; `expectedPctOfStake` is −(edge) at
  every win rate offered.
- A digital BUY that finishes **above** its barrier → `WON`, profit equals the
  quoted payout exactly.
- A digital BUY that finishes **below** → `LOST`, profit is the full stake.
- A digital SELL, to confirm the comparison flips.
- **A scaled position alongside**, to prove the existing product is unchanged:
  stake × multiplier × move, capped at ±stake and max_profit.

Then delete the test user and its trades.

If anything is wrong: run the revert SQL, set the flag back to `false`.

### 4. Drop the old place_trade overload

Once step 3 passes:

```sql
drop function if exists public.fpesa_place_trade(
  uuid, text, text, numeric, integer, numeric, numeric, text,
  numeric, numeric, numeric, numeric, numeric, numeric
);
```

Two overloads is the exact hazard cleaned up earlier today — four had
accumulated, two with **no solvency guard at all**. The 14-arg one was kept only
so a deploy never called a missing function. It should not survive.

Verify one remains, with `FLOAT_LIMIT` and `p_position_share` both present.

## Then, optionally: the client UI

A product switch on the ticket — "bigger wins, less often" against "smaller
wins, more often" — showing the barrier and the payout before the trader
commits, the same way the scaled ticket shows its stop-out and spread.

One line that must appear, and must not be softened: a 70% win rate is **not** a
70% chance of profit. Expected result is still negative at any spread above
zero. Advertise "win 7 out of 10 trades", never "70% of traders profit".

## Also worth knowing

- **`TRADE_HOUSE_EDGE` is 11%, and the realised figure is 16.4%.** The gap is
  stop-outs firing at 6.06% against a published 1.2%, because a position opens
  11% of the way to its own barrier — `analyseTrade` computes the odds from
  `1/multiplier` when the true distance from the market is `(1-edge)/multiplier`.
  The published stop-out probability understates the real one by roughly half.
  Unfixed.
- The edge is now editable in the console (Book tab), audited, bounded 0–20%.
- All three traders are net down; the modelling for lowering the edge is in the
  session history, and 3–5% is where a third of regulars end up ahead.
