-- Balderdash companion: schema, privileges and Row Level Security.
--
-- Design: clients never read or write game tables directly. Every table has
-- RLS enabled and all table privileges revoked from the client roles. The one
-- exception is SELECT on public.rooms (members only), which carries no secret
-- data and exists so Supabase Realtime can tell a client "something changed".
-- Everything else goes through the SECURITY DEFINER functions in the next
-- migration, which decide per caller what may be seen.

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------- tables --

create table public.app_config (
  key   text primary key,
  value text not null
);
insert into public.app_config (key, value) values
  ('room_inactivity_hours', '6'),      -- a room untouched this long is deleted
  ('ended_retention_minutes', '30'),   -- an ended room is deleted after this
  ('max_players', '24'),
  ('presence_seconds', '15');          -- silent longer than this = shown as away

create table public.rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  host_player_id   uuid,
  mode             text not null check (mode in ('physical', 'digital')),
  status           text not null default 'lobby' check (status in ('lobby', 'playing', 'ended')),
  current_round_id uuid,
  version          bigint not null default 1,
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

create table public.players (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms (id) on delete cascade,
  user_id         uuid not null,
  name            text not null,
  join_order      int  not null,
  rotation_pos    int  not null,
  state           text not null default 'active' check (state in ('active', 'left', 'removed')),
  last_seen_at    timestamptz not null default now(),
  rejoin_hash     text,
  rejoin_expires  timestamptz,
  created_at      timestamptz not null default now(),
  unique (room_id, user_id)
);
create index players_room_idx on public.players (room_id);

create table public.rounds (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.rooms (id) on delete cascade,
  number            int  not null,
  reader_id         uuid not null references public.players (id),
  scheduled_pos     int  not null,           -- rotation cursor for this round
  former_reader_ids uuid[] not null default '{}',
  word              text,                    -- public once state <> card_selection
  card_source       text not null check (card_source in ('physical', 'digital', 'manual_fallback')),
  state             text not null default 'card_selection'
                    check (state in ('card_selection', 'collecting', 'reading', 'reveal', 'done')),
  reader_skipped    boolean not null default false,
  state_version     int not null default 1,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  unique (room_id, number)
);

-- The correct definition lives apart from the round row.
create table public.round_secrets (
  round_id       uuid primary key references public.rounds (id) on delete cascade,
  definition     text not null,
  word_id        bigint,
  pronunciation  text,
  part_of_speech text
);

-- Who is expected to play this round, fixed when the round begins.
create table public.round_eligible (
  round_id  uuid not null references public.rounds (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  primary key (round_id, player_id)
);

create table public.submissions (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.rounds (id) on delete cascade,
  player_id  uuid not null references public.players (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_id, player_id)
);

-- Anonymous reading projection: what the reader's screen is built from.
create table public.shuffled_definitions (
  id       uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  position int  not null,
  body     text not null,
  unique (round_id, position)
);

-- Correctness and authorship, kept apart until the reveal.
create table public.shuffled_private (
  definition_id    uuid primary key references public.shuffled_definitions (id) on delete cascade,
  is_correct       boolean not null,
  author_player_id uuid references public.players (id) on delete set null
);

create table public.words (
  id             bigint generated always as identity primary key,
  word           text not null unique,
  definition     text not null,
  part_of_speech text,
  pronunciation  text,
  source         text not null,
  source_ref     text,
  license        text not null,
  verification   text not null,
  difficulty     text not null
);

create table public.used_cards (
  room_id uuid   not null references public.rooms (id) on delete cascade,
  word_id bigint not null references public.words (id) on delete cascade,
  primary key (room_id, word_id)
);

create table public.rate_limits (
  user_id      uuid not null,
  action       text not null,
  window_start timestamptz not null default now(),
  count        int not null default 0,
  primary key (user_id, action)
);

-- ------------------------------------------------- privileges and RLS --

do $$
declare t text;
begin
  foreach t in array array[
    'app_config', 'rooms', 'players', 'rounds', 'round_secrets', 'round_eligible',
    'submissions', 'shuffled_definitions', 'shuffled_private', 'words',
    'used_cards', 'rate_limits'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Membership test used by the one policy below. SECURITY DEFINER because the
-- caller cannot read public.players.
create or replace function private.is_member(p_room_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.players
    where room_id = p_room_id and user_id = auth.uid() and state = 'active'
  );
$$;
revoke all on function private.is_member(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid) to authenticated;

grant select on public.rooms to authenticated;
create policy rooms_member_select on public.rooms
  for select to authenticated
  using (private.is_member(id));

-- Realtime: only public.rooms is published. Its rows hold no secrets.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.rooms;
  end if;
end $$;
