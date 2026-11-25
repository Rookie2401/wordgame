// A reader who leaves or is removed part-way through a rotation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDb, table, type Table, type TestDb } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

/** Finishes the current traditional round as its reader and returns the next snapshot. */
async function finish(t: Table, reader: number, roundId: string) {
  await t.as(reader, 'close_submissions', { p_round_id: roundId });
  await t.as(reader, 'reveal_answers', { p_round_id: roundId });
  return t.as(reader, 'next_round', { p_round_id: roundId });
}

describe('a departing reader', () => {
  it('passes the turn on, and the player who takes it does not read twice in the rotation', async () => {
    const t = await table(db, 4);
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round!.id;
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: 'd' });
    await t.as(0, 'leave_room', { p_room_id: t.roomId });
    s = await t.state(1);
    expect(s.round).toMatchObject({ id: rid, reader_name: 'P2', word: 'w', correct_definition: 'd' });
    s = await finish(t, 1, rid);
    expect(s.round!.reader_name).toBe('P3'); // not P2 again
    await t.as(2, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
    s = await finish(t, 2, s.round!.id);
    expect(s.round!.reader_name).toBe('P4');
    // New rotation: the three who remain, from the top.
    await t.as(3, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
    s = await finish(t, 3, s.round!.id);
    expect(s.round).toMatchObject({ reader_name: 'P2', rotation: 2 });
  });

  it('the last reader of a rotation being removed starts the next rotation, not a repeat', async () => {
    const t = await table(db, 3);
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    for (const i of [0, 1]) {
      await t.as(i, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
      s = await finish(t, i, s.round!.id);
    }
    expect(s.round).toMatchObject({ reader_name: 'P3', rotation: 1 });
    s = await t.as(0, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[2] });
    expect(s.round).toMatchObject({ reader_name: 'P1', rotation: 2, number: 3 });
    await t.as(0, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
    s = await finish(t, 0, s.round!.id);
    expect(s.round).toMatchObject({ reader_name: 'P2', rotation: 2 });
  });

  it('a reader the host merely lends the round to still gets their own turn', async () => {
    const t = await table(db, 4);
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    await t.as(0, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
    await t.as(0, 'set_reader', { p_room_id: t.roomId, p_player_id: t.ids[2] });
    s = await finish(t, 2, s.round!.id);
    expect(s.round!.reader_name).toBe('P2');
    await t.as(1, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
    s = await finish(t, 1, s.round!.id);
    expect(s.round!.reader_name).toBe('P3');
  });
});
