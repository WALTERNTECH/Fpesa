-- Fpesa core schema.
-- Applied to the Supabase project on first deploy. Every table has RLS enabled
-- with no policies: the API server reaches the data with the service role key,
-- and the browser never receives a Supabase key of any kind.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------------------------------------------------------------- users
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  username       citext not null unique,
  phone          text   not null unique,
  password_hash  text   not null,
  demo_balance   numeric(14,2) not null default 10000.00,
  real_balance   numeric(14,2) not null default 0.00,
  is_active      boolean not null default true,
  is_admin       boolean not null default false,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  constraint users_username_len check (char_length(username::text) between 3 and 20),
  constraint users_phone_fmt    check (phone ~ '^2547[0-9]{8}$' or phone ~ '^2541[0-9]{8}$'),
  constraint users_demo_nonneg  check (demo_balance >= 0),
  constraint users_real_nonneg  check (real_balance >= 0)
);

-- ---------------------------------------------------------------- trades
create table if not exists public.trades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  account_mode  text not null check (account_mode in ('demo','real')),
  symbol        text not null default 'XAUUSD',
  direction     text not null check (direction in ('BUY','SELL')),
  stake         numeric(14,2) not null check (stake >= 50 and stake <= 20000),
  duration_sec  integer not null check (duration_sec in (5,10,15,30,60)),
  payout_rate   numeric(5,4) not null default 0.8700,
  entry_price   numeric(18,6) not null,
  exit_price    numeric(18,6),
  payout        numeric(14,2),
  profit        numeric(14,2),
  status        text not null default 'OPEN'
                check (status in ('OPEN','WON','LOST','TIE','VOID')),
  opened_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  settled_at    timestamptz
);
create index if not exists trades_user_idx    on public.trades(user_id, opened_at desc);
create index if not exists trades_open_idx    on public.trades(status, expires_at)
  where status = 'OPEN';
create index if not exists trades_settled_idx on public.trades(settled_at desc)
  where settled_at is not null;

-- ---------------------------------------------------------- transactions
create table if not exists public.transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  kind                text not null check (kind in ('DEPOSIT','WITHDRAWAL')),
  amount              numeric(14,2) not null check (amount > 0),
  status              text not null default 'PENDING'
                      check (status in ('PENDING','SUCCESS','FAILED','CANCELLED','EXPIRED')),
  phone               text not null,
  provider            text not null default 'palpluss',
  provider_txn_id     text,
  reference           text not null unique,
  mpesa_receipt       text,
  result_code         text,
  result_desc         text,
  balance_applied     boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists tx_user_idx     on public.transactions(user_id, created_at desc);
create index if not exists tx_provider_idx on public.transactions(provider_txn_id);
create index if not exists tx_pending_idx  on public.transactions(status)
  where status = 'PENDING';

-- ---------------------------------------------------------- chat_messages
create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.users(id) on delete set null,
  username   text not null,
  body       text not null check (char_length(body) between 1 and 400),
  created_at timestamptz not null default now()
);
create index if not exists chat_recent_idx on public.chat_messages(created_at desc);

-- ---------------------------------------------------------- activity_feed
create table if not exists public.activity_feed (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('DEPOSIT','WITHDRAWAL','BIG_WIN')),
  username   text not null,
  amount     numeric(14,2) not null,
  created_at timestamptz not null default now()
);
create index if not exists feed_recent_idx on public.activity_feed(created_at desc);

alter table public.users         enable row level security;
alter table public.trades        enable row level security;
alter table public.transactions  enable row level security;
alter table public.chat_messages enable row level security;
alter table public.activity_feed enable row level security;
