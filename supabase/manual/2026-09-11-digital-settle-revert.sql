-- ============================================================================
-- Fpesa — undo: restore fpesa_settle_trade to its pre-digital text
--
-- Run this in the Supabase SQL editor if anything about the digital branch
-- misbehaves:
--   https://supabase.com/dashboard/project/mrsxvdxaoogamhkdqejp/sql/new
--
-- Safe at any time. With DIGITAL_ENABLED false, removing the branch changes no
-- behaviour at all — there are no DIGITAL rows for it to serve. If the flag is
-- on, turn it off first, or digitals would settle through the scaled path and
-- pay the wrong amount.
--
-- This is the exact function that has been running in production all along,
-- reproduced from pg_get_functiondef.
-- ============================================================================

create or replace function public.fpesa_settle_trade(
  p_trade uuid,
  p_exit numeric,
  p_reason text default 'EXPIRY'::text
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_trade   public.trades;
  v_status  text;
  v_move    numeric;
  v_payout  numeric(14,2);
  v_profit  numeric(14,2);
  v_balance numeric(14,2);
begin
  select * into v_trade from public.trades
    where id = p_trade and status = 'OPEN' for update;
  if not found then
    return json_build_object('already_settled', true);
  end if;

  -- Fractional move in the trader's favour.
  v_move := (p_exit - v_trade.entry_price) / v_trade.entry_price;
  if v_trade.direction = 'SELL' then
    v_move := -v_move;
  end if;

  v_profit := round(v_trade.stake * v_trade.multiplier * v_move, 2);

  -- The stake is the whole downside: a position can be wiped out but can
  -- never take the account negative. Upside is capped for solvency.
  if v_profit < -v_trade.stake then
    v_profit := -v_trade.stake;
  end if;
  if v_trade.max_profit is not null and v_profit > v_trade.max_profit then
    v_profit := v_trade.max_profit;
  end if;

  v_payout := v_trade.stake + v_profit;
  if v_payout < 0 then v_payout := 0; end if;

  if v_profit > 0 then
    v_status := 'WON';
  elsif v_profit < 0 then
    v_status := 'LOST';
  else
    v_status := 'TIE';
  end if;

  update public.trades set
    exit_price = p_exit, payout = v_payout, profit = v_profit,
    status = v_status, settled_at = now(), close_reason = p_reason
  where id = p_trade
  returning * into v_trade;

  if v_payout > 0 then
    if v_trade.account_mode = 'demo' then
      update public.users set demo_balance = demo_balance + v_payout
        where id = v_trade.user_id returning demo_balance into v_balance;
    else
      update public.users set real_balance = real_balance + v_payout
        where id = v_trade.user_id returning real_balance into v_balance;
    end if;
  else
    select case when v_trade.account_mode = 'demo' then demo_balance else real_balance end
      into v_balance from public.users where id = v_trade.user_id;
  end if;

  return json_build_object('trade', row_to_json(v_trade), 'balance', v_balance);
end;
$function$;
