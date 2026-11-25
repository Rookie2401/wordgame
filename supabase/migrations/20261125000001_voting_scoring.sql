-- Voting and scoring expansion.
--
-- Extends the existing engine; nothing is replaced. Rooms created before this
-- migration (and rooms created in "traditional" mode) keep the original flow:
--   card_selection -> collecting -> reading -> reveal -> done
-- Rooms with digital scoring use:
--   card_selection -> collecting -> adjudicating -> reading -> voting
--     -> voting_closed -> reveal -> results -> done
-- ('adjudicating' is skipped when there is nothing to adjudicate; 'results'
-- is the settled round, the brief's ROUND_RESULTS.)
--
-- As before, clients have no table access. Everything is reached through
-- SECURITY DEFINER functions that take the room's row lock, and get_state
-- decides per caller what may be seen at the current stage.

-- ---------------------------------------------------------------- schema --

alter table public.rooms
  add column scoring        text not null default 'traditional' check (scoring in ('digital', 'traditional')),
  add column win_type       text not null default 'unlimited' check (win_type in ('target', 'rotations', 'unlimited')),
  add column target_score   int check (target_score between 5 and 1000),
  add column rotation_limit int check (rotation_limit between 1 and 50),
  add column game_number    int not null default 1,   -- goes up with each rematch
  add column ruleset        jsonb;                    -- frozen when the game starts

alter table public.rounds
  add column game_number        int not null default 1,
  add column rotation           int not null default 1,
  add column settled_at         timestamptz,
  add column settlement_version int;

alter table public.rounds drop constraint rounds_state_check;
alter table public.rounds add constraint rounds_state_check check (state in (
  'card_selection', 'collecting', 'adjudicating', 'reading', 'voting',
  'voting_closed', 'reveal', 'results', 'done'));
alter table public.rounds drop constraint rounds_room_id_number_key;
alter table public.rounds add constraint rounds_room_game_number_key unique (room_id, game_number, number);

-- 0 hidden, 1 voters shown, 2 author and correctness shown.
alter table public.shuffled_definitions
  add column reveal_stage int not null default 0 check (reveal_stage between 0 and 2),
  add constraint shuffled_definitions_id_round_key unique (id, round_id);

-- Who reads in each pass round the table, fixed when the pass begins.
create table public.rotation_members (
  room_id     uuid not null references public.rooms (id) on delete cascade,
  game_number int  not null,
  rotation    int  not null,
  player_id   uuid not null references public.players (id) on delete cascade,
  primary key (room_id, game_number, rotation, player_id)
);

-- A written definition the reader accepted as substantially correct.
create table public.adjudications (
  submission_id uuid primary key references public.submissions (id) on delete cascade,
  round_id      uuid not null references public.rounds (id) on delete cascade,
  player_id     uuid not null references public.players (id) on delete cascade,
  reader_id     uuid not null,
  decided_at    timestamptz not null default now()
);

-- Who may vote this round, fixed when voting opens.
create table public.round_voters (
  round_id  uuid not null references public.rounds (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  primary key (round_id, player_id)
);

create table public.votes (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references public.rounds (id) on delete cascade,
  voter_id      uuid not null references public.players (id) on delete cascade,
  definition_id uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (round_id, voter_id),
  -- the chosen definition must belong to the same round as the ballot
  foreign key (definition_id, round_id) references public.shuffled_definitions (id, round_id) on delete cascade
);

-- The scoring ledger. Standings are always derived from it.
create table public.score_events (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  game_number int  not null,
  round_id    uuid references public.rounds (id) on delete cascade,
  player_id   uuid not null references public.players (id) on delete cascade,
  category    text not null check (category in (
                'CORRECT_GUESS', 'SUCCESSFUL_DECEPTION', 'CORRECT_WRITTEN_DEFINITION',
                'READER_BONUS', 'MANUAL_ADJUSTMENT')),
  points      int  not null,
  ref_id      uuid,          -- the vote or submission the points came from
  note        text,          -- reason, for manual adjustments
  created_by  uuid,          -- host who made a manual adjustment
  created_at  timestamptz not null default now(),
  idem_key    text not null unique
);
create index score_events_room_idx on public.score_events (room_id, game_number);

do $$
declare t text;
begin
  foreach t in array array['rotation_members', 'adjudications', 'round_voters', 'votes', 'score_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Games already in progress keep their reader order.
insert into public.rotation_members (room_id, game_number, rotation, player_id)
select p.room_id, 1, 1, p.id
  from public.players p join public.rooms r on r.id = p.room_id
 where r.status = 'playing' and p.state = 'active'
on conflict do nothing;

-- --------------------------------------------------------------- helpers --

create or replace function private.default_ruleset() returns jsonb
language sql immutable as $$
  select jsonb_build_object('version', 1, 'correct_guess', 2, 'deception', 1,
                            'correct_written', 3, 'reader_bonus', 3);
$$;

create or replace function private.begin_rotation(p_room public.rooms, p_rotation int) returns void
language sql volatile set search_path = public, pg_temp as $$
  insert into public.rotation_members (room_id, game_number, rotation, player_id)
  select p_room.id, p_room.game_number, p_rotation, id
    from public.players where room_id = p_room.id and state = 'active'
  on conflict do nothing;
$$;

-- Next member of this rotation who has not yet read and is still in the game.
create or replace function private.next_in_rotation(p_room public.rooms, p_rotation int, p_after_pos int)
returns public.players
language sql stable set search_path = public, pg_temp as $$
  select p.* from public.players p
    join public.rotation_members m on m.player_id = p.id
   where m.room_id = p_room.id and m.game_number = p_room.game_number and m.rotation = p_rotation
     and p.state = 'active' and p.rotation_pos > p_after_pos
   order by p.rotation_pos limit 1;
$$;

create or replace function private.max_total(p_room public.rooms) returns int
language sql stable set search_path = public, pg_temp as $$
  select coalesce(max(s), 0)::int from (
    select sum(e.points) as s
      from public.score_events e join public.players p on p.id = e.player_id
     where e.room_id = p_room.id and e.game_number = p_room.game_number and p.state <> 'removed'
     group by e.player_id) x;
$$;

-- True when the game should end once this round is over: the rotation is
-- complete and the room's winning condition is met. Corrections made by the
-- host count, because totals are read from the ledger at this moment.
create or replace function private.is_final(p_room public.rooms, p_round public.rounds) returns boolean
language plpgsql stable set search_path = public, pg_temp as $$
declare v_next public.players;
begin
  if p_room.win_type = 'unlimited' then return false; end if;
  v_next := private.next_in_rotation(p_room, p_round.rotation, p_round.scheduled_pos);
  if v_next.id is not null then return false; end if;       -- rotation not finished
  if p_room.win_type = 'rotations' then
    return p_round.rotation >= coalesce(p_room.rotation_limit, 1);
  end if;
  return private.max_total(p_room) >= coalesce(p_room.target_score, 25);
end $$;

-- Normalises the game-ending options chosen in the lobby.
create or replace function private.apply_rules(
  p_room_id uuid, p_scoring text, p_win_type text, p_target int, p_rotations int) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_scoring text := coalesce(p_scoring, 'traditional');
  v_win text := coalesce(p_win_type, 'unlimited');
begin
  if v_scoring not in ('digital', 'traditional') then perform private.fail('invalid_scoring'); end if;
  if v_win not in ('target', 'rotations', 'unlimited') then perform private.fail('invalid_win_type'); end if;
  if v_scoring = 'traditional' and v_win = 'target' then v_win := 'unlimited'; end if;  -- no scores to reach
  if v_win = 'target' and coalesce(p_target, 25) not between 5 and 1000 then perform private.fail('invalid_target'); end if;
  if v_win = 'rotations' and coalesce(p_rotations, 2) not between 1 and 50 then perform private.fail('invalid_rotations'); end if;
  update public.rooms
     set scoring = v_scoring, win_type = v_win,
         target_score = case when v_win = 'target' then coalesce(p_target, 25) end,
         rotation_limit = case when v_win = 'rotations' then coalesce(p_rotations, 2) end
   where id = p_room_id;
end $$;

-- ------------------------------------------------------------ standings --

create or replace function private.standings(p_room public.rooms) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with last_round as (
    select id from public.rounds
     where room_id = p_room.id and game_number = p_room.game_number and settled_at is not null
     order by number desc limit 1),
  t as (
    select p.id, p.name, p.rotation_pos,
           coalesce((select sum(e.points) from public.score_events e
                      where e.room_id = p_room.id and e.game_number = p_room.game_number
                        and e.player_id = p.id), 0)::int as total,
           coalesce((select sum(e.points) from public.score_events e
                      where e.round_id = (select id from last_round) and e.player_id = p.id), 0)::int as last
      from public.players p
     where p.room_id = p_room.id and p.state <> 'removed'
       and (p.state = 'active' or exists (
             select 1 from public.score_events e
              where e.player_id = p.id and e.room_id = p_room.id and e.game_number = p_room.game_number)))
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', id, 'name', name, 'total', total, 'last', last, 'rank', rnk)
           order by rnk, rotation_pos), '[]'::jsonb)
    from (select *, rank() over (order by total desc) as rnk from t) x;   -- equal scores share a rank
$$;

-- Distinctions worked out from what actually happened. Ties are listed
-- together; a distinction nobody earned is left out.
create or replace function private.awards(p_room public.rooms) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_out jsonb := '[]'::jsonb;
  rec record;
begin
  for rec in
    with c as (
      select e.category, e.player_id, p.name, count(*)::int as n
        from public.score_events e join public.players p on p.id = e.player_id
       where e.room_id = p_room.id and e.game_number = p_room.game_number
         and e.category in ('SUCCESSFUL_DECEPTION', 'CORRECT_GUESS', 'READER_BONUS', 'CORRECT_WRITTEN_DEFINITION')
       group by e.category, e.player_id, p.name),
    m as (select category, max(n) as mx from c group by category)
    select c.category, m.mx, jsonb_agg(c.name order by c.name) as names
      from c join m on m.category = c.category and c.n = m.mx
     group by c.category, m.mx
     order by case c.category when 'SUCCESSFUL_DECEPTION' then 1 when 'CORRECT_GUESS' then 2
                              when 'READER_BONUS' then 3 else 5 end
  loop
    v_out := v_out || jsonb_build_object(
      'key', case rec.category when 'SUCCESSFUL_DECEPTION' then 'great_deceiver'
                               when 'CORRECT_GUESS' then 'lexicographer'
                               when 'READER_BONUS' then 'master_reader' else 'scholar' end,
      'count', rec.mx, 'names', rec.names);
  end loop;

  for rec in
    with d as (
      select d.id, d.body, pl.name, count(*)::int as n
        from public.votes v
        join public.shuffled_definitions d on d.id = v.definition_id
        join public.shuffled_private sp on sp.definition_id = d.id
        join public.rounds r on r.id = d.round_id
        join public.players pl on pl.id = sp.author_player_id
        join public.players voter on voter.id = v.voter_id
       where r.room_id = p_room.id and r.game_number = p_room.game_number
         and r.settled_at is not null and not sp.is_correct and voter.state <> 'removed'
       group by d.id, d.body, pl.name)
    select max(n) as mx,
           jsonb_agg(jsonb_build_object('name', name, 'text', body) order by name) filter (where n = (select max(n) from d)) as bluffs
      from d
  loop
    if rec.mx is not null then
      v_out := v_out || jsonb_build_object('key', 'convincing_bluff', 'count', rec.mx, 'bluffs', rec.bluffs);
    end if;
  end loop;
  return v_out;
end $$;

create or replace function private.player_stats(p_room public.rooms, p_player_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with rs as (
    select id, reader_id from public.rounds
     where room_id = p_room.id and game_number = p_room.game_number and settled_at is not null),
  ev as (
    select category, count(*)::int as n from public.score_events
     where room_id = p_room.id and game_number = p_room.game_number and player_id = p_player_id
     group by category)
  select jsonb_build_object(
    'correct_guesses', coalesce((select n from ev where category = 'CORRECT_GUESS'), 0),
    'incorrect_guesses', (select count(*)::int from public.votes v
                            join public.shuffled_private sp on sp.definition_id = v.definition_id
                           where v.voter_id = p_player_id and v.round_id in (select id from rs) and not sp.is_correct),
    'abstentions', (select count(*)::int from public.round_voters rv
                     where rv.player_id = p_player_id and rv.round_id in (select id from rs)
                       and not exists (select 1 from public.votes v
                                        where v.round_id = rv.round_id and v.voter_id = rv.player_id)),
    'votes_received', coalesce((select n from ev where category = 'SUCCESSFUL_DECEPTION'), 0),
    'reader_rounds', (select count(*)::int from rs where reader_id = p_player_id),
    'reader_bonuses', coalesce((select n from ev where category = 'READER_BONUS'), 0),
    'correct_written', coalesce((select n from ev where category = 'CORRECT_WRITTEN_DEFINITION'), 0),
    'best_bluff_votes', coalesce((select max(c) from (
        select count(*)::int as c from public.votes v
          join public.shuffled_private sp on sp.definition_id = v.definition_id
         where sp.author_player_id = p_player_id and not sp.is_correct and v.round_id in (select id from rs)
         group by v.definition_id) x), 0));
$$;

-- ------------------------------------------------------- round engine --

drop function private.start_round(public.rooms, int);

-- p_rotation = 0 starts the game's first rotation. Otherwise the next reader
-- is the next member of p_rotation after p_after_pos; when that rotation is
-- exhausted a new one begins with everyone then in the game, so a player who
-- joined part-way through first reads at a rotation boundary.
create or replace function private.start_round(p_room public.rooms, p_after_pos int, p_rotation int) returns uuid
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_reader public.players;
  v_rotation int := p_rotation;
  v_number int;
  v_round_id uuid;
begin
  if v_rotation > 0 then
    v_reader := private.next_in_rotation(p_room, v_rotation, p_after_pos);
  end if;
  if v_reader.id is null then
    v_rotation := v_rotation + 1;
    perform private.begin_rotation(p_room, v_rotation);
    v_reader := private.next_in_rotation(p_room, v_rotation, 0);
  end if;
  if v_reader.id is null then perform private.fail('no_players'); end if;

  select coalesce(max(number), 0) + 1 into v_number
    from public.rounds where room_id = p_room.id and game_number = p_room.game_number;
  insert into public.rounds (room_id, game_number, number, rotation, reader_id, scheduled_pos, card_source)
  values (p_room.id, p_room.game_number, v_number, v_rotation, v_reader.id, v_reader.rotation_pos,
          case when p_room.mode = 'digital' then 'digital' else 'physical' end)
  returning id into v_round_id;
  insert into public.round_eligible (round_id, player_id)
  select v_round_id, id from public.players where room_id = p_room.id and state = 'active';
  if p_room.mode = 'digital' then
    perform private.draw_card(v_round_id, p_room.id);
  end if;
  update public.rooms set current_round_id = v_round_id, status = 'playing' where id = p_room.id;
  return v_round_id;
end $$;

-- Shuffles the correct definition with every submission that was not accepted
-- as correct. Runs once per round, inside the room lock.
create or replace function private.shuffle_round(p_round_id uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  r public.rounds;
  v_correct text;
  v_ids uuid[];
  n int;
  perm int[];
  i int; j int; tmp int; k int;
  v_def_id uuid;
  s public.submissions;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.state not in ('collecting', 'adjudicating') then return; end if;
  select definition into v_correct from public.round_secrets where round_id = p_round_id;
  if v_correct is null then perform private.fail('card_missing'); end if;

  select coalesce(array_agg(s2.id order by s2.id), '{}') into v_ids
    from public.submissions s2
    join public.players p on p.id = s2.player_id
   where s2.round_id = p_round_id and p.state <> 'removed'
     and not exists (select 1 from public.adjudications a where a.submission_id = s2.id);

  n := coalesce(array_length(v_ids, 1), 0) + 1;
  select array_agg(g) into perm from generate_series(1, n) g;
  i := n;
  while i >= 2 loop
    j := private.rand_int(i) + 1;
    tmp := perm[i]; perm[i] := perm[j]; perm[j] := tmp;
    i := i - 1;
  end loop;

  for i in 1..n loop
    k := perm[i];
    v_def_id := gen_random_uuid();
    if k = n then
      insert into public.shuffled_definitions (id, round_id, position, body)
      values (v_def_id, p_round_id, i, v_correct);
      insert into public.shuffled_private (definition_id, is_correct, author_player_id)
      values (v_def_id, true, null);
    else
      select * into s from public.submissions where id = v_ids[k];
      insert into public.shuffled_definitions (id, round_id, position, body)
      values (v_def_id, p_round_id, i, s.body);
      insert into public.shuffled_private (definition_id, is_correct, author_player_id)
      values (v_def_id, false, s.player_id);
    end if;
  end loop;

  update public.rounds set state = 'reading', state_version = state_version + 1 where id = p_round_id;
end $$;

-- Submissions are closed. With digital scoring the reader first checks the
-- other players' definitions against the real one; otherwise straight to the
-- shuffle, as before.
create or replace function private.close_round(p_round_id uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  r public.rounds;
  v_scoring text;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.state <> 'collecting' then return; end if;
  select scoring into v_scoring from public.rooms where id = r.room_id;
  if v_scoring = 'digital' and exists (
       select 1 from public.submissions s join public.players p on p.id = s.player_id
        where s.round_id = p_round_id and s.player_id <> r.reader_id and p.state <> 'removed') then
    update public.rounds set state = 'adjudicating', state_version = state_version + 1 where id = p_round_id;
  else
    perform private.shuffle_round(p_round_id);
  end if;
end $$;

-- Moves the round on by itself when nobody is left to wait for: closes
-- submissions once all definitions are in, closes voting once all ballots are.
create or replace function private.maybe_close(p_round_id uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  r public.rounds;
  v_waiting int;
  v_reader_done boolean;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.state = 'collecting' then
    select count(*) into v_waiting
      from public.round_eligible e
      join public.players p on p.id = e.player_id
     where e.round_id = p_round_id
       and p.state = 'active'
       and p.id <> r.reader_id
       and not (p.id = any (r.former_reader_ids))
       and not exists (select 1 from public.submissions s
                       where s.round_id = p_round_id and s.player_id = p.id);
    v_reader_done := r.reader_skipped or exists (
      select 1 from public.submissions s where s.round_id = p_round_id and s.player_id = r.reader_id);
    if v_waiting = 0 and v_reader_done then
      perform private.close_round(p_round_id);
    end if;
  elsif r.state = 'voting' then
    select count(*) into v_waiting
      from public.round_voters rv
      join public.players p on p.id = rv.player_id
     where rv.round_id = p_round_id and p.state = 'active'
       and not exists (select 1 from public.votes v
                       where v.round_id = p_round_id and v.voter_id = rv.player_id);
    if v_waiting = 0 then
      update public.rounds set state = 'voting_closed', state_version = state_version + 1 where id = p_round_id;
    end if;
  end if;
end $$;

create or replace function private.change_reader(p_round_id uuid, p_new_reader uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare r public.rounds;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.reader_id = p_new_reader or r.state = 'done' then return; end if;
  if r.state = 'card_selection' then
    update public.rounds set reader_id = p_new_reader, state_version = state_version + 1
     where id = p_round_id;
    if r.card_source = 'digital' then
      perform private.draw_card(p_round_id, r.room_id);
    end if;
  else
    update public.rounds
       set reader_id = p_new_reader,
           former_reader_ids = array_append(former_reader_ids, r.reader_id),
           reader_skipped = false,
           state_version = state_version + 1
     where id = p_round_id;
    -- Whoever takes the role learns the answer, so they stop being a voter.
    -- (The outgoing reader never was one.)
    if r.settled_at is null then
      delete from public.votes where round_id = p_round_id and voter_id = p_new_reader;
      delete from public.round_voters where round_id = p_round_id and player_id = p_new_reader;
    end if;
    perform private.maybe_close(p_round_id);
  end if;
end $$;

-- Works out and records every point for the round, exactly once. Each event
-- has a deterministic key, so even a repeated run could not add points twice.
create or replace function private.settle_round(p_round_id uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  r public.rounds;
  room public.rooms;
  rules jsonb;
  v_votes int;
  v_correct_votes int;
  v_abstentions int;
  v_written int;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.settled_at is not null then return; end if;
  select * into room from public.rooms where id = r.room_id;
  rules := coalesce(room.ruleset, private.default_ruleset());

  -- Two points for each voter who picked the genuine definition.
  insert into public.score_events (room_id, game_number, round_id, player_id, category, points, ref_id, idem_key)
  select r.room_id, r.game_number, r.id, v.voter_id, 'CORRECT_GUESS', (rules->>'correct_guess')::int, v.id,
         r.id || ':CG:' || v.voter_id
    from public.votes v
    join public.shuffled_private sp on sp.definition_id = v.definition_id
    join public.players p on p.id = v.voter_id
   where v.round_id = r.id and sp.is_correct and p.state <> 'removed'
  on conflict (idem_key) do nothing;

  -- One point to a false definition's author for each vote it drew.
  insert into public.score_events (room_id, game_number, round_id, player_id, category, points, ref_id, idem_key)
  select r.room_id, r.game_number, r.id, sp.author_player_id, 'SUCCESSFUL_DECEPTION', (rules->>'deception')::int, v.id,
         r.id || ':SD:' || v.voter_id
    from public.votes v
    join public.shuffled_private sp on sp.definition_id = v.definition_id
    join public.players p on p.id = v.voter_id
   where v.round_id = r.id and not sp.is_correct and sp.author_player_id is not null and p.state <> 'removed'
  on conflict (idem_key) do nothing;

  -- Three points for a written definition the reader accepted as correct.
  insert into public.score_events (room_id, game_number, round_id, player_id, category, points, ref_id, idem_key)
  select r.room_id, r.game_number, r.id, a.player_id, 'CORRECT_WRITTEN_DEFINITION', (rules->>'correct_written')::int,
         a.submission_id, r.id || ':CW:' || a.player_id
    from public.adjudications a where a.round_id = r.id
  on conflict (idem_key) do nothing;

  -- Reader bonus: every eligible voter voted, and every one of them was wrong,
  -- and nobody wrote the correct definition.
  select count(*), count(*) filter (where sp.is_correct) into v_votes, v_correct_votes
    from public.votes v
    join public.shuffled_private sp on sp.definition_id = v.definition_id
    join public.players p on p.id = v.voter_id
   where v.round_id = r.id and p.state <> 'removed';
  select count(*) into v_abstentions
    from public.round_voters rv join public.players p on p.id = rv.player_id
   where rv.round_id = r.id and p.state <> 'removed'
     and not exists (select 1 from public.votes v where v.round_id = r.id and v.voter_id = rv.player_id);
  select count(*) into v_written from public.adjudications where round_id = r.id;
  if v_votes > 0 and v_correct_votes = 0 and v_abstentions = 0 and v_written = 0 then
    insert into public.score_events (room_id, game_number, round_id, player_id, category, points, idem_key)
    values (r.room_id, r.game_number, r.id, r.reader_id, 'READER_BONUS', (rules->>'reader_bonus')::int, r.id || ':RB')
    on conflict (idem_key) do nothing;
  end if;

  update public.shuffled_definitions set reveal_stage = 2 where round_id = r.id;
  update public.rounds
     set state = 'results', settled_at = now(), settlement_version = (rules->>'version')::int,
         state_version = state_version + 1
   where id = r.id;
end $$;

-- ---------------------------------------------------------- state view --

create or replace function public.get_state(p_room_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  me public.players;
  room public.rooms;
  r public.rounds;
  sec public.round_secrets;
  v_presence int := private.config_int('presence_seconds', 15);
  v_players jsonb;
  v_round jsonb := null;
  v_is_reader boolean := false;
  v_eligible boolean := false;
  v_required int;
  v_submitted int;
  v_reader_done boolean;
  v_defs jsonb;
  v_digital boolean;
  v_can_vote boolean := false;
  v_round_points int;
  v_total int;
  v_out jsonb;
  v_standings jsonb;
begin
  select * into room from public.rooms where id = p_room_id;
  if not found then perform private.fail('room_not_found'); end if;
  me := private.me(p_room_id);
  update public.players set last_seen_at = now() where id = me.id;
  v_digital := room.scoring = 'digital';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'name', p.name, 'join_order', p.join_order,
           'rotation_pos', p.rotation_pos,
           'connected', (p.id = me.id or p.last_seen_at > now() - make_interval(secs => v_presence))
         ) order by p.rotation_pos), '[]'::jsonb)
    into v_players
    from public.players p where p.room_id = p_room_id and p.state = 'active';

  if room.status = 'playing' and room.current_round_id is not null then
    select * into r from public.rounds where id = room.current_round_id;
    v_is_reader := (r.reader_id = me.id);
    v_eligible := exists (select 1 from public.round_eligible e
                          where e.round_id = r.id and e.player_id = me.id)
                  and not (me.id = any (r.former_reader_ids));

    select count(*) into v_required
      from public.round_eligible e join public.players p on p.id = e.player_id
     where e.round_id = r.id and p.state = 'active' and p.id <> r.reader_id
       and not (p.id = any (r.former_reader_ids));
    select count(*) into v_submitted
      from public.submissions s join public.players p on p.id = s.player_id
     where s.round_id = r.id and p.state = 'active' and p.id <> r.reader_id
       and not (p.id = any (r.former_reader_ids));
    v_reader_done := r.reader_skipped or exists (
      select 1 from public.submissions s where s.round_id = r.id and s.player_id = r.reader_id);

    v_round := jsonb_build_object(
      'id', r.id,
      'number', r.number,
      'rotation', r.rotation,
      'state', r.state,
      'reader_id', r.reader_id,
      'reader_name', (select name from public.players where id = r.reader_id),
      'word', case when r.state <> 'card_selection' or v_is_reader then r.word else null end,
      'card_source', r.card_source,
      'eligible', v_eligible,
      'required_count', v_required,
      'submitted_count', v_submitted,
      'reader_done', v_reader_done,
      'my_submission', (select body from public.submissions s
                         where s.round_id = r.id and s.player_id = me.id)
    );

    -- The reader's private knowledge. Not repeated once the round is settled,
    -- when the full reveal below carries it for everyone.
    if v_is_reader then
      select * into sec from public.round_secrets where round_id = r.id;
      v_round := v_round || jsonb_build_object(
        'correct_definition', sec.definition,
        'pronunciation', sec.pronunciation,
        'part_of_speech', sec.part_of_speech,
        'reader_skipped', r.reader_skipped,
        'submitted_player_ids', (
          select coalesce(jsonb_agg(s.player_id), '[]'::jsonb)
            from public.submissions s where s.round_id = r.id)
      );
    end if;

    if r.state = 'adjudicating' and v_is_reader then
      -- The other players' definitions, without names, for checking against
      -- the real one. Ordered by a random id, not by time of writing.
      select coalesce(jsonb_agg(jsonb_build_object(
               'submission_id', s.id, 'text', s.body,
               'correct', exists (select 1 from public.adjudications a where a.submission_id = s.id))
               order by s.id), '[]'::jsonb)
        into v_defs
        from public.submissions s join public.players p on p.id = s.player_id
       where s.round_id = r.id and s.player_id <> r.reader_id and p.state <> 'removed';
      v_round := v_round || jsonb_build_object('adjudication', v_defs);

    elsif r.state = 'reading' and v_is_reader then
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'position', d.position, 'text', d.body)
                                order by d.position), '[]'::jsonb)
        into v_defs from public.shuffled_definitions d where d.round_id = r.id;
      v_round := v_round || jsonb_build_object('definitions', v_defs);

    elsif r.state in ('voting', 'voting_closed') then
      v_can_vote := exists (select 1 from public.round_voters rv
                             where rv.round_id = r.id and rv.player_id = me.id);
      v_round := v_round || jsonb_build_object(
        'can_vote', v_can_vote,
        'voters_total', (select count(*) from public.round_voters rv join public.players p on p.id = rv.player_id
                          where rv.round_id = r.id
                            and (p.state = 'active' or (p.state = 'left' and exists (
                                  select 1 from public.votes v
                                   where v.round_id = r.id and v.voter_id = p.id)))),
        'votes_cast', (select count(*) from public.votes v join public.players p on p.id = v.voter_id
                        where v.round_id = r.id and p.state <> 'removed'));
      if v_is_reader or v_can_vote then
        -- The same list, in the same order, for the reader and every voter.
        -- A voter's own definition is marked for them alone.
        select coalesce(jsonb_agg(
                 jsonb_build_object('id', d.id, 'position', d.position, 'text', d.body)
                 || case when v_can_vote and sp.author_player_id = me.id
                         then jsonb_build_object('mine', true) else '{}'::jsonb end
                 order by d.position), '[]'::jsonb)
          into v_defs
          from public.shuffled_definitions d
          join public.shuffled_private sp on sp.definition_id = d.id
         where d.round_id = r.id;
        v_round := v_round || jsonb_build_object('definitions', v_defs);
      end if;
      if v_can_vote then
        v_round := v_round || jsonb_build_object('my_vote', (
          select v.definition_id from public.votes v where v.round_id = r.id and v.voter_id = me.id));
      end if;
      if v_is_reader then
        -- Who has voted, never what they chose.
        v_round := v_round || jsonb_build_object('voters', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'id', p.id, 'name', p.name,
                   'voted', exists (select 1 from public.votes v
                                     where v.round_id = r.id and v.voter_id = p.id))
                   order by p.rotation_pos), '[]'::jsonb)
            from public.round_voters rv join public.players p on p.id = rv.player_id
           where rv.round_id = r.id
             and (p.state = 'active' or (p.state = 'left' and exists (
                   select 1 from public.votes v where v.round_id = r.id and v.voter_id = p.id)))));
      end if;

    elsif r.state = 'reveal' and not v_digital then
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'position', d.position, 'text', d.body,
               'is_correct', sp.is_correct,
               'author_id', sp.author_player_id,
               'author_name', (select name from public.players where id = sp.author_player_id),
               'by_reader', (sp.author_player_id is not null and sp.author_player_id = r.reader_id)
             ) order by d.position), '[]'::jsonb)
        into v_defs
        from public.shuffled_definitions d
        join public.shuffled_private sp on sp.definition_id = d.id
       where d.round_id = r.id;
      v_round := v_round || jsonb_build_object('definitions', v_defs);

    elsif r.state in ('reveal', 'results') then
      -- Each definition carries only what its reveal stage allows:
      -- stage 1 the voters, stage 2 the author and whether it is genuine.
      select coalesce(jsonb_agg(
               jsonb_build_object('id', d.id, 'position', d.position, 'text', d.body, 'stage', d.reveal_stage)
               || case when d.reveal_stage >= 1 then jsonb_build_object('voters', (
                    select coalesce(jsonb_agg(p.name order by p.rotation_pos), '[]'::jsonb)
                      from public.votes v join public.players p on p.id = v.voter_id
                     where v.definition_id = d.id and p.state <> 'removed'))
                  else '{}'::jsonb end
               || case when d.reveal_stage >= 2 then jsonb_build_object(
                    'is_correct', sp.is_correct,
                    'author_id', sp.author_player_id,
                    'author_name', (select name from public.players where id = sp.author_player_id),
                    'by_reader', (sp.author_player_id is not null and sp.author_player_id = r.reader_id))
                  else '{}'::jsonb end
               || case when sp.author_player_id = me.id then jsonb_build_object('mine', true) else '{}'::jsonb end
               order by d.position), '[]'::jsonb)
        into v_defs
        from public.shuffled_definitions d
        join public.shuffled_private sp on sp.definition_id = d.id
       where d.round_id = r.id;
      v_round := v_round || jsonb_build_object(
        'definitions', v_defs,
        'my_vote', (select v.definition_id from public.votes v where v.round_id = r.id and v.voter_id = me.id));

      if r.state = 'results' then
        select coalesce(sum(points), 0)::int into v_round_points
          from public.score_events where round_id = r.id and player_id = me.id;
        select coalesce(sum(points), 0)::int into v_total
          from public.score_events
         where room_id = room.id and game_number = room.game_number and player_id = me.id;
        v_round := v_round || jsonb_build_object(
          'is_final', private.is_final(room, r),
          'reader_bonus', exists (select 1 from public.score_events e
                                   where e.round_id = r.id and e.category = 'READER_BONUS'),
          'written_correct', (
            select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'text', s.body) order by p.rotation_pos), '[]'::jsonb)
              from public.adjudications a
              join public.submissions s on s.id = a.submission_id
              join public.players p on p.id = a.player_id
             where a.round_id = r.id),
          'abstained', (
            select coalesce(jsonb_agg(p.name order by p.rotation_pos), '[]'::jsonb)
              from public.round_voters rv join public.players p on p.id = rv.player_id
             where rv.round_id = r.id and p.state <> 'removed'
               and not exists (select 1 from public.votes v
                                where v.round_id = r.id and v.voter_id = rv.player_id)),
          'my_result', jsonb_build_object(
            'round_points', v_round_points,
            'total', v_total,
            'previous', v_total - v_round_points,
            'items', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'category', x.category, 'points', x.pts, 'voters', x.voters) order by x.ord), '[]'::jsonb)
                from (
                  select e.category, sum(e.points)::int as pts,
                         case when e.category = 'SUCCESSFUL_DECEPTION' then jsonb_agg((
                           select p.name from public.votes v join public.players p on p.id = v.voter_id
                            where v.id = e.ref_id)) end as voters,
                         case e.category when 'CORRECT_GUESS' then 1 when 'SUCCESSFUL_DECEPTION' then 2
                                         when 'CORRECT_WRITTEN_DEFINITION' then 3 else 4 end as ord
                    from public.score_events e
                   where e.round_id = r.id and e.player_id = me.id
                   group by e.category) x)));
      end if;
    end if;
  end if;

  v_out := jsonb_build_object(
    'version', room.version,
    'room', jsonb_build_object('id', room.id, 'code', room.code, 'mode', room.mode,
                               'status', room.status, 'host_player_id', room.host_player_id,
                               'scoring', room.scoring, 'win_type', room.win_type,
                               'target_score', room.target_score, 'rotation_limit', room.rotation_limit,
                               'game_number', room.game_number),
    'me', jsonb_build_object('id', me.id, 'name', me.name,
                             'is_host', room.host_player_id = me.id,
                             'is_reader', v_is_reader),
    'players', v_players,
    'round', v_round
  );

  -- Scores exist only for settled rounds, so the standings can never give
  -- away a result that has not been revealed.
  if v_digital and room.status in ('playing', 'ended') then
    v_standings := private.standings(room);
    v_out := v_out || jsonb_build_object(
      'standings', v_standings,
      'completed_rounds', (select count(*) from public.rounds
                            where room_id = room.id and game_number = room.game_number
                              and settled_at is not null),
      'final_rotation', (room.status = 'playing' and room.win_type = 'target'
                         and private.max_total(room) >= coalesce(room.target_score, 25)),
      'adjustments', (
        select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'points', e.points, 'note', e.note)
                                  order by e.created_at), '[]'::jsonb)
          from public.score_events e join public.players p on p.id = e.player_id
         where e.room_id = room.id and e.game_number = room.game_number
           and e.category = 'MANUAL_ADJUSTMENT'));
    if room.status = 'ended' then
      v_out := v_out || jsonb_build_object('final', jsonb_build_object(
        'winners', (select coalesce(jsonb_agg(s->'name'), '[]'::jsonb)
                      from jsonb_array_elements(v_standings) s
                     where (s->>'rank')::int = 1
                       and exists (select 1 from public.rounds
                                    where room_id = room.id and game_number = room.game_number
                                      and settled_at is not null)),
        'awards', private.awards(room),
        'my_stats', private.player_stats(room, me.id)));
    end if;
  end if;

  return v_out;
end $$;

-- -------------------------------------------------------- game options --

drop function public.create_room(text, text);

-- p_scoring defaults to 'traditional' so that a not-yet-updated copy of the
-- app, which sends only a name and a card mode, keeps the game it knows.
create or replace function public.create_room(
  p_name text, p_mode text,
  p_scoring text default 'traditional', p_win_type text default 'unlimited',
  p_target int default null, p_rotations int default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := private.require_uid();
  v_name text := private.clean_name(p_name);
  v_code text;
  v_room_id uuid;
  v_player_id uuid;
begin
  if p_mode is null or p_mode not in ('physical', 'digital') then
    perform private.fail('invalid_mode');
  end if;
  perform private.rate_limit('create_room', 20, 3600);
  perform private.cleanup_rooms();
  loop
    v_code := private.new_code(5);
    begin
      insert into public.rooms (code, mode) values (v_code, p_mode) returning id into v_room_id;
      exit;
    exception when unique_violation then
      -- code already in use by a live room: draw another
    end;
  end loop;
  perform private.apply_rules(v_room_id, p_scoring, p_win_type, p_target, p_rotations);
  insert into public.players (room_id, user_id, name, join_order, rotation_pos)
  values (v_room_id, v_uid, v_name, 1, 1) returning id into v_player_id;
  update public.rooms set host_player_id = v_player_id where id = v_room_id;
  return jsonb_build_object('room_id', v_room_id, 'code', v_code, 'player_id', v_player_id);
end $$;

-- Host changes the options in the lobby (before a game, or between games).
create or replace function public.update_settings(
  p_room_id uuid, p_mode text, p_scoring text, p_win_type text,
  p_target int default null, p_rotations int default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare room public.rooms := private.lock_room(p_room_id);
begin
  perform private.require_host(room);
  if room.status <> 'lobby' then perform private.fail('game_already_started'); end if;
  if p_mode is null or p_mode not in ('physical', 'digital') then perform private.fail('invalid_mode'); end if;
  update public.rooms set mode = p_mode where id = p_room_id;
  perform private.apply_rules(p_room_id, p_scoring, p_win_type, p_target, p_rotations);
  perform private.touch(p_room_id);
  return public.get_state(p_room_id);
end $$;

create or replace function public.start_game(p_room_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare room public.rooms := private.lock_room(p_room_id);
begin
  perform private.require_host(room);
  if room.status = 'ended' then perform private.fail('game_ended'); end if;
  if room.status = 'lobby' then
    if (select count(*) from public.players where room_id = p_room_id and state = 'active') < 3 then
      perform private.fail('need_three_players');
    end if;
    -- The scoring rules are frozen here; later changes cannot reach this game.
    update public.rooms set ruleset = private.default_ruleset() where id = p_room_id;
    perform private.start_round(room, 0, 0);
    perform private.touch(p_room_id);
  end if;
  return public.get_state(p_room_id);
end $$;

-- A new game for the same table: same room, same players, same sessions.
-- Scores, rounds and rotations start afresh under a new game number, so the
-- finished game's records cannot affect it. Used cards stay used.
create or replace function public.play_again(p_room_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare room public.rooms := private.lock_room(p_room_id);
begin
  perform private.require_host(room);
  if room.status = 'playing' then perform private.fail('game_in_progress'); end if;
  if room.status = 'ended' then
    update public.rooms
       set status = 'lobby', game_number = game_number + 1, current_round_id = null, ruleset = null
     where id = p_room_id;
    perform private.touch(p_room_id);
  end if;
  return public.get_state(p_room_id);
end $$;

-- ------------------------------------------------------- host controls --

create or replace function public.skip_reader(p_room_id uuid, p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  r public.rounds;
  v_cur public.players;
  v_next public.players;
  v_rotation int;
begin
  perform private.require_host(room);
  if room.status = 'playing' and room.current_round_id = p_round_id then
    select * into r from public.rounds where id = p_round_id;
    if r.state <> 'card_selection' then perform private.fail('card_already_confirmed'); end if;
    select * into v_cur from public.players where id = r.reader_id;
    v_rotation := r.rotation;
    v_next := private.next_in_rotation(room, v_rotation, v_cur.rotation_pos);
    if v_next.id is null then
      -- Nobody left in this rotation: the turn passes into the next one.
      v_rotation := v_rotation + 1;
      perform private.begin_rotation(room, v_rotation);
      v_next := private.next_in_rotation(room, v_rotation, 0);
    end if;
    if v_next.id is not null and v_next.id <> r.reader_id then
      update public.rounds set scheduled_pos = v_next.rotation_pos, rotation = v_rotation where id = r.id;
      perform private.change_reader(r.id, v_next.id);
      perform private.touch(p_room_id);
    end if;
  end if;
  return public.get_state(p_room_id);
end $$;

-- Host corrects a genuine scoring mistake. Nothing is overwritten: the
-- correction is its own ledger entry, with the reason and who made it, and
-- everyone can see it. Totals (and so the winning condition) include it.
create or replace function public.adjust_score(p_room_id uuid, p_player_id uuid, p_points int, p_note text)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  me public.players := private.require_host(room);
  v_note text := private.clean_text(p_note, 120, 'invalid_note');
begin
  if room.scoring <> 'digital' or room.status = 'lobby' then perform private.fail('no_scores_to_adjust'); end if;
  if p_points is null or p_points = 0 or p_points not between -100 and 100 then
    perform private.fail('invalid_points');
  end if;
  if not exists (select 1 from public.players
                  where id = p_player_id and room_id = p_room_id and state <> 'removed') then
    perform private.fail('player_not_found');
  end if;
  insert into public.score_events (room_id, game_number, player_id, category, points, note, created_by, idem_key)
  values (p_room_id, room.game_number, p_player_id, 'MANUAL_ADJUSTMENT', p_points, v_note, me.id,
          'adj:' || gen_random_uuid());
  perform private.touch(p_room_id);
  return public.get_state(p_room_id);
end $$;

-- ----------------------------------------------------- reader controls --

-- Reader marks (or unmarks) another player's definition as substantially
-- correct. The decision stays private until the round is settled.
create or replace function public.adjudicate(p_round_id uuid, p_submission_id uuid, p_correct boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
  s public.submissions;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;
  if r.reader_id <> me.id then perform private.fail('not_reader'); end if;
  if r.state <> 'adjudicating' then perform private.fail('not_adjudicating'); end if;
  select * into s from public.submissions where id = p_submission_id and round_id = r.id;
  if not found then perform private.fail('submission_not_found'); end if;
  if s.player_id = me.id then perform private.fail('cannot_adjudicate_own'); end if;
  if coalesce(p_correct, false) then
    insert into public.adjudications (submission_id, round_id, player_id, reader_id)
    values (s.id, r.id, s.player_id, me.id)
    on conflict (submission_id) do nothing;
  else
    delete from public.adjudications where submission_id = s.id;
  end if;
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

create or replace function public.finish_adjudication(p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;
  if r.reader_id <> me.id then perform private.fail('not_reader'); end if;
  if r.state in ('card_selection', 'collecting') then perform private.fail('submissions_still_open'); end if;
  if r.state = 'adjudicating' then
    perform private.shuffle_round(r.id);
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

-- Reader has finished reading aloud. The voters are fixed here: everyone
-- playing this round except the reader, anyone who has been reader this round,
-- and anyone whose written definition was accepted as correct.
create or replace function public.open_voting(p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;
  if r.reader_id <> me.id then perform private.fail('not_reader'); end if;
  if room.scoring <> 'digital' then perform private.fail('not_digital_scoring'); end if;
  if r.state in ('card_selection', 'collecting', 'adjudicating') then perform private.fail('not_ready_to_vote'); end if;
  if r.state = 'reading' then
    insert into public.round_voters (round_id, player_id)
    select r.id, p.id
      from public.round_eligible e join public.players p on p.id = e.player_id
     where e.round_id = r.id and p.state = 'active'
       and p.id <> r.reader_id and not (p.id = any (r.former_reader_ids))
       and not exists (select 1 from public.adjudications a where a.round_id = r.id and a.player_id = p.id)
    on conflict do nothing;
    update public.rounds set state = 'voting', state_version = state_version + 1 where id = r.id;
    perform private.maybe_close(r.id);        -- nobody eligible: voting closes at once
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

-- One ballot per voter per round; voting again replaces it.
create or replace function public.cast_vote(p_round_id uuid, p_definition_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
  v_author uuid;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null or r.state <> 'voting' then perform private.fail('voting_closed'); end if;
  if r.reader_id = me.id or not exists (
       select 1 from public.round_voters rv where rv.round_id = r.id and rv.player_id = me.id) then
    perform private.fail('not_eligible_to_vote');
  end if;
  perform private.rate_limit('cast_vote', 60, 60);
  select sp.author_player_id into v_author
    from public.shuffled_definitions d join public.shuffled_private sp on sp.definition_id = d.id
   where d.id = p_definition_id and d.round_id = r.id;
  if not found then perform private.fail('invalid_definition_id'); end if;
  if v_author = me.id then perform private.fail('own_definition'); end if;

  insert into public.votes as v (round_id, voter_id, definition_id)
  values (r.id, me.id, p_definition_id)
  on conflict (round_id, voter_id) do update set definition_id = excluded.definition_id, updated_at = now();
  perform private.maybe_close(r.id);
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

create or replace function public.close_voting(p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;
  if r.reader_id <> me.id then perform private.fail('not_reader'); end if;
  if r.state in ('card_selection', 'collecting', 'adjudicating', 'reading') then
    perform private.fail('voting_not_open');
  end if;
  if r.state = 'voting' then
    update public.rounds set state = 'voting_closed', state_version = state_version + 1 where id = r.id;
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

-- Reader reveals one more thing about one definition: first who voted for
-- it, then who wrote it and whether it is genuine. When the last definition
-- is fully revealed the round is settled in the same transaction.
create or replace function public.reveal_step(p_round_id uuid, p_definition_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;
  if r.reader_id <> me.id then perform private.fail('not_reader'); end if;
  if room.scoring <> 'digital' then perform private.fail('not_digital_scoring'); end if;
  if r.state not in ('voting_closed', 'reveal', 'results') then perform private.fail('voting_not_closed'); end if;
  if r.state in ('voting_closed', 'reveal') then
    update public.shuffled_definitions set reveal_stage = least(reveal_stage + 1, 2)
     where id = p_definition_id and round_id = r.id;
    if not found then perform private.fail('invalid_definition_id'); end if;
    update public.rounds set state = 'reveal', state_version = state_version + 1 where id = r.id;
    if not exists (select 1 from public.shuffled_definitions where round_id = r.id and reveal_stage < 2) then
      perform private.settle_round(r.id);
    end if;
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

-- Traditional rooms: reading -> reveal, as before. Digital rooms: reveal
-- everything that is still hidden and settle the round.
create or replace function public.reveal_answers(p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;
  if r.reader_id <> me.id then perform private.fail('not_reader'); end if;
  if room.scoring = 'digital' then
    if r.state not in ('voting_closed', 'reveal', 'results') then perform private.fail('voting_not_closed'); end if;
    if r.state in ('voting_closed', 'reveal') then
      perform private.settle_round(r.id);
      perform private.touch(v_room_id);
    end if;
  else
    if r.state in ('card_selection', 'collecting') then perform private.fail('not_ready_to_reveal'); end if;
    if r.state = 'reading' then
      update public.rounds set state = 'reveal', state_version = state_version + 1 where id = r.id;
      perform private.touch(v_room_id);
    end if;
  end if;
  return public.get_state(v_room_id);
end $$;

-- Reader (or host) moves on once the round is over: to the next round, or to
-- the end of the game when the winning condition is met at a rotation boundary.
create or replace function public.next_round(p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null then return public.get_state(v_room_id); end if;   -- already advanced
  if r.reader_id <> me.id and room.host_player_id is distinct from me.id then
    perform private.fail('not_reader');
  end if;
  if r.state <> (case when room.scoring = 'digital' then 'results' else 'reveal' end) then
    perform private.fail('not_revealed_yet');
  end if;
  update public.rounds
     set state = 'done', completed_at = now(), state_version = state_version + 1
   where id = r.id;
  if private.is_final(room, r) then
    update public.rooms set status = 'ended' where id = v_room_id;
  else
    perform private.start_round(room, r.scheduled_pos, r.rotation);
  end if;
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

-- ------------------------------------------------- a departing reader --

-- The reader has left or been removed: the turn passes to the next member of
-- the rotation, and the rotation carries on from them, so nobody reads twice
-- in one pass. (A host's deliberate set_reader is different: it lends the
-- round to someone without moving the rotation.)
create or replace function private.pass_reader(p_room public.rooms, p_round_id uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  r public.rounds;
  v_cur public.players;
  v_next public.players;
  v_rotation int;
begin
  select * into r from public.rounds where id = p_round_id;
  select * into v_cur from public.players where id = r.reader_id;
  v_rotation := r.rotation;
  v_next := private.next_in_rotation(p_room, v_rotation, v_cur.rotation_pos);
  if v_next.id is null then
    v_rotation := v_rotation + 1;
    perform private.begin_rotation(p_room, v_rotation);
    v_next := private.next_in_rotation(p_room, v_rotation, 0);
  end if;
  if v_next.id is null then return; end if;      -- nobody left to read
  update public.rounds set scheduled_pos = v_next.rotation_pos, rotation = v_rotation where id = r.id;
  perform private.change_reader(r.id, v_next.id);
end $$;

create or replace function public.leave_room(p_room_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms;
  me public.players;
  v_heir public.players;
  r public.rounds;
begin
  perform private.require_uid();
  room := private.lock_room(p_room_id);
  me := private.me(p_room_id);
  update public.players set state = 'left' where id = me.id;

  if room.host_player_id = me.id then
    select * into v_heir from public.players
     where room_id = p_room_id and state = 'active'
     order by (last_seen_at > now() - interval '30 seconds') desc, join_order limit 1;
    if v_heir.id is null then
      update public.rooms set status = 'ended' where id = p_room_id;
    else
      update public.rooms set host_player_id = v_heir.id where id = p_room_id;
    end if;
  end if;

  if room.status = 'playing' and room.current_round_id is not null then
    select * into r from public.rounds where id = room.current_round_id;
    if r.reader_id = me.id then
      perform private.pass_reader(room, r.id);
    else
      perform private.maybe_close(r.id);
    end if;
  end if;
  perform private.touch(p_room_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.remove_player(p_room_id uuid, p_player_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  me public.players := private.require_host(room);
  target public.players;
  r public.rounds;
begin
  if p_player_id = me.id then perform private.fail('cannot_remove_self'); end if;
  select * into target from public.players where id = p_player_id and room_id = p_room_id;
  if not found then perform private.fail('player_not_found'); end if;
  if target.state <> 'removed' then
    update public.players set state = 'removed' where id = target.id;
    if room.status = 'playing' and room.current_round_id is not null then
      select * into r from public.rounds where id = room.current_round_id;
      if r.reader_id = target.id then
        perform private.pass_reader(room, r.id);
      else
        perform private.maybe_close(r.id);
      end if;
    end if;
    perform private.touch(p_room_id);
  end if;
  return public.get_state(p_room_id);
end $$;

-- ----------------------------------------------------------- privileges --

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and pg_get_userbyid(p.proowner) = current_user
  loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f.sig);
    end if;
    if f.nspname = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('revoke all on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;
grant execute on function private.is_member(uuid) to authenticated;
