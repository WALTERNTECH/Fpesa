# Fpesa

Live gold and forex trading for Kenya. Short-duration trades on XAU/USD, M-Pesa
deposits and withdrawals through IntaSend, a funded demo account on sign-up, and
a public trading floor with chat, live activity and a daily leaderboard.

- **Client** — React 18 + TypeScript + Vite, TradingView `lightweight-charts`
- **Server** — Node 22 + Express + `ws`, all business logic server-authoritative
- **Database** — Supabase Postgres (RLS on, service-role access only)
- **Payments** — IntaSend M-Pesa STK Push (collections) and B2C (payouts)
- **Hosting** — a single Render web service serving the API, the WebSocket and
  the built client from one origin

---

## How it fits together

```
browser ──HTTPS──►  Express  ──service role──►  Supabase Postgres
        ──WS /ws──►  price feed + chat + settlements
                     │
                     ├── gold-api.com / Twelve Data   (XAU/USD quotes)
                     ├── FXStreet, ForexLive, …       (news ticker, RSS)
                     └── payment.intasend.com         (STK push, B2C payouts)
```

The browser never receives a Supabase key. Every table has RLS enabled with no
policies, so the only path to the data is the API server holding the service
role key.

---

## Running it locally

```bash
npm run install:all
cp .env.example .env      # then fill in the values below
npm run dev               # api on :10000, client on :5173
```

`npm run dev` runs the API and the Vite dev server together; Vite proxies
`/api` and `/ws` through to the API so there is no CORS in development.

### Required environment variables

| Variable | What it is |
| --- | --- |
| `SUPABASE_URL` | `https://mrsxvdxaoogamhkdqejp.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API Keys → `service_role`. Secret. |
| `JWT_SECRET` | Signs session cookies. 48+ random bytes. |
| `INTASEND_SECRET_KEY` | IntaSend dashboard, `ISSecretKey_…` |
| `INTASEND_WEBHOOK_TOKEN` | Random string; forms the secret webhook path. |
| `INTASEND_WEBHOOK_CHALLENGE` | Must match the challenge set beside the webhook URL in IntaSend. |
| `PUBLIC_URL` | Deployed origin, e.g. `https://fpesa.onrender.com` |

Everything else has a working default — see `.env.example`.

Set `PAYMENTS_MOCK=true` to exercise the deposit and withdrawal journeys end to
end without live IntaSend keys; requests settle themselves after six seconds.

---

## The instrument

The default instrument is **FPX100 (Fpesa Volatility 100)** — a synthetic index
generated deterministically from a seed, not a feed of a real market. Every
tick is:

```
digest   = HMAC-SHA256(seed, "<epoch>:<tickIndex>")
z        = Box-Muller(two 53-bit words of the digest)
price[i] = price[i-1] * exp(drift*dt + sigma*sqrt(dt)*z)
```

Each step is rounded to two decimals and the **rounded** value is carried into
the next — a verifier that keeps full precision agrees for a tick or two and
then drifts by cents, which looks exactly like a rigged feed when it is a
rounding bug.

The SHA-256 of each epoch's seed is published **before** that epoch produces a
tick; the seed itself is published once the epoch closes. Anyone can replay a
closed epoch and confirm the prices they traded on:

```bash
node scripts/verify-epoch.mjs
```

`GET /api/fairness` carries the algorithm, the parameters (including drift —
a tilt nobody can see is indistinguishable from a rigged feed), the open
commitment, and the revealed seeds. `GET /api/fairness/engine` is the operator
view: live parameters, current epoch, and the expected move per duration.

**The honest limit:** the commitment stops outcomes being *altered*, not
*known*. Whoever holds the live seed can compute the current epoch's remaining
path, which is why epochs are short and the live seed is never served by any
endpoint until its epoch closes. Treat it as a production secret.

Setting `PRICE_MODE=live` switches back to a real XAU/USD feed, which is not
replayable — `/api/fairness` says so plainly rather than claiming a proof it
cannot give.

---

## The trading engine

A trade is a short-duration leveraged position on the instrument above. Profit tracks how far
the price actually moved — it is not a fixed win/lose amount.

```
profit = stake × multiplier × (exit − entry) / entry     (sign flipped for Sell)
         clamped to [ −stake , +stake × TRADE_MAX_PROFIT_MULTIPLE ]
```

1. The trader picks an amount (KSh 50 – 20,000), a duration (5/10/15/30/60s)
   and a direction (Buy or Sell).
2. The **server** stamps the entry price from its own feed. A price supplied by
   the browser is never trusted, and trades are refused until the feed has a
   real upstream quote behind it.
3. The stake is debited and the trade row is written **in one locked
   transaction** (`fpesa_place_trade`), so two taps cannot spend one balance.
   The stop-out and take-profit levels are computed at entry and stored.
4. The position closes on whichever comes first:
   - **stop-out** — the move against the trader reaches the whole stake. The
     tick monitor closes it the moment the barrier is crossed, without waiting
     for the timer.
   - **take-profit** — profit reaches the liability ceiling.
   - **expiry** — the duration elapses, and the position settles at whatever
     the P&L is.
5. Settlement is idempotent (`fpesa_settle_trade` claims the row with
   `FOR UPDATE` and returns early if it is already closed), and open trades are
   recovered, re-tracked and re-scheduled on boot — a restart mid-trade cannot
   strand a stake or let a position run past its stop-out.

The stake is the entire downside: a position can be wiped out, but it can never
take an account negative. While the countdown runs, the panel shows the running
P&L and how much of the stake the move has already consumed.

### Tuning the multiplier

`TRADE_MULTIPLIERS` ("seconds:multiplier" pairs) scales the stake. The defaults
are derived from the feed's volatility so that a one-standard-deviation move
over the chosen duration is worth roughly 40% of the stake at every duration —
which puts a wipe-out at about 2.5σ, or roughly 1 trade in 80. **Retune these
if you change the price feed**, or the risk profile changes with it.

`TRADE_MAX_PROFIT_MULTIPLE` (default 3) caps profit at a multiple of stake. It
exists to bound the operator's liability on a news spike; the loss side is
already bounded by the stake.

---

## House margin, and how retention actually works

Margin comes from one place: `TRADE_HOUSE_EDGE`. The entry price is marked
against the trader by `edge / multiplier`, so opening and closing at an
unchanged market costs exactly that fraction of the stake — identically at
every duration, because dividing by the multiplier cancels the difference
between them. This is a spread, the same mechanism every CFD broker uses, and
it is disclosed in the trade panel before the position is opened.

Retention follows from it directly, with no per-user selection anywhere:

```
remaining after N trades = (1 - edge) ^ N
```

Read the table as *what a depositor can still withdraw*, so the operator keeps
the remainder:

| Edge | After 10 trades | After 20 | After 30 |
| --- | --- | --- | --- |
| 3% (Aviator's ~97% RTP) | 74% | 54% | 40% |
| **6% (default)** | 54% | **29%** | 16% |
| 8% | 43% | 19% | 8% |
| 10% | 35% | 12% | 4% |

The default is tuned so ~30% of deposits are disbursed and ~70% retained, at an
assumed 20 trades per depositor. That assumption is the whole game — the same
edge keeps far less from a trader who stops after five trades, and far more from
one who makes forty:

| Avg trades per depositor | Edge for a 30% disbursement |
| --- | --- |
| 5 | 21.4% |
| 10 | 11.3% |
| 15 | 7.7% |
| **20** | **5.8%** |
| 30 | 3.9% |

So `TRADE_HOUSE_EDGE` is the only knob that should ever be reached for to change
the take, and it should be set against **measured** churn, not a guess. Read the
real figure from `GET /api/wallet/book` once there is real traffic.

`DAILY_PAYOUT_CAP_RATIO` (default 0.3) is a hard backstop on top: once net
shillings paid to traders reach that share of the day's deposits, the desk
stops opening **new** real positions and says so. It is a book control, not an
outcome control — it never alters a position already open, and it never
withholds a payout that has been won. `GET /api/wallet/book` (admin only)
shows the day's deposits, withdrawals, net paid out and the current ratio.

Individual outcomes are never selected, weighted or assigned. Every position
settles on the price, and the same edge applies to everyone.

---

## Money movement

Deposits and withdrawals both use the phone number the account was registered
with; it cannot be changed at transaction time.

**Deposit** — a `PENDING` row is written, then IntaSend `POST /api/v1/payment/mpesa-stk-push/`
fires the STK prompt. The balance moves only when the transaction is confirmed.

**Withdrawal** — the balance is debited *first*, inside the same transaction
that creates the payout record (`fpesa_reserve_withdrawal`), so money in flight
cannot also be staked. If the payout call fails, the funds are returned
immediately. One pending payout per account at a time.

**Four defences on the callback**, because a payment webhook is an
unauthenticated public endpoint:

1. The URL carries a secret path token (`INTASEND_WEBHOOK_TOKEN`); anything else
   gets a 404.
2. IntaSend echoes a configured challenge string in every delivery; a body
   without it is rejected.
3. Past those gates the body is treated as a *hint only*. The server re-reads
   the transaction from IntaSend — `POST /api/v1/payment/status/` for a deposit,
   `POST /api/v1/send-money/status/` for a payout — and credits against that
   answer. A forged callback claiming success that cannot be verified is
   discarded, not credited.
4. `balance_applied` makes crediting idempotent, so a replayed webhook cannot
   pay twice.

Webhooks also get lost, so a sweeper runs every minute: anything pending for
more than two minutes is reconciled directly against IntaSend, and anything
unresolved after fifteen minutes is expired — refunding reserved payouts.

---

## About the price feed — read this before taking real deposits

The chart is anchored to **real** XAU/USD prices, polled every 15 seconds from
`gold-api.com` (keyless) or Twelve Data if `TWELVEDATA_API_KEY` is set.

Free sources do not publish tick data. Between polls the server generates ticks
with a mean-reverting random walk tethered to the last real quote. That is
honest for charting and it keeps the display alive, but it has a consequence
worth being explicit about:

> **A 5-second trade settles against interpolated prices, not real market
> ticks.** The shorter the duration, the more the outcome is driven by the
> interpolator rather than the gold market.

This matters more under the multiplier model than it did under a fixed payout:
at ×2000, a one-cent wobble in the interpolated price is worth real money, so
the synthetic ticks between polls are directly setting P&L.

Before running real money through short durations, plug in a genuine tick feed.
`PRICE_MODE` and the upstream fetchers in `server/src/services/prices.ts` are
the seam built for exactly that. `PRICE_MODE=simulated` disables external calls
entirely for local work.

The session-change figure is measured from the first real quote the server saw
(or a real previous close when Twelve Data is configured) — never from
generated history.

---

## Layout

```
client/src
  components/     UI, one concern per file
  store/app.tsx   auth, live price, open trades, toasts, modals
  lib/            api client, WebSocket, formatting, types
server/src
  routes/         HTTP surface, validation at the edge with zod
  services/       prices, trading, wallet, intasend, news
  realtime/hub.ts one socket for prices, chat, feeds, settlements
  lib/            auth (bcrypt + JWT), Supabase client
supabase/migrations
  0001_core_schema.sql
  0002_money_functions.sql
```

`0002` holds every balance mutation as a locking Postgres function. Balances are
never read-modify-written from application code.

---

## Deployment

Render builds from `main`. `npm run build` installs both workspaces, builds the
client to `client/dist` and compiles the server to `server/dist`; `npm start`
serves both from one origin. Health check is `/api/health`.

After the first deploy, set `PUBLIC_URL` to the live origin — the IntaSend
callback URL is built from it — and register the webhook URL with IntaSend (and set the same challenge string):

```
https://<your-domain>/api/webhooks/intasend/<INTASEND_WEBHOOK_TOKEN>
```

Note that Render's free plan sleeps after inactivity. The engine recovers open
trades on boot, but a sleeping instance is not running settlement timers — use a
paid instance once real money is involved.

---

## Risk

Short-duration trading carries a high risk of losing money. This software does
not make it a licensed product: operating it for real money in Kenya is a
regulated activity (BCLB), and licensing, AML/KYC obligations and tax handling
are the operator's responsibility.
