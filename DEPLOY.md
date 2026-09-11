# Putting Fpesa on fpesa.markets

Two routes. **Route A takes about fifteen minutes and needs nothing from this
zip** — the app is already deployed and running, and you are only pointing the
domain at it. Take that one first, get the site live, get your IntaSend keys.

Route B is for moving onto your own hosting later.

---

## Route A — point fpesa.markets at the running deployment

### 1. Claim the domains in Render

Dashboard → **fpesa** service → **Settings** → **Custom Domains** → Add:

- `fpesa.markets`
- `www.fpesa.markets`

Then → **fpesa-admin** service → Custom Domains → Add:

- `ops.fpesa.markets`

Render shows you the exact DNS record to create for each one. **Use the values
it shows you** — the apex record in particular is an IP that Render owns and can
change, so copying it off the screen is the only reliable way to get it right.

### 2. Add the records at Spaceship

Spaceship → your domain → **Advanced DNS** (or DNS Records). You will be adding
roughly this shape, with Render's values in the right-hand column:

| Type | Host | Value |
|------|------|-------|
| A | `@` | *(the IP Render shows for the apex)* |
| CNAME | `www` | *(the `.onrender.com` hostname Render shows)* |
| CNAME | `ops` | *(the `.onrender.com` hostname for the admin service)* |

Delete any parking or placeholder records Spaceship added on purchase —
a leftover `A @` pointing at their parking page will fight yours.

DNS usually propagates in minutes. Render issues the TLS certificate
automatically once it can see the record; the domain sits in "Verifying" until
then. If it is still pending after an hour, the record is wrong — check for a
trailing dot or a duplicate.

### 3. Update two settings

Once `https://fpesa.markets` loads, set these in Render → Environment:

**fpesa** (trading service)

```
PUBLIC_URL = https://fpesa.markets
```

**fpesa-admin** (console)

```
UPSTREAM_URL = https://fpesa.markets
```

`PUBLIC_URL` is what the M-Pesa callback address is built from, so it has to be
the real domain before payments can work. `UPSTREAM_URL` is how the console
reads live prices from the trading service.

*(Both are already set to these values — they are listed so you know what they
are for, and what to change if the domain ever changes.)*

### 4. Your IntaSend webhook address

```
https://fpesa.markets/api/webhooks/intasend/76729d6a3601b2f5d912e302022f7a2c09be340514d342f9
```

That long segment is a secret. It is what stops anyone who guesses the path from
posting fake payment confirmations, so treat it like a password: do not put it
in a screenshot or a support ticket. If it leaks, tell me and I will rotate it.

In the IntaSend dashboard, set that as the webhook/callback URL and set a
**challenge** string of your choosing. Then send me:

- `INTASEND_SECRET_KEY`
- `INTASEND_WEBHOOK_CHALLENGE` — the challenge you just set

---

## Before you take real money

These are not domain steps, but none of them are optional.

1. **Move off the Render free tier.** Both services sleep after 15 minutes idle.
   That stops the price engine and every settlement timer — a five-second trade
   left open across a sleep settles against a restarted price engine, which is a
   payout you cannot defend. Upgrade both services to a paid instance.

2. **Fund the payout wallet and set the float.** Console → The book → Money
   behind the book. Until it is above zero no live position can open. Largest
   live trade is float ÷ 12.

3. **Re-tune the house edge** after a few live days — see `TRADE_HOUSE_EDGE` in
   `server/src/env.ts` for how, and why 11% is currently wrong for a product
   where one tap places three trades.

4. **Licensing.** BCLB is the regulator for this in Kenya.

---

## Route B — running it on your own hosting

You need a host that runs **Node 22** and lets you keep a process alive: a VPS,
a container platform, or Node-capable app hosting. Shared cPanel hosting that
only serves PHP and static files will not run this.

### What is in the box

```
server/        Express API, price engine, WebSocket, settlement
client/        the trading app (React, built to static files)
client-admin/  the operations console (React, built to static files)
supabase/      database schema and functions
scripts/       verify-epoch.mjs — replays a price epoch from its published seed
```

One process serves everything. `APP_MODE` decides which face it shows:
`trader` serves the trading app and the API, `admin` serves the console only.

### Build

```bash
npm install
npm run build
```

That installs all three workspaces and compiles the server to `server/dist`.
The clients build to `client/dist` and `client-admin/dist`, which the server
serves directly — there is no separate web server to configure.

### Run

```bash
NODE_ENV=production npm start
```

It listens on `PORT` (default 10000). Put a reverse proxy in front of it for
TLS — Caddy is the least work, nginx is fine:

```
fpesa.markets {
    reverse_proxy localhost:10000
}
```

The proxy must pass WebSocket upgrades through to `/ws`, or prices will not
stream. Caddy does this by default; nginx needs `proxy_set_header Upgrade` and
`Connection "upgrade"`.

### Environment

Copy `.env.example` to `.env` and fill it in. The ones without safe defaults:

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key — server only, never the browser |
| `JWT_SECRET` | 32+ random characters; changing it logs everyone out |
| `PUBLIC_URL` | `https://fpesa.markets` — the M-Pesa callback is built from this |
| `INTASEND_SECRET_KEY` | from IntaSend |
| `INTASEND_WEBHOOK_TOKEN` | the secret path segment above |
| `INTASEND_WEBHOOK_CHALLENGE` | the challenge you set in IntaSend |

Everything else has a working default; the comments in `server/src/env.ts`
explain what each one does and what it costs you to change it.

Two settings that must never be wrong together: `PAYMENTS_MOCK=true` with
`NODE_ENV=production` credits deposits without taking any money. The server
refuses to start in that combination rather than let it happen by accident.

### The console

Run a **second** process from the same code with `APP_MODE=admin` and
`UPSTREAM_URL=https://fpesa.markets`, on its own hostname
(`ops.fpesa.markets`). It shares the database but ships none of the trading app,
runs no price engine of its own, and issues its own session cookie scoped to its
own host — which is why a stolen console session cannot reach the trading API.

Do not merge the two into one process. The separation is the security boundary.

### The sandbox

A **third** process, `APP_MODE=sandbox`, on its own hostname. It exists to make
the price engine's determinism inspectable: it runs its own market and shows
every future tick of it, plus the exact profit any position opened right now
would make.

Give it `JWT_SECRET`, `SANDBOX_PASSPHRASE` (12 characters or more) and nothing
else. In particular it must **not** have `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `PALPLUSS_API_KEY`, `INTASEND_SECRET_KEY` or a
webhook token — it refuses to start if any of them are present, and names the
offending variable when it does. It keeps its book in memory and has no payment
provider, so it needs none of them.

Three things worth being clear about, because the screen invites the wrong
conclusion:

- **Its prices are not the live market's.** The seeds are generated by that
  process when it boots. Same code, different random numbers.
- **It cannot be repointed at live.** It does not read the live price feed, and
  no endpoint anywhere returns a running engine's seed while its epoch is open.
  Wiring the oracle to the trading service would mean holding the outcomes of
  positions real customers have staked money on, while the site publishes a
  commitment saying nobody does. That is the line the commitment scheme exists
  to draw.
- **There is nothing to learn from watching it.** The path is a driftless random
  walk. The only reason it is knowable in advance is that the secret is being
  handed over on purpose.

Restarting the service wipes every balance and position in it. That is intended:
nothing in there should ever be worth keeping.

### Database

The schema is already applied to the live Supabase project. If you ever point
this at a fresh project, apply everything in `supabase/migrations/` in filename
order, then the functions that were added later — ask me and I will export them
as a single file.

Every table has row-level security on with no policies: the API reaches the data
with the service role key and the browser never receives a Supabase key of any
kind. That is deliberate. Do not add a policy to "make it work" from the client.
