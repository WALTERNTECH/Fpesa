# Database schema — where it actually lives

`migrations/0001_core_schema.sql` and `0002_money_functions.sql` are the original
schema. **Ten further migrations were applied directly to the live Supabase
project and are not in this repository.** They added:

| Migration | What it added |
|---|---|
| `fpesa_proportional_pnl` | proportional profit/loss, stop-out and take-profit levels on `trades` |
| `fpesa_daily_exposure` | `fpesa_daily_exposure()` — the daily payout ratio |
| `fpesa_turnover_requirement` | `turnover_required` / `turnover_progress` on `users` |
| `fpesa_admin_overview` | `fpesa_admin_overview()` |
| `fpesa_trade_runs` | `trade_runs` table, `fpesa_advance_run`, `fpesa_abort_run` |
| `fpesa_auto_direction_runs` | AUTO direction on runs |
| `fpesa_raise_max_stake` | stake ceiling |
| `fpesa_markets_and_admin_credit` | `admin_adjustments`, `fpesa_admin_adjust_balance`, `fpesa_user_statement` |
| `fpesa_statement_overrides` | `statement_overrides`, `statement_override_log` |
| `fpesa_operator_float_setting` | `platform_settings`, `fpesa_set_operator_float`, `fpesa_book_float` |

This matters only if the Supabase project is ever lost or you point the app at a
fresh one. The live database is the source of truth today, and the app works
against it.

## Exporting the real thing

The reliable way to get a complete, runnable schema file is to dump it from the
live project rather than reassemble it by hand — these are locking money
functions, and a transcription slip in one would be worse than not having the
file at all.

```bash
npx supabase login
npx supabase link --project-ref mrsxvdxaoogamhkdqejp
npx supabase db dump -f supabase/migrations/0003_current_schema.sql
```

Run that and commit the result. It captures every table, constraint, index and
function exactly as the live database has them.

## Tables added after 0002

For reference, so you can see the shape without a dump:

```sql
-- Batches placed by Fpesa Auto. A run stays on one instrument.
trade_runs(
  id uuid pk, user_id uuid, account_mode text, direction text,
  symbol text not null default 'FPX100',
  stake numeric, duration_sec int, total_count int,
  completed_count int default 0, net_profit numeric default 0,
  status text default 'RUNNING', abort_reason text,
  created_at timestamptz, finished_at timestamptz)

-- Every manual balance change, with the balance either side of it.
admin_adjustments(
  id uuid pk, admin_id uuid, user_id uuid, account_mode text,
  amount numeric, balance_before numeric, balance_after numeric,
  reason text not null, created_at timestamptz)

-- Hand-corrected lifetime figures, sitting on top of the derived ones.
statement_overrides(
  user_id uuid pk, deposits numeric, withdrawals numeric,
  trades int, net_vs_deposits numeric,
  reason text not null, updated_by uuid, updated_at timestamptz)

statement_override_log(
  id uuid pk, user_id uuid, admin_id uuid,
  deposits numeric, withdrawals numeric, trades int, net_vs_deposits numeric,
  reason text not null, created_at timestamptz)

-- Operator float, set from the console rather than the deploy config.
platform_settings(
  key text pk, value numeric not null,
  reason text not null, updated_by uuid, updated_at timestamptz)

platform_settings_log(
  id uuid pk, key text, old_value numeric, new_value numeric not null,
  admin_id uuid, reason text not null, created_at timestamptz)
```

Every one of these has row-level security enabled with no policies, like the
original tables: the API reaches them with the service role key and the browser
never receives a Supabase key.
