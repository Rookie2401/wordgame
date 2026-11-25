-- Balderdash companion: the game engine.
--
-- Every function the client may call is SECURITY DEFINER, checks who the
-- caller is, takes a row lock on the room (so competing requests run one
-- after another), validates the state transition and returns the caller's own
-- view of the room. A repeated call for a step that has already happened is a
-- harmless no-op, so double taps never run an action twice.
--
-- Round states:  card_selection -> collecting -> reading -> reveal -> done
-- Room states:   lobby -> playing -> ended
-- (The brief's NEXT_ROUND is the reveal -> done transition, which creates the
--  following round in the same transaction.)

-- ------------------------------------------------------------ helpers --

create or replace function private.fail(p_code text) returns void
language plpgsql as $$
begin
  raise exception '%', p_code using errcode = 'P0001';
end $$;

create or replace function private.config_int(p_key text, p_default int) returns int
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select value::int from public.app_config where key = p_key), p_default);
$$;

-- Uniform integer in [0, n). Uses gen_random_uuid(), which draws from the
-- server's cryptographic generator; the first four bytes of a v4 UUID are all
-- random. Rejection sampling removes modulo bias.
create or replace function private.rand_int(n int) returns int
language plpgsql volatile as $$
declare
  v bigint;
  lim bigint;
  b bytea;
begin
  if n is null or n < 1 then
    raise exception 'rand_int: n must be positive';
  end if;
  lim := 4294967296 - (4294967296 % n);
  loop
    b := uuid_send(gen_random_uuid());
    v := (get_byte(b, 0)::bigint << 24) | (get_byte(b, 1)::bigint << 16)
       | (get_byte(b, 2)::bigint << 8) | get_byte(b, 3)::bigint;
    if v < lim then
      return (v % n)::int;
    end if;
  end loop;
end $$;

create or replace function private.new_code(p_len int) returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no I, L, O, 0, 1
  out text := '';
begin
  for i in 1..p_len loop
    out := out || substr(alphabet, private.rand_int(length(alphabet)) + 1, 1);
  end loop;
  return out;
end $$;

create or replace function private.rate_limit(p_action text, p_max int, p_window_seconds int)
returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  insert into public.rate_limits as r (user_id, action, window_start, count)
  values (v_uid, p_action, now(), 1)
  on conflict (user_id, action) do update
    set count = case when r.window_start < now() - make_interval(secs => p_window_seconds)
                     then 1 else r.count + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds)
                     then now() else r.window_start end
  returning count into v_count;
  if v_count > p_max then
    perform private.fail('rate_limited');
  end if;
end $$;

create or replace function private.require_uid() returns uuid
language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then perform private.fail('not_authenticated'); end if;
  return v;
end $$;

create or replace function private.lock_room(p_room_id uuid) returns public.rooms
language plpgsql volatile set search_path = public, pg_temp as $$
declare r public.rooms;
begin
  select * into r from public.rooms where id = p_room_id for update;
  if not found then perform private.fail('room_not_found'); end if;
  return r;
end $$;

create or replace function private.touch(p_room_id uuid) returns void
language sql volatile set search_path = public, pg_temp as $$
  update public.rooms set version = version + 1, last_activity_at = now() where id = p_room_id;
$$;

-- The caller's own active player row in a room.
create or replace function private.me(p_room_id uuid) returns public.players
language plpgsql stable set search_path = public, pg_temp as $$
declare
  p public.players;
  v_uid uuid := private.require_uid();
begin
  select * into p from public.players where room_id = p_room_id and user_id = v_uid;
  if not found then perform private.fail('not_member'); end if;
  if p.state = 'removed' then perform private.fail('removed_from_room'); end if;
  if p.state <> 'active' then perform private.fail('not_member'); end if;
  return p;
end $$;

create or replace function private.clean_name(p_name text) returns text
language plpgsql immutable as $$
declare v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v) < 1 or char_length(v) > 24 then
    perform private.fail('invalid_name');
  end if;
  return v;
end $$;

-- Trims the ends only; wording, capitals and punctuation stay as typed.
create or replace function private.clean_text(p_text text, p_max int, p_error text) returns text
language plpgsql immutable as $$
declare v text := btrim(coalesce(p_text, ''), E' \t\n\r');
begin
  if char_length(v) < 1 or char_length(v) > p_max then
    perform private.fail(p_error);
  end if;
  return v;
end $$;

create or replace function private.unique_name(p_room_id uuid, p_name text) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v text := p_name;
  n int := 1;
begin
  while exists (select 1 from public.players
                where room_id = p_room_id and state = 'active' and lower(name) = lower(v)) loop
    n := n + 1;
    v := left(p_name, 20) || ' (' || n || ')';
  end loop;
  return v;
end $$;

create or replace function private.cleanup_rooms() returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v int;
begin
  with gone as (
    delete from public.rooms
    where last_activity_at < now() - make_interval(hours => private.config_int('room_inactivity_hours', 6))
       or (status = 'ended'
           and last_activity_at < now() - make_interval(mins => private.config_int('ended_retention_minutes', 30)))
    returning 1
  )
  select count(*) into v from gone;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return v;
end $$;

-- ------------------------------------------------------- round engine --

-- Next reader in the circle after rotation position p_after_pos.
create or replace function private.next_reader(p_room_id uuid, p_after_pos int) returns public.players
language sql stable set search_path = public, pg_temp as $$
  select * from public.players
  where room_id = p_room_id and state = 'active'
  order by (rotation_pos > p_after_pos) desc, rotation_pos asc
  limit 1;
$$;

-- Draws an unused word for the round. If the dictionary is exhausted for this
-- room the round falls back to a hand-entered card.
create or replace function private.draw_card(p_round_id uuid, p_room_id uuid) returns boolean
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  n int;
  w public.words;
begin
  delete from public.round_secrets where round_id = p_round_id;
  select count(*) into n from public.words x
   where not exists (select 1 from public.used_cards u where u.room_id = p_room_id and u.word_id = x.id);
  if n = 0 then
    update public.rounds set word = null, card_source = 'manual_fallback' where id = p_round_id;
    return false;
  end if;
  select * into w from public.words x
   where not exists (select 1 from public.used_cards u where u.room_id = p_room_id and u.word_id = x.id)
   order by x.id offset private.rand_int(n) limit 1;
  insert into public.used_cards (room_id, word_id) values (p_room_id, w.id);
  insert into public.round_secrets (round_id, definition, word_id, pronunciation, part_of_speech)
  values (p_round_id, w.definition, w.id, w.pronunciation, w.part_of_speech);
  update public.rounds set word = w.word, card_source = 'digital' where id = p_round_id;
  return true;
end $$;

create or replace function private.start_round(p_room public.rooms, p_after_pos int) returns uuid
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_reader public.players;
  v_number int;
  v_round_id uuid;
begin
  v_reader := private.next_reader(p_room.id, p_after_pos);
  if v_reader.id is null then perform private.fail('no_players'); end if;
  select coalesce(max(number), 0) + 1 into v_number from public.rounds where room_id = p_room.id;
  insert into public.rounds (room_id, number, reader_id, scheduled_pos, card_source)
  values (p_room.id, v_number, v_reader.id, v_reader.rotation_pos,
          case when p_room.mode = 'digital' then 'digital' else 'physical' end)
  returning id into v_round_id;
  -- The eligible set is fixed here; later joiners wait for the next round.
  insert into public.round_eligible (round_id, player_id)
  select v_round_id, id from public.players where room_id = p_room.id and state = 'active';
  if p_room.mode = 'digital' then
    perform private.draw_card(v_round_id, p_room.id);
  end if;
  update public.rooms set current_round_id = v_round_id, status = 'playing' where id = p_room.id;
  return v_round_id;
end $$;

-- Collects the submissions and the correct definition, shuffles them once
-- (Fisher-Yates) and stores the order. Called only with the room locked and
-- the round in 'collecting', so it can never run twice for a round.
create or replace function private.close_round(p_round_id uuid) returns void
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
  if r.state <> 'collecting' then return; end if;
  select definition into v_correct from public.round_secrets where round_id = p_round_id;
  if v_correct is null then perform private.fail('card_missing'); end if;

  select coalesce(array_agg(s2.id order by s2.id), '{}') into v_ids
    from public.submissions s2
    join public.players p on p.id = s2.player_id
   where s2.round_id = p_round_id and p.state <> 'removed';

  n := coalesce(array_length(v_ids, 1), 0) + 1;      -- index n is the correct definition
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

-- Closes the round automatically once everyone expected has submitted and the
-- reader has either submitted or skipped.
create or replace function private.maybe_close(p_round_id uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  r public.rounds;
  v_waiting int;
  v_reader_done boolean;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.state <> 'collecting' then return; end if;
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
end $$;

-- Hands the reader role to another player without losing the round.
create or replace function private.change_reader(p_round_id uuid, p_new_reader uuid) returns void
language plpgsql volatile set search_path = public, pg_temp as $$
declare r public.rounds;
begin
  select * into r from public.rounds where id = p_round_id;
  if r.reader_id = p_new_reader or r.state = 'done' then return; end if;
  if r.state = 'card_selection' then
    update public.rounds set reader_id = p_new_reader, state_version = state_version + 1
     where id = p_round_id;
    -- The previous reader has seen the digital card, so draw a fresh one.
    if r.card_source = 'digital' then
      perform private.draw_card(p_round_id, r.room_id);
    end if;
  else
    -- Word and submissions are kept. The outgoing reader knows the answer and
    -- is no longer expected (or allowed) to submit.
    update public.rounds
       set reader_id = p_new_reader,
           former_reader_ids = array_append(former_reader_ids, r.reader_id),
           reader_skipped = false,
           state_version = state_version + 1
     where id = p_round_id;
    perform private.maybe_close(p_round_id);
  end if;
end $$;

-- ---------------------------------------------------------- state view --

-- The caller's view of the room. This is the only way game data reaches a
-- client, and it is built per caller: the correct definition is included only
-- for the reader (or for everyone after the reveal), the shuffled list only
-- for the reader while reading, authorship only after the reveal.
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
begin
  select * into room from public.rooms where id = p_room_id;
  if not found then perform private.fail('room_not_found'); end if;
  me := private.me(p_room_id);
  update public.players set last_seen_at = now() where id = me.id;

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

    if r.state = 'reading' and v_is_reader then
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'position', d.position, 'text', d.body)
                                order by d.position), '[]'::jsonb)
        into v_defs from public.shuffled_definitions d where d.round_id = r.id;
      v_round := v_round || jsonb_build_object('definitions', v_defs);
    elsif r.state = 'reveal' then
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
    end if;
  end if;

  return jsonb_build_object(
    'version', room.version,
    'room', jsonb_build_object('id', room.id, 'code', room.code, 'mode', room.mode,
                               'status', room.status, 'host_player_id', room.host_player_id),
    'me', jsonb_build_object('id', me.id, 'name', me.name,
                             'is_host', room.host_player_id = me.id,
                             'is_reader', v_is_reader),
    'players', v_players,
    'round', v_round
  );
end $$;

-- ------------------------------------------------------ rooms, joining --

create or replace function public.create_room(p_name text, p_mode text) returns jsonb
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
  insert into public.players (room_id, user_id, name, join_order, rotation_pos)
  values (v_room_id, v_uid, v_name, 1, 1) returning id into v_player_id;
  update public.rooms set host_player_id = v_player_id where id = v_room_id;
  return jsonb_build_object('room_id', v_room_id, 'code', v_code, 'player_id', v_player_id);
end $$;

-- Lets the join screen say "expired" before asking for a name.
create or replace function public.room_exists(p_code text) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform private.require_uid();
  perform private.rate_limit('room_exists', 60, 600);
  return exists (select 1 from public.rooms
                 where code = upper(btrim(coalesce(p_code, ''))) and status <> 'ended');
end $$;

create or replace function public.join_room(p_code text, p_name text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := private.require_uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_room public.rooms;
  v_existing public.players;
  v_name text;
  v_order int;
  v_pos int;
  v_player_id uuid;
begin
  perform private.rate_limit('join_room', 60, 600);
  select * into v_room from public.rooms where code = v_code and status <> 'ended';
  -- Returned, not raised: a raised error would roll back the rate-limit count,
  -- and wrong guesses are exactly what the limit must count.
  if not found then return jsonb_build_object('error', 'room_not_found'); end if;
  v_room := private.lock_room(v_room.id);
  if v_room.status = 'ended' then return jsonb_build_object('error', 'room_not_found'); end if;

  select * into v_existing from public.players where room_id = v_room.id and user_id = v_uid;
  if found then
    if v_existing.state = 'removed' then perform private.fail('removed_from_room'); end if;
    if v_existing.state = 'left' then
      update public.players
         set state = 'active', last_seen_at = now(),
             name = private.unique_name(v_room.id, coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_existing.name))
       where id = v_existing.id;
      perform private.touch(v_room.id);
    end if;
    -- Already in the room (scanned the code twice): same player, no duplicate.
    return jsonb_build_object('room_id', v_room.id, 'code', v_room.code, 'player_id', v_existing.id);
  end if;

  v_name := private.clean_name(p_name);
  if (select count(*) from public.players where room_id = v_room.id and state = 'active')
     >= private.config_int('max_players', 24) then
    perform private.fail('room_full');
  end if;
  v_name := private.unique_name(v_room.id, v_name);
  select coalesce(max(join_order), 0) + 1, coalesce(max(rotation_pos), 0) + 1
    into v_order, v_pos from public.players where room_id = v_room.id;
  insert into public.players (room_id, user_id, name, join_order, rotation_pos)
  values (v_room.id, v_uid, v_name, v_order, v_pos) returning id into v_player_id;
  perform private.touch(v_room.id);
  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code, 'player_id', v_player_id);
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
      v_heir := private.next_reader(p_room_id, me.rotation_pos);
      if v_heir.id is not null then
        perform private.change_reader(r.id, v_heir.id);
      end if;
    else
      perform private.maybe_close(r.id);
    end if;
  end if;
  perform private.touch(p_room_id);
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------- host controls --

create or replace function private.require_host(p_room public.rooms) returns public.players
language plpgsql stable set search_path = public, pg_temp as $$
declare me public.players := private.me(p_room.id);
begin
  if p_room.host_player_id is distinct from me.id then perform private.fail('not_host'); end if;
  return me;
end $$;

create or replace function public.remove_player(p_room_id uuid, p_player_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  me public.players := private.require_host(room);
  target public.players;
  r public.rounds;
  v_heir public.players;
begin
  if p_player_id = me.id then perform private.fail('cannot_remove_self'); end if;
  select * into target from public.players where id = p_player_id and room_id = p_room_id;
  if not found then perform private.fail('player_not_found'); end if;
  if target.state <> 'removed' then
    update public.players set state = 'removed' where id = target.id;
    if room.status = 'playing' and room.current_round_id is not null then
      select * into r from public.rounds where id = room.current_round_id;
      if r.reader_id = target.id then
        v_heir := private.next_reader(p_room_id, target.rotation_pos);
        perform private.change_reader(r.id, v_heir.id);
      else
        perform private.maybe_close(r.id);
      end if;
    end if;
    perform private.touch(p_room_id);
  end if;
  return public.get_state(p_room_id);
end $$;

-- Reader order, before the game starts. p_player_ids must list every active
-- player exactly once.
create or replace function public.reorder_players(p_room_id uuid, p_player_ids uuid[]) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  v_active uuid[];
begin
  perform private.require_host(room);
  if room.status <> 'lobby' then perform private.fail('game_already_started'); end if;
  select array_agg(id order by id) into v_active
    from public.players where room_id = p_room_id and state = 'active';
  if v_active is distinct from (select array_agg(x order by x) from unnest(p_player_ids) x) then
    perform private.fail('invalid_order');
  end if;
  update public.players p set rotation_pos = o.ord
    from unnest(p_player_ids) with ordinality as o(id, ord)
   where p.id = o.id and p.room_id = p_room_id;
  -- Anyone no longer active sorts after the active players.
  update public.players set rotation_pos = 1000 + join_order
   where room_id = p_room_id and state <> 'active';
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
    perform private.start_round(room, 0);
    perform private.touch(p_room_id);
  end if;
  return public.get_state(p_room_id);
end $$;

create or replace function public.end_game(p_room_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare room public.rooms := private.lock_room(p_room_id);
begin
  perform private.require_host(room);
  if room.status <> 'ended' then
    update public.rooms set status = 'ended' where id = p_room_id;
    perform private.touch(p_room_id);
  end if;
  return public.get_state(p_room_id);
end $$;

create or replace function public.transfer_host(p_room_id uuid, p_player_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare room public.rooms := private.lock_room(p_room_id);
begin
  perform private.require_host(room);
  if not exists (select 1 from public.players
                 where id = p_player_id and room_id = p_room_id and state = 'active') then
    perform private.fail('player_not_found');
  end if;
  update public.rooms set host_player_id = p_player_id where id = p_room_id;
  perform private.touch(p_room_id);
  return public.get_state(p_room_id);
end $$;

-- Any player may take over as host once the host has been silent for a minute.
create or replace function public.claim_host(p_room_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  me public.players := private.me(p_room_id);
  host public.players;
begin
  if room.host_player_id = me.id then return public.get_state(p_room_id); end if;
  select * into host from public.players where id = room.host_player_id;
  if found and host.state = 'active' and host.last_seen_at > now() - interval '60 seconds' then
    perform private.fail('host_still_present');
  end if;
  update public.rooms set host_player_id = me.id where id = p_room_id;
  perform private.touch(p_room_id);
  return public.get_state(p_room_id);
end $$;

-- Host gives the current round to another reader (reader lost, or left).
create or replace function public.set_reader(p_room_id uuid, p_player_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare room public.rooms := private.lock_room(p_room_id);
begin
  perform private.require_host(room);
  if room.status <> 'playing' then perform private.fail('no_active_round'); end if;
  if not exists (select 1 from public.players
                 where id = p_player_id and room_id = p_room_id and state = 'active') then
    perform private.fail('player_not_found');
  end if;
  perform private.change_reader(room.current_round_id, p_player_id);
  perform private.touch(p_room_id);
  return public.get_state(p_room_id);
end $$;

-- Host passes over the reader before the card is confirmed; the rotation
-- carries on from the player who takes the turn.
create or replace function public.skip_reader(p_room_id uuid, p_round_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  r public.rounds;
  v_cur public.players;
  v_next public.players;
begin
  perform private.require_host(room);
  if room.status = 'playing' and room.current_round_id = p_round_id then
    select * into r from public.rounds where id = p_round_id;
    if r.state <> 'card_selection' then perform private.fail('card_already_confirmed'); end if;
    select * into v_cur from public.players where id = r.reader_id;
    v_next := private.next_reader(p_room_id, v_cur.rotation_pos);
    if v_next.id is not null and v_next.id <> r.reader_id then
      update public.rounds set scheduled_pos = v_next.rotation_pos where id = r.id;
      perform private.change_reader(r.id, v_next.id);
      perform private.touch(p_room_id);
    end if;
  end if;
  return public.get_state(p_room_id);
end $$;

-- Session recovery. The host issues a short one-time code for a player who
-- has lost their session; whoever enters it within ten minutes becomes that
-- player. A name alone is never enough.
create or replace function public.issue_rejoin_code(p_room_id uuid, p_player_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  room public.rooms := private.lock_room(p_room_id);
  me public.players := private.require_host(room);
  v_code text := private.new_code(6);
begin
  if p_player_id = me.id then perform private.fail('cannot_rejoin_self'); end if;
  update public.players
     set rejoin_hash = encode(sha256(convert_to(p_room_id::text || ':' || v_code, 'UTF8')), 'hex'),
         rejoin_expires = now() + interval '10 minutes'
   where id = p_player_id and room_id = p_room_id and state in ('active', 'left');
  if not found then perform private.fail('player_not_found'); end if;
  return jsonb_build_object('rejoin_code', v_code);
end $$;

create or replace function public.claim_player(p_code text, p_rejoin_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := private.require_uid();
  v_room public.rooms;
  target public.players;
  dup public.players;
  v_hash text;
begin
  perform private.rate_limit('claim_player', 10, 600);
  select * into v_room from public.rooms
   where code = upper(btrim(coalesce(p_code, ''))) and status <> 'ended';
  if not found then return jsonb_build_object('error', 'room_not_found'); end if;
  v_room := private.lock_room(v_room.id);
  v_hash := encode(sha256(convert_to(v_room.id::text || ':' || upper(btrim(coalesce(p_rejoin_code, ''))), 'UTF8')), 'hex');
  select * into target from public.players
   where room_id = v_room.id and rejoin_hash = v_hash and rejoin_expires > now()
     and state in ('active', 'left');
  if not found then return jsonb_build_object('error', 'invalid_rejoin_code'); end if;  -- see join_room

  -- If this device already joined afresh (a duplicate), fold it away.
  select * into dup from public.players
   where room_id = v_room.id and user_id = v_uid and id <> target.id;
  if found then
    if v_room.host_player_id = dup.id
       or exists (select 1 from public.rounds where reader_id = dup.id) then
      perform private.fail('cannot_claim');
    end if;
    delete from public.players where id = dup.id;
  end if;

  update public.players
     set user_id = v_uid, state = 'active', last_seen_at = now(),
         rejoin_hash = null, rejoin_expires = null
   where id = target.id;
  perform private.touch(v_room.id);
  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code, 'player_id', target.id);
end $$;

-- ----------------------------------------------------- reader controls --

-- Locks the room and returns the round, or null when p_round_id is no longer
-- the current round (a stale or repeated request, which callers ignore).
create or replace function private.current_round(p_room public.rooms, p_round_id uuid) returns public.rounds
language plpgsql stable set search_path = public, pg_temp as $$
declare r public.rounds;
begin
  if p_room.status <> 'playing' or p_room.current_round_id is distinct from p_round_id then
    return null;
  end if;
  select * into r from public.rounds where id = p_round_id;
  return r;
end $$;

create or replace function private.room_of_round(p_round_id uuid) returns uuid
language plpgsql stable set search_path = public, pg_temp as $$
declare v uuid;
begin
  select room_id into v from public.rounds where id = p_round_id;
  if v is null then perform private.fail('round_not_found'); end if;
  return v;
end $$;

create or replace function public.confirm_card(p_round_id uuid, p_word text default null, p_definition text default null)
returns jsonb
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
  if r.state <> 'card_selection' then return public.get_state(v_room_id); end if;  -- already confirmed

  if r.card_source = 'digital' then
    if r.word is null then perform private.fail('card_missing'); end if;
  else
    update public.rounds set word = private.clean_text(p_word, 60, 'invalid_word') where id = r.id;
    insert into public.round_secrets (round_id, definition)
    values (r.id, private.clean_text(p_definition, 500, 'invalid_definition'))
    on conflict (round_id) do update set definition = excluded.definition;
  end if;
  update public.rounds set state = 'collecting', state_version = state_version + 1 where id = r.id;
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

-- Digital mode: the reader swaps an unsuitable card before submissions open.
create or replace function public.replace_card(p_round_id uuid) returns jsonb
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
  if r.state <> 'card_selection' then perform private.fail('card_already_confirmed'); end if;
  if r.card_source <> 'digital' then perform private.fail('not_digital_card'); end if;
  perform private.rate_limit('replace_card', 120, 600);
  perform private.draw_card(r.id, v_room_id);
  update public.rounds set state_version = state_version + 1 where id = r.id;
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

create or replace function public.submit_definition(p_round_id uuid, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_room_id uuid;
  room public.rooms;
  me public.players;
  r public.rounds;
  v_text text;
begin
  perform private.require_uid();
  v_room_id := private.room_of_round(p_round_id);
  room := private.lock_room(v_room_id);
  me := private.me(v_room_id);
  r := private.current_round(room, p_round_id);
  if r.id is null or r.state <> 'collecting' then perform private.fail('submissions_closed'); end if;
  if me.id = any (r.former_reader_ids)
     or not exists (select 1 from public.round_eligible e
                    where e.round_id = r.id and e.player_id = me.id) then
    perform private.fail('not_eligible');
  end if;
  perform private.rate_limit('submit_definition', 60, 60);
  v_text := private.clean_text(p_text, 500, 'invalid_definition');

  insert into public.submissions as s (round_id, player_id, body)
  values (r.id, me.id, v_text)
  on conflict (round_id, player_id) do update set body = excluded.body, updated_at = now();
  if r.reader_id = me.id then
    update public.rounds set reader_skipped = false where id = r.id;
  end if;
  perform private.maybe_close(r.id);
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

-- The reader declines to write a false definition.
create or replace function public.reader_skip(p_round_id uuid) returns jsonb
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
  if r.state = 'collecting' then
    delete from public.submissions where round_id = r.id and player_id = me.id;
    update public.rounds set reader_skipped = true where id = r.id;
    perform private.maybe_close(r.id);
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

create or replace function public.close_submissions(p_round_id uuid) returns jsonb
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
  if r.state = 'card_selection' then perform private.fail('card_not_confirmed'); end if;
  if r.state = 'collecting' then
    perform private.close_round(r.id);
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

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
  if r.state in ('card_selection', 'collecting') then perform private.fail('not_ready_to_reveal'); end if;
  if r.state = 'reading' then
    update public.rounds set state = 'reveal', state_version = state_version + 1 where id = r.id;
    perform private.touch(v_room_id);
  end if;
  return public.get_state(v_room_id);
end $$;

-- Reader (or host, should the reader have gone) moves the room on.
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
  if r.state <> 'reveal' then perform private.fail('not_revealed_yet'); end if;
  update public.rounds
     set state = 'done', completed_at = now(), state_version = state_version + 1
   where id = r.id;
  perform private.start_round(room, r.scheduled_pos);
  perform private.touch(v_room_id);
  return public.get_state(v_room_id);
end $$;

-- ----------------------------------------------------------- privileges --

-- Nothing is callable by default; the client API is granted to signed-in
-- (anonymous-auth) users only.
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

-- Optional scheduled cleanup (rooms are also swept whenever a room is created).
-- With the pg_cron extension enabled, run once:
--   select cron.schedule('balderdash-cleanup', '*/15 * * * *', 'select private.cleanup_rooms()');
