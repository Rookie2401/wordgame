// What a hostile or merely curious client can reach. Each test plays the part
// of a signed-in player issuing requests the app itself would never send.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, newDb, table, toCollecting, type Table, type TestDb } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

const SECRET = 'THE-SECRET-CORRECT-DEFINITION';
const PRIVATE_TABLES = [
  'players', 'rounds', 'round_secrets', 'round_eligible', 'submissions',
  'shuffled_definitions', 'shuffled_private', 'words', 'used_cards', 'rate_limits', 'app_config',
];

describe('direct database access', () => {
  it('no game table can be read or written by a player or an anonymous visitor', async () => {
    const t = await table(db, 3);
    await toCollecting(t, 'w', SECRET);
    for (const who of [t.users[1], null]) {
      for (const tbl of PRIVATE_TABLES) {
        expect(await code(db.queryAs(who, `select * from public.${tbl}`)), `${tbl} select`).toMatch(/permission denied/);
        expect(await code(db.queryAs(who, `delete from public.${tbl}`)), `${tbl} delete`).toMatch(/permission denied/);
      }
      expect(await code(db.queryAs(who, `update public.rooms set status = 'ended'`))).toMatch(/permission denied/);
      expect(await code(db.queryAs(who, `insert into public.rooms (code, mode) values ('AAAAA', 'physical')`))).toMatch(/permission denied/);
    }
  });

  it('row level security is on for every table, so a stray grant would still expose nothing', async () => {
    const rows = await db.admin(
      `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
    const t = await table(db, 3);
    await toCollecting(t, 'w', SECRET);
    await db.admin(`grant select on public.round_secrets, public.submissions, public.words to authenticated`);
    try {
      expect(await db.queryAs(t.users[1], `select * from public.round_secrets`)).toEqual([]);
      expect(await db.queryAs(t.users[1], `select * from public.submissions`)).toEqual([]);
      expect(await db.queryAs(t.users[1], `select * from public.words`)).toEqual([]);
    } finally {
      await db.admin(`revoke select on public.round_secrets, public.submissions, public.words from authenticated`);
    }
  });

  it('a player sees only their own room row, which holds no secrets', async () => {
    const a = await table(db, 3);
    const b = await table(db, 3);
    await toCollecting(a, 'w', SECRET);
    const rows = await db.queryAs(a.users[1], `select * from public.rooms`);
    expect(rows.map((r) => r.id)).toEqual([a.roomId]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'code', 'created_at', 'current_round_id', 'game_number', 'host_player_id', 'id', 'last_activity_at', 'mode',
        'rotation_limit', 'ruleset', 'scoring', 'status', 'target_score', 'version', 'win_type',
      ], // the added columns are the room's public options; none is secret
    );
    expect(await db.queryAs(randomUUID(), `select * from public.rooms`)).toEqual([]);
    expect(await db.queryAs(null, `select 1 from public.rooms`).catch(() => [])).toEqual([]);
    expect(b.roomId).not.toBe(a.roomId);
  });

  it('internal functions cannot be called, and anonymous visitors can call nothing', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t, 'w', SECRET);
    for (const sql of [
      `select private.close_round('${roundId}')`,
      `select private.draw_card('${roundId}', '${t.roomId}')`,
      `select private.cleanup_rooms()`,
      `select private.touch('${t.roomId}')`,
      `select private.change_reader('${roundId}', '${t.ids[1]}')`,
    ]) {
      expect(await code(db.queryAs(t.users[1], sql)), sql).toMatch(/permission denied/);
    }
    expect(await code(db.queryAs(null, `select public.get_state('${t.roomId}')`))).toMatch(/permission denied/);
    expect(await code(db.queryAs(null, `select public.create_room('x', 'physical')`))).toMatch(/permission denied/);
  });
});

describe('what get_state gives each player', () => {
  let t: Table;
  let roundId: string;
  beforeAll(async () => {
    t = await table(db, 4);
    ({ roundId } = await toCollecting(t, 'quire', SECRET));
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'P2-PRIVATE-TEXT' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'P3-PRIVATE-TEXT' });
  });

  it('while collecting: no correct definition, no one else’s text', async () => {
    for (const i of [1, 2, 3]) {
      const json = JSON.stringify(await t.state(i));
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain(i === 1 ? 'P3-PRIVATE-TEXT' : 'P2-PRIVATE-TEXT');
      expect(json).not.toContain('submitted_player_ids');
    }
    // The reader sees who has submitted, never what.
    const reader = await t.state(0);
    expect(reader.round!.correct_definition).toBe(SECRET);
    expect(reader.round!.submitted_player_ids!.sort()).toEqual([t.ids[1], t.ids[2]].sort());
    expect(JSON.stringify(reader)).not.toContain('PRIVATE-TEXT');
  });

  it('while reading: players get nothing; the reader gets text and position only', async () => {
    await t.as(0, 'reader_skip', { p_round_id: roundId });
    await t.as(0, 'close_submissions', { p_round_id: roundId });
    for (const i of [1, 2, 3]) {
      const s = await t.state(i);
      expect(s.round!.definitions).toBeUndefined();
      expect(JSON.stringify(s)).not.toContain(SECRET);
    }
    const defs = (await t.state(0)).round!.definitions!;
    expect(defs).toHaveLength(3);
    for (const d of defs) expect(Object.keys(d).sort()).toEqual(['id', 'position', 'text']);
    // Opaque ids: not the submission ids, not the player ids.
    const subIds = (await db.admin(`select id from public.submissions where round_id = $1`, [roundId])).map((r) => r.id);
    for (const d of defs) {
      expect(subIds).not.toContain(d.id);
      expect(t.ids).not.toContain(d.id);
    }
  });

  it('after the reveal everyone gets authors and the answer', async () => {
    await t.as(0, 'reveal_answers', { p_round_id: roundId });
    const s = await t.state(3);
    expect(s.round!.definitions!.find((d) => d.is_correct)!.text).toBe(SECRET);
    expect(s.round!.definitions!.filter((d) => !d.is_correct).map((d) => d.author_name).sort()).toEqual(['P2', 'P3']);
  });
});

describe('permissions', () => {
  it('only the reader may close, reveal, skip or replace', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    for (const fn of ['close_submissions', 'reveal_answers', 'reader_skip', 'replace_card']) {
      expect(await code(t.as(1, fn, { p_round_id: roundId })), fn).toBe('not_reader');
    }
  });

  it('only the host may run host actions', async () => {
    const t = await table(db, 3);
    const r = { p_room_id: t.roomId };
    const p = { ...r, p_player_id: t.ids[2] };
    expect(await code(t.as(1, 'end_game', r))).toBe('not_host');
    expect(await code(t.as(1, 'remove_player', p))).toBe('not_host');
    expect(await code(t.as(1, 'transfer_host', p))).toBe('not_host');
    expect(await code(t.as(1, 'issue_rejoin_code', p))).toBe('not_host');
    expect(await code(t.as(1, 'set_reader', p))).toBe('not_host');
    expect(await code(t.as(1, 'claim_host', r))).toBe('host_still_present');
  });

  it('a player cannot touch another player’s submission', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'mine' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'theirs' });
    // submit_definition has no "player" argument: it can only write the caller's row.
    const rows = await db.admin(`select player_id, body from public.submissions where round_id = $1 order by body`, [roundId]);
    expect(rows).toEqual([{ player_id: t.ids[1], body: 'mine' }, { player_id: t.ids[2], body: 'theirs' }]);
    expect(await code(db.queryAs(t.users[1], `update public.submissions set body = 'hacked'`))).toMatch(/permission denied/);
  });

  it('outsiders and other rooms’ players get nothing from a room', async () => {
    const a = await table(db, 3);
    const b = await table(db, 3);
    const { roundId } = await toCollecting(a, 'w', SECRET);
    const outsider = b.users[0];
    expect(await code(db.rpc(outsider, 'get_state', { p_room_id: a.roomId }))).toBe('not_member');
    for (const fn of ['close_submissions', 'reveal_answers', 'next_round', 'reader_skip', 'confirm_card', 'replace_card']) {
      expect(await code(db.rpc(outsider, fn, { p_round_id: roundId })), fn).toBe('not_member');
    }
    expect(await code(db.rpc(outsider, 'submit_definition', { p_round_id: roundId, p_text: 'x' }))).toBe('not_member');
    for (const fn of ['start_game', 'end_game', 'leave_room', 'claim_host']) {
      expect(await code(db.rpc(outsider, fn, { p_room_id: a.roomId })), fn).toBe('not_member');
    }
    expect(await code(db.rpc(outsider, 'remove_player', { p_room_id: a.roomId, p_player_id: a.ids[1] }))).toBe('not_member');
  });

  it('a name is never enough to become another player', async () => {
    const t = await table(db, 3);
    const impostor = randomUUID();
    const j = await db.rpc(impostor, 'join_room', { p_code: t.code, p_name: 'P2' });
    expect(j.player_id).not.toBe(t.ids[1]);
    const s = await db.rpc(impostor, 'get_state', { p_room_id: t.roomId });
    expect(s.me.name).toBe('P2 (2)');
    expect(await code(db.rpc(impostor, 'claim_player', { p_code: t.code, p_rejoin_code: 'AAAAAA' }))).toBe('invalid_rejoin_code');
  });

  it('rate limits repeated guessing of rejoin codes', async () => {
    const t = await table(db, 3);
    const u = randomUUID();
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push(await code(db.rpc(u, 'claim_player', { p_code: t.code, p_rejoin_code: 'AAAAAA' })));
    expect(results.slice(0, 10).every((r) => r === 'invalid_rejoin_code')).toBe(true);
    expect(results.slice(10)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('text that looks like markup is stored and returned as plain text', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    const nasty = `<img src=x onerror=alert(1)>'; drop table rooms; --`;
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: nasty });
    expect((await t.state(1)).round!.my_submission).toBe(nasty);
    expect(await db.admin(`select count(*)::int as n from public.rooms where id = $1`, [t.roomId])).toEqual([{ n: 1 }]);
  });
});
