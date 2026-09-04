-- Every balance mutation goes through these functions. Each one takes a row
-- lock before it reads, so two concurrent requests can never interleave a
-- read-modify-write on the same balance.

-- ------------------------------------------------------------ place a trade
create or replace function public.fpesa_place_trade(
  p_user uuid, p_mode text, p_direction text, p_stake numeric,
  p_duration integer, p_entry numeric, p_payout_rate numeric,
  p_symbol text default 'XAUUSD'
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric(14,2);
  v_trade   public.trades;
begin
  if p_mode = 'demo' then
    select demo_balance into v_balance from public.users where id = p_user for update;
  else
    select real_balance into v_balance from public.users where id = p_user for update;
  end if;

  if v_balance is null then raise exception 'USER_NOT_FOUND'; end if;
  if v_balance < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;

  if p_mode = 'demo' then
    update public.users set demo_balance = demo_balance - p_stake where id = p_user
      returning demo_balance into v_balance;
  else
    update public.users set real_balance = real_balance - p_stake where id = p_user
      returning real_balance into v_balance;
  end if;

  insert into public.trades
    (user_id, account_mode, symbol, direction, stake, duration_sec,
     payout_rate, entry_price, expires_at)
  values
    (p_user, p_mode, p_symbol, p_direction, p_stake, p_duration,
     p_payout_rate, p_entry, now() + make_interval(secs => p_duration))
  returning * into v_trade;

  return json_build_object('trade', row_to_json(v_trade), 'balance', v_balance);
end;
$$;

-- ----------------------------------------------------------- settle a trade
create or replace function public.fpesa_settle_trade(p_trade uuid, p_exit numeric)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_trade   public.trades;
  v_status  text;
  v_payout  numeric(14,2);
  v_profit  numeric(14,2);
  v_balance numeric(14,2);
begin
  -- Claim the trade; if another worker already settled it, bail out cleanly.
  select * into v_trade from public.trades
    where id = p_trade and status = 'OPEN' for update;
  if not found then
    return json_build_object('already_settled', true);
  end if;

  if (v_trade.direction = 'BUY'  and p_exit > v_trade.entry_price)
  or (v_trade.direction = 'SELL' and p_exit < v_trade.entry_price) then
    v_status := 'WON';
    v_payout := round(v_trade.stake * (1 + v_trade.payout_rate), 2);
  elsif p_exit = v_trade.entry_price then
    v_status := 'TIE';
    v_payout := v_trade.stake;
  else
    v_status := 'LOST';
    v_payout := 0;
  end if;

  v_profit := v_payout - v_trade.stake;

  update public.trades set
    exit_price = p_exit, payout = v_payout, profit = v_profit,
    status = v_status, settled_at = now()
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
$$;

-- --------------------------------------------------- apply a settled deposit
-- Idempotent: balance_applied means a webhook replay cannot credit twice.
create or replace function public.fpesa_apply_deposit(
  p_reference text, p_status text, p_receipt text default null,
  p_result_code text default null, p_result_desc text default null,
  p_provider_id text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_tx       public.transactions;
  v_balance  numeric(14,2);
  v_credited boolean := false;
begin
  select * into v_tx from public.transactions
    where reference = p_reference and kind = 'DEPOSIT' for update;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;

  if v_tx.balance_applied then
    select real_balance into v_balance from public.users where id = v_tx.user_id;
    return json_build_object('transaction', row_to_json(v_tx),
                             'balance', v_balance, 'duplicate', true);
  end if;

  if p_status = 'SUCCESS' then
    update public.users set real_balance = real_balance + v_tx.amount
      where id = v_tx.user_id returning real_balance into v_balance;
    v_credited := true;
  else
    select real_balance into v_balance from public.users where id = v_tx.user_id;
  end if;

  update public.transactions set
    status = p_status,
    mpesa_receipt   = coalesce(p_receipt, mpesa_receipt),
    result_code     = coalesce(p_result_code, result_code),
    result_desc     = coalesce(p_result_desc, result_desc),
    provider_txn_id = coalesce(p_provider_id, provider_txn_id),
    balance_applied = v_credited,
    updated_at = now()
  where id = v_tx.id
  returning * into v_tx;

  if v_credited then
    insert into public.activity_feed (kind, username, amount)
    select 'DEPOSIT', u.username::text, v_tx.amount
      from public.users u where u.id = v_tx.user_id;
  end if;

  return json_build_object('transaction', row_to_json(v_tx),
                           'balance', v_balance, 'credited', v_credited);
end;
$$;

-- --------------------------------------------------- reserve a withdrawal
-- Funds leave the balance the moment a payout is requested, so the same money
-- cannot also be staked while the transfer is in flight.
create or replace function public.fpesa_reserve_withdrawal(
  p_user uuid, p_amount numeric, p_phone text, p_reference text
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric(14,2);
  v_tx      public.transactions;
begin
  select real_balance into v_balance from public.users where id = p_user for update;
  if v_balance is null then raise exception 'USER_NOT_FOUND'; end if;
  if v_balance < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;

  if exists (select 1 from public.transactions
               where user_id = p_user and kind = 'WITHDRAWAL' and status = 'PENDING') then
    raise exception 'WITHDRAWAL_IN_FLIGHT';
  end if;

  update public.users set real_balance = real_balance - p_amount
    where id = p_user returning real_balance into v_balance;

  insert into public.transactions (user_id, kind, amount, phone, reference, balance_applied)
  values (p_user, 'WITHDRAWAL', p_amount, p_phone, p_reference, true)
  returning * into v_tx;

  return json_build_object('transaction', row_to_json(v_tx), 'balance', v_balance);
end;
$$;

-- -------------------------------------------------- finalise a withdrawal
-- On anything other than SUCCESS the reserved funds go straight back.
create or replace function public.fpesa_settle_withdrawal(
  p_reference text, p_status text, p_receipt text default null,
  p_result_code text default null, p_result_desc text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_tx      public.transactions;
  v_balance numeric(14,2);
begin
  select * into v_tx from public.transactions
    where reference = p_reference and kind = 'WITHDRAWAL' for update;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;

  if v_tx.status <> 'PENDING' then
    select real_balance into v_balance from public.users where id = v_tx.user_id;
    return json_build_object('transaction', row_to_json(v_tx),
                             'balance', v_balance, 'duplicate', true);
  end if;

  if p_status <> 'SUCCESS' then
    update public.users set real_balance = real_balance + v_tx.amount
      where id = v_tx.user_id returning real_balance into v_balance;
  else
    select real_balance into v_balance from public.users where id = v_tx.user_id;
    insert into public.activity_feed (kind, username, amount)
    select 'WITHDRAWAL', u.username::text, v_tx.amount
      from public.users u where u.id = v_tx.user_id;
  end if;

  update public.transactions set
    status = p_status,
    mpesa_receipt = coalesce(p_receipt, mpesa_receipt),
    result_code   = coalesce(p_result_code, result_code),
    result_desc   = coalesce(p_result_desc, result_desc),
    balance_applied = (p_status = 'SUCCESS'),
    updated_at = now()
  where id = v_tx.id
  returning * into v_tx;

  return json_build_object('transaction', row_to_json(v_tx), 'balance', v_balance);
end;
$$;

-- ------------------------------------------------------- daily leaderboard
-- Real-money trades only, settled since midnight Nairobi time.
create or replace function public.fpesa_leaderboard(p_limit integer default 5)
returns table (username text, profit numeric, wins bigint, trades bigint)
language sql stable security definer set search_path = public as $$
  select u.username::text,
         sum(t.profit)::numeric                           as profit,
         count(*) filter (where t.status = 'WON')::bigint as wins,
         count(*)::bigint                                 as trades
    from public.trades t
    join public.users u on u.id = t.user_id
   where t.account_mode = 'real'
     and t.status in ('WON','LOST','TIE')
     and t.settled_at >= (date_trunc('day', now() at time zone 'Africa/Nairobi')
                            at time zone 'Africa/Nairobi')
   group by u.username
  having sum(t.profit) > 0
   order by profit desc
   limit p_limit;
$$;
