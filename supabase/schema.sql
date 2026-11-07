-- SplitPilot: complete schema. Safe to run on a fresh project or re-run.
-- Paste into Supabase -> SQL Editor -> Run.

create extension if not exists "pgcrypto";

create table if not exists splits (
  id uuid primary key default gen_random_uuid(),
  owner_name text not null,
  title text not null,
  venue text,
  lat double precision,
  lng double precision,
  currency text not null default 'USD',
  subtotal numeric(10,2) not null default 0,
  tax numeric(10,2) not null default 0,
  tip numeric(10,2) not null default 0,
  total numeric(10,2) not null check (total >= 0),
  receipt_path text,
  status text not null default 'open' check (status in ('open','settled')),
  created_at timestamptz not null default now()
);
alter table splits add column if not exists subtotal numeric(10,2) not null default 0;
alter table splits add column if not exists tax numeric(10,2) not null default 0;
alter table splits add column if not exists tip numeric(10,2) not null default 0;
alter table splits add column if not exists receipt_path text;

-- Owner secret lives here; accessible only to trusted server-side code.
create table if not exists split_secrets (
  split_id uuid primary key references splits(id) on delete cascade,
  owner_key text not null
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  split_id uuid not null references splits(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null,
  quantity int not null default 1
);

create table if not exists participants (
  id uuid primary key default gen_random_uuid(),
  split_id uuid not null references splits(id) on delete cascade,
  name text not null,
  share numeric(10,2) not null check (share > 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  paypal_order_id text,
  paypal_capture_id text,
  paid_at timestamptz,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now()
);
alter table participants add column if not exists last_reminded_at timestamptz;
alter table participants add column if not exists created_at timestamptz not null default now();
create index if not exists participants_split_idx on participants(split_id);
create index if not exists participants_order_idx on participants(paypal_order_id);

-- Payment events log; accessible only to trusted server-side code.
create table if not exists payment_events (
  id text primary key,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- One feed for chat, proposals, reminders and payment events.
create table if not exists agent_log (
  id uuid primary key default gen_random_uuid(),
  split_id uuid references splits(id) on delete cascade,
  action text not null,
  reasoning text,
  payload jsonb,
  approved_by_human boolean,
  status text,
  created_at timestamptz not null default now()
);
alter table agent_log add column if not exists status text;
create index if not exists agent_log_split_idx on agent_log(split_id, created_at);

-- Row Level Security: enabled on all six application tables.
alter table splits enable row level security;
alter table split_secrets enable row level security;
alter table items enable row level security;
alter table participants enable row level security;
alter table payment_events enable row level security;
alter table agent_log enable row level security;

-- Remove unrestricted anonymous SELECT policies
drop policy if exists "anon read splits" on splits;
drop policy if exists "anon read items" on items;
drop policy if exists "anon read participants" on participants;
drop policy if exists "anon read agent_log" on agent_log;

-- Explicitly revoke all table privileges from public, anon and authenticated roles
revoke all on table splits from public, anon, authenticated;
revoke all on table split_secrets from public, anon, authenticated;
revoke all on table items from public, anon, authenticated;
revoke all on table participants from public, anon, authenticated;
revoke all on table payment_events from public, anon, authenticated;
revoke all on table agent_log from public, anon, authenticated;

-- Ensure service_role retains all privileges needed by backend
grant all on table splits to service_role;
grant all on table split_secrets to service_role;
grant all on table items to service_role;
grant all on table participants to service_role;
grant all on table payment_events to service_role;
grant all on table agent_log to service_role;

-- Private bucket for receipt photos (served only through short-lived signed URLs).
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = false;
