// Sessions, presence, host and reader hand-over, expiry.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, newDb, table, toCollecting, type TestDb } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

const away = (id: string, seconds: number) =>
  db.admin(`update public.players set last_seen_at = now() - make_interval(secs => $2) where id = $1`, [id, seconds]);

describe('presence and reconnection', () => {
  it('a silent player shows as away but keeps their place, role and submission', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'kept' });
    await away(t.ids[1], 120);
    let s = await t.state(0);
    expect(s.players.find((p) => p.id === t.ids[1])!.connected).toBe(false);
    expect(s.players).toHaveLength(3);
    // Coming back (any device state rebuilt from get_state alone).
    const back = await t.state(1);
    expect(back.me).toMatchObject({ id: t.ids[1], name: 'P2' });
    expect(back.round).toMatchObject({ id: roundId, my_submission: 'kept', state: 'collecting' });
    s = await t.state(0);
    expect(s.players.find((p) => p.id === t.ids[1])!.connected).toBe(true);
  });

  it('a player who returns after submissions closed sees the current stage and cannot submit', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'a' });
    await t.as(0, 'close_submissions', { p_round_id: roundId });
    expect((await t.state(2)).round!.state).toBe('reading');
    expect(await code(t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'late' }))).toBe('submissions_closed');
  });

  it('host-issued rejoin code moves a player to a new session, once', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'before losing my phone' });
    const { rejoin_code } = await t.as<{ rejoin_code: string }>(0, 'issue_rejoin_code', { p_room_id: t.roomId, p_player_id: t.ids[1] });
    expect(rejoin_code).toMatch(/^[A-Z2-9]{6}$/);
    const fresh = randomUUID();
    const r = await db.rpc(fresh, 'claim_player', { p_code: t.code, p_rejoin_code: rejoin_code.toLowerCase() });
    expect(r.player_id).toBe(t.ids[1]);
    const s = await db.rpc(fresh, 'get_state', { p_room_id: t.roomId });
    expect(s.me.name).toBe('P2');
    expect(s.round.my_submission).toBe('before losing my phone');
    // The old session is no longer that player, and the code is spent.
    expect(await code(t.state(1))).toBe('not_member');
    expect(await code(db.rpc(randomUUID(), 'claim_player', { p_code: t.code, p_rejoin_code: rejoin_code }))).toBe('invalid_rejoin_code');
  });

  it('rejoin folds away the duplicate a lost player made by joining afresh', async () => {
    const t = await table(db, 3);
    const fresh = randomUUID();
    await db.rpc(fresh, 'join_room', { p_code: t.code, p_name: 'P2' });
    expect((await t.state(0)).players).toHaveLength(4);
    const { rejoin_code } = await t.as<{ rejoin_code: string }>(0, 'issue_rejoin_code', { p_room_id: t.roomId, p_player_id: t.ids[1] });
    await db.rpc(fresh, 'claim_player', { p_code: t.code, p_rejoin_code: rejoin_code });
    const s = await t.state(0);
    expect(s.players.map((p) => p.name)).toEqual(['P1', 'P2', 'P3']);
  });

  it('an expired rejoin code is refused', async () => {
    const t = await table(db, 3);
    const { rejoin_code } = await t.as<{ rejoin_code: string }>(0, 'issue_rejoin_code', { p_room_id: t.roomId, p_player_id: t.ids[1] });
    await db.admin(`update public.players set rejoin_expires = now() - interval '1 second' where id = $1`, [t.ids[1]]);
    expect(await code(db.rpc(randomUUID(), 'claim_player', { p_code: t.code, p_rejoin_code: rejoin_code }))).toBe('invalid_rejoin_code');
  });
});

describe('host hand-over', () => {
  it('host can hand over; a silent host can be replaced by any player', async () => {
    const t = await table(db, 3);
    let s = await t.as(0, 'transfer_host', { p_room_id: t.roomId, p_player_id: t.ids[1] });
    expect(s.me.is_host).toBe(false);
    expect(await code(t.as(2, 'claim_host', { p_room_id: t.roomId }))).toBe('host_still_present');
    await away(t.ids[1], 90);
    s = await t.as(2, 'claim_host', { p_room_id: t.roomId });
    expect(s.me.is_host).toBe(true);
    expect(await code(t.as(1, 'end_game', { p_room_id: t.roomId }))).toBe('not_host');
  });

  it('a host who leaves passes the room on; a player who leaves can come back', async () => {
    const t = await table(db, 3);
    await t.as(0, 'leave_room', { p_room_id: t.roomId });
    const s = await t.state(1);
    expect(s.room.host_player_id).toBe(t.ids[1]);
    expect(s.players).toHaveLength(2);
    const back = await db.rpc(t.users[0], 'join_room', { p_code: t.code, p_name: 'P1' });
    expect(back.player_id).toBe(t.ids[0]);
    expect((await t.state(1)).players).toHaveLength(3);
  });

  it('a reader who leaves mid-round hands the round to the next player', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t, 'w', 'kept answer');
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'kept text' });
    await t.as(0, 'leave_room', { p_room_id: t.roomId });
    const s = await t.state(1);
    expect(s.round).toMatchObject({ id: roundId, reader_name: 'P2', word: 'w', correct_definition: 'kept answer', my_submission: 'kept text' });
  });

  it('the last player leaving ends the room', async () => {
    const t = await table(db, 1);
    await t.as(0, 'leave_room', { p_room_id: t.roomId });
    expect(await db.admin(`select status from public.rooms where id = $1`, [t.roomId])).toEqual([{ status: 'ended' }]);
  });
});

describe('ending and expiry', () => {
  it('host ends the game for everyone; nothing more can be played', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    const s = await t.as(0, 'end_game', { p_room_id: t.roomId });
    expect(s.room.status).toBe('ended');
    expect(s.round).toBeNull();
    expect((await t.state(2)).room.status).toBe('ended');
    expect(await code(t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'x' }))).toBe('submissions_closed');
    expect(await code(db.rpc(randomUUID(), 'join_room', { p_code: t.code, p_name: 'New' }))).toBe('room_not_found');
    expect(await db.rpc(randomUUID(), 'room_exists', { p_code: t.code })).toBe(false);
  });

  it('cleanup deletes idle and ended rooms with all their data, and leaves live ones', async () => {
    const idle = await table(db, 3);
    const ended = await table(db, 3);
    const live = await table(db, 3);
    const { roundId } = await toCollecting(idle);
    await idle.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'x' });
    await ended.as(0, 'end_game', { p_room_id: ended.roomId });
    await db.admin(`update public.rooms set last_activity_at = now() - interval '7 hours' where id = $1`, [idle.roomId]);
    await db.admin(`update public.rooms set last_activity_at = now() - interval '31 minutes' where id = $1`, [ended.roomId]);
    await db.admin(`select private.cleanup_rooms()`);
    const left = (await db.admin(`select id from public.rooms where id = any($1)`, [[idle.roomId, ended.roomId, live.roomId]])).map((r) => r.id);
    expect(left).toEqual([live.roomId]);
    for (const tbl of ['players', 'rounds', 'submissions', 'round_secrets']) {
      const q = tbl === 'players' || tbl === 'rounds'
        ? `select count(*)::int as n from public.${tbl} where room_id = $1`
        : `select count(*)::int as n from public.${tbl} where round_id = $1`;
      expect(await db.admin(q, [tbl === 'players' || tbl === 'rounds' ? idle.roomId : roundId]), tbl).toEqual([{ n: 0 }]);
    }
    // An expired invitation reads as "not found"; the old session is told the same.
    expect(await code(db.rpc(randomUUID(), 'join_room', { p_code: idle.code, p_name: 'A' }))).toBe('room_not_found');
    expect(await code(idle.state(0))).toBe('room_not_found');
  });

  it('expiry times are configurable', async () => {
    const t = await table(db, 3);
    await db.admin(`update public.app_config set value = '1' where key = 'room_inactivity_hours'`);
    await db.admin(`update public.rooms set last_activity_at = now() - interval '61 minutes' where id = $1`, [t.roomId]);
    await db.admin(`select private.cleanup_rooms()`);
    await db.admin(`update public.app_config set value = '6' where key = 'room_inactivity_hours'`);
    expect(await db.admin(`select 1 from public.rooms where id = $1`, [t.roomId])).toEqual([]);
  });

  it('room versions only go up, so clients can discard stale snapshots', async () => {
    const t = await table(db, 3);
    const versions: number[] = [(await t.state(0)).version];
    const { roundId } = await toCollecting(t);
    versions.push((await t.state(0)).version);
    versions.push((await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'a' })).version);
    versions.push((await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'b' })).version);
    versions.push((await t.as(0, 'close_submissions', { p_round_id: roundId })).version);
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    // Reading the state does not change the version.
    expect((await t.state(2)).version).toBe(versions[versions.length - 1]);
  });
});

describe('the real word list', () => {
  it('the sample seed loads and deals cards', async () => {
    const real = await newDb({ words: 'sample' });
    try {
      const [{ n }] = await real.admin(`select count(*)::int as n from public.words where source like 'Webster%'`);
      expect(n).toBeGreaterThan(20);
      const t = await table(real, 3, 'digital');
      const s = await t.as(0, 'start_game', { p_room_id: t.roomId });
      expect(s.round!.word).toMatch(/^[a-z]+$/);
      expect(s.round!.correct_definition!.length).toBeGreaterThan(10);
    } finally {
      await real.close();
    }
  });
});
