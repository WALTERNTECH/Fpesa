-- ============================================================================
-- Fpesa — add the digital branch to fpesa_settle_trade
--
-- Run this in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/mrsxvdxaoogamhkdqejp/sql/new
-- Paste the whole file, press Run. It is one statement and it is idempotent —
-- running it twice is harmless.
--
-- WHAT IT CHANGES
--   The SCALED path is the current function line for line, moved inside an
--   `else`. The only structural difference is that v_payout is computed after
--   the branch instead of before it, which is free: payout does not depend on
--   status and status does not depend on payout.
--
--   The new DIGITAL branch decides a position by one comparison against the
--   barrier fixed when it opened, and pays the amount fixed when it opened.
--
-- WHY IT IS SAFE TO RUN NOW
--   Every one of the 436 existing trades has trade_type = 'SCALED', and
--   DIGITAL_ENABLED is false, so nothing can write a DIGITAL row. The new
--   branch therefore has nothing to serve until you turn the flag on, and the
--   path every real trade takes is unchanged.
--
-- TO UNDO
--   supabase/manual/2026-09-11-digital-settle-revert.sql restores the original.
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

  if v_trade.trade_type = 'DIGITAL' then
    -- One comparison against a barrier fixed at open, paying an amount fixed at
    -- open. How far price travelled past the barrier changes nothing, which is
    -- the whole difference between the two products.
    if (v_trade.direction = 'BUY'  and p_exit > v_trade.barrier_price)
    or (v_trade.direction = 'SELL' and p_exit < v_trade.barrier_price) then
      v_profit := coalesce(v_trade.max_profit, 0);
      v_status := 'WON';
    else
      v_profit := -v_trade.stake;
      v_status := 'LOST';
    end if;
  else
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

    if v_profit > 0 then
      v_status := 'WON';
    elsif v_profit < 0 then
      v_status := 'LOST';
    else
      v_status := 'TIE';
    end if;
  end if;

  v_payout := v_trade.stake + v_profit;
  if v_payout < 0 then v_payout := 0; end if;

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
