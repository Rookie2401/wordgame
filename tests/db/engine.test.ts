// The game engine, run against the real migrations in an in-process Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, newDb, table, toCollecting, type TestDb } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

describe('rooms and joining', () => {
  it('creates a room with a five-character code from the safe alphabet', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const r = await db.rpc(randomUUID(), 'create_room', { p_name: 'Host', p_mode: 'physical' });
      expect(r.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
      codes.add(r.code);
    }
    expect(codes.size).toBe(15);
  });

  it('retries when a generated code is already taken', async () => {
    // Force collisions: a code generator that returns a taken code twice.
    const taken = (await db.rpc(randomUUID(), 'create_room', { p_name: 'A', p_mode: 'physical' })).code;
    await db.admin(`create sequence if not exists private.test_seq`);
    await db.admin(`alter function private.new_code(int) rename to new_code_real`);
    await db.admin(`
      create function private.new_code(p_len int) returns text language plpgsql as $$
      begin
        if p_len = 5 and nextval('private.test_seq') <= 2 then return '${taken}'; end if;
        return private.new_code_real(p_len);
      end $$`);
    try {
      const r = await db.rpc(randomUUID(), 'create_room', { p_name: 'B', p_mode: 'physical' });
      expect(r.code).not.toBe(taken);
    } finally {
      await db.admin(`drop function private.new_code(int)`);
      await db.admin(`alter function private.new_code_real(int) rename to new_code`);
    }
  });

  it('joins by code in any letter case; joining twice gives the same player', async () => {
    const t = await table(db, 1);
    const u = randomUUID();
    const a = await db.rpc(u, 'join_room', { p_code: t.code.toLowerCase(), p_name: 'Dan' });
    const b = await db.rpc(u, 'join_room', { p_code: ` ${t.code} `, p_name: 'Dan again' });
    expect(b.player_id).toBe(a.player_id);
    expect((await t.state(0)).players).toHaveLength(2);
  });

  it('tells two players with the same name apart', async () => {
    const t = await table(db, 1);
    await db.rpc(randomUUID(), 'join_room', { p_code: t.code, p_name: 'Sam' });
    await db.rpc(randomUUID(), 'join_room', { p_code: t.code, p_name: 'sam' });
    expect((await t.state(0)).players.map((p) => p.name)).toEqual(['P1', 'Sam', 'sam (2)']);
  });

  it('rejects bad names, unknown codes and bad modes', async () => {
    const t = await table(db, 1);
    expect(await code(db.rpc(randomUUID(), 'join_room', { p_code: t.code, p_name: '   ' }))).toBe('invalid_name');
    expect(await code(db.rpc(randomUUID(), 'join_room', { p_code: t.code, p_name: 'x'.repeat(25) }))).toBe('invalid_name');
    expect(await code(db.rpc(randomUUID(), 'join_room', { p_code: 'ZZZZZ', p_name: 'A' }))).toBe('room_not_found');
    expect(await code(db.rpc(randomUUID(), 'create_room', { p_name: 'A', p_mode: 'x' }))).toBe('invalid_mode');
  });

  it('needs three players, and only the host may start', async () => {
    const t = await table(db, 2);
    expect(await code(t.as(0, 'start_game', { p_room_id: t.roomId }))).toBe('need_three_players');
    await db.rpc(randomUUID(), 'join_room', { p_code: t.code, p_name: 'C' });
    expect(await code(t.as(1, 'start_game', { p_room_id: t.roomId }))).toBe('not_host');
    const s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(s.room.status).toBe('playing');
    // A second tap changes nothing.
    const again = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(again.round!.id).toBe(s.round!.id);
    expect(again.round!.number).toBe(1);
  });

  it('lets the host reorder readers before the game, and remove a player', async () => {
    const t = await table(db, 4);
    await t.as(0, 'reorder_players', { p_room_id: t.roomId, p_player_ids: [t.ids[2], t.ids[0], t.ids[3], t.ids[1]] });
    expect(await code(t.as(0, 'reorder_players', { p_room_id: t.roomId, p_player_ids: [t.ids[0]] }))).toBe('invalid_order');
    expect(await code(t.as(1, 'reorder_players', { p_room_id: t.roomId, p_player_ids: t.ids }))).toBe('not_host');
    await t.as(0, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[3] });
    expect(await code(t.state(3))).toBe('removed_from_room');
    expect(await code(db.rpc(t.users[3], 'join_room', { p_code: t.code, p_name: 'Back' }))).toBe('removed_from_room');
    const s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(s.round!.reader_id).toBe(t.ids[2]);
  });
});

describe('reader rotation', () => {
  it('goes round the table in join order and wraps', async () => {
    const t = await table(db, 4);
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const readers: string[] = [];
    for (let round = 1; round <= 6; round++) {
      const r = t.ids.indexOf(s.round!.reader_id);
      readers.push(s.round!.reader_name);
      expect(s.round!.number).toBe(round);
      await t.as(r, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
      await t.as(r, 'reader_skip', { p_round_id: s.round!.id });
      await t.as(r, 'close_submissions', { p_round_id: s.round!.id });
      await t.as(r, 'reveal_answers', { p_round_id: s.round!.id });
      s = await t.as(r, 'next_round', { p_round_id: s.round!.id });
    }
    expect(readers).toEqual(['P1', 'P2', 'P3', 'P4', 'P1', 'P2']);
  });

  it('host can skip the reader before the card; rotation carries on from there', async () => {
    const t = await table(db, 4);
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(await code(t.as(1, 'skip_reader', { p_room_id: t.roomId, p_round_id: s.round!.id }))).toBe('not_host');
    s = await t.as(0, 'skip_reader', { p_room_id: t.roomId, p_round_id: s.round!.id });
    expect(s.round!.reader_name).toBe('P2');
    await t.as(1, 'confirm_card', { p_round_id: s.round!.id, p_word: 'w', p_definition: 'd' });
    await t.as(1, 'close_submissions', { p_round_id: s.round!.id });
    await t.as(1, 'reveal_answers', { p_round_id: s.round!.id });
    s = await t.as(1, 'next_round', { p_round_id: s.round!.id });
    expect(s.round!.reader_name).toBe('P3');
  });

  it('replacing the reader mid-round keeps the word and the other players’ submissions', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t, 'quire', 'true meaning');
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'from P2' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'from P3' });
    expect((await t.state(2)).round!.correct_definition).toBeUndefined();
    const s = await t.as(0, 'set_reader', { p_room_id: t.roomId, p_player_id: t.ids[2] });
    expect(s.round!.reader_name).toBe('P3');
    expect(s.round!.word).toBe('quire');
    // The new reader now sees the answer; the old one no longer does and may not submit.
    expect((await t.state(2)).round!.correct_definition).toBe('true meaning');
    expect((await t.state(0)).round!.correct_definition).toBeUndefined();
    expect(await code(t.as(0, 'submit_definition', { p_round_id: roundId, p_text: 'x' }))).toBe('not_eligible');
    // What the new reader wrote as a guess is dropped: a reader's text is read out as the answer.
    expect((await t.state(2)).round!.my_submission).toBeNull();
    const after = await t.as(3, 'submit_definition', { p_round_id: roundId, p_text: 'from P4' });
    expect(after.round!.state).toBe('collecting'); // the new reader has yet to choose a wording
    await t.as(2, 'reader_skip', { p_round_id: roundId });
    const list = (await t.state(2)).round!.definitions!;
    expect(list.map((d) => d.text).sort()).toEqual(['from P2', 'from P4', 'true meaning']);
    // Next round continues after the originally scheduled reader.
    await t.as(2, 'reveal_answers', { p_round_id: roundId });
    expect((await t.as(2, 'next_round', { p_round_id: roundId })).round!.reader_name).toBe('P2');
  });

  it('removing the reader passes the role to the next player', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t);
    const s = await t.as(0, 'transfer_host', { p_room_id: t.roomId, p_player_id: t.ids[1] });
    expect(s.room.host_player_id).toBe(t.ids[1]);
    const after = await t.as(1, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[0] });
    expect(after.round!.reader_name).toBe('P2');
    expect(after.round!.id).toBe(roundId);
    expect(after.round!.correct_definition).toBe('Twenty-four sheets of paper.');
  });
});

describe('round lifecycle', () => {
  it('walks card -> collecting -> reading -> reveal -> next, refusing steps out of order', async () => {
    const t = await table(db, 3);
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round!.id;
    expect(s.round!.state).toBe('card_selection');
    expect(await code(t.as(1, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: 'd' }))).toBe('not_reader');
    expect(await code(t.as(0, 'confirm_card', { p_round_id: rid, p_word: ' ', p_definition: 'd' }))).toBe('invalid_word');
    expect(await code(t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: '' }))).toBe('invalid_definition');
    expect(await code(t.as(1, 'submit_definition', { p_round_id: rid, p_text: 'early' }))).toBe('submissions_closed');
    expect(await code(t.as(0, 'close_submissions', { p_round_id: rid }))).toBe('card_not_confirmed');
    expect(await code(t.as(0, 'reveal_answers', { p_round_id: rid }))).toBe('not_ready_to_reveal');
    expect(await code(t.as(0, 'next_round', { p_round_id: rid }))).toBe('not_revealed_yet');

    s = await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'apricity', p_definition: 'Warmth of the winter sun.' });
    expect(s.round!.state).toBe('collecting');
    // The card is locked once submissions are open.
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'other', p_definition: 'changed' });
    expect((await t.state(0)).round).toMatchObject({ word: 'apricity', correct_definition: 'Warmth of the winter sun.' });
    expect(await code(t.as(0, 'reveal_answers', { p_round_id: rid }))).toBe('not_ready_to_reveal');

    await t.as(1, 'submit_definition', { p_round_id: rid, p_text: 'one' });
    s = await t.as(0, 'close_submissions', { p_round_id: rid });
    expect(s.round!.state).toBe('reading');
    expect(await code(t.as(2, 'submit_definition', { p_round_id: rid, p_text: 'late' }))).toBe('submissions_closed');
    expect(await code(t.as(1, 'reveal_answers', { p_round_id: rid }))).toBe('not_reader');
    expect(await code(t.as(0, 'next_round', { p_round_id: rid }))).toBe('not_revealed_yet');

    s = await t.as(0, 'reveal_answers', { p_round_id: rid });
    expect(s.round!.state).toBe('reveal');
    expect(await code(t.as(2, 'next_round', { p_round_id: rid }))).toBe('not_reader');
    s = await t.as(0, 'next_round', { p_round_id: rid });
    expect(s.round!.number).toBe(2);
    // A repeated "next round" for the old round does nothing.
    s = await t.as(0, 'next_round', { p_round_id: rid });
    expect(s.round!.number).toBe(2);
    expect(await db.admin(`select state from public.rounds where id = $1`, [rid])).toEqual([{ state: 'done' }]);
  });

  it('validates definitions and keeps the wording exactly', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    expect(await code(t.as(1, 'submit_definition', { p_round_id: roundId, p_text: '  \n\t ' }))).toBe('invalid_definition');
    expect(await code(t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'x'.repeat(501) }))).toBe('invalid_definition');
    const text = 'A “Fancy” hat; worn (rarely) by BISHOPS!\n<b>second line</b>';
    const s = await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: `  ${text}  ` });
    expect(s.round!.my_submission).toBe(text);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'x'.repeat(500) });
  });

  it('editing replaces a submission instead of adding one', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'first' });
    const s = await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'second' });
    expect(s.round!.my_submission).toBe('second');
    expect(s.round!.submitted_count).toBe(1);
    const rows = await db.admin(`select body from public.submissions where round_id = $1`, [roundId]);
    expect(rows).toEqual([{ body: 'second' }]);
  });

  it('advances by itself when everyone is in and the reader has submitted or skipped', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'a' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'b' });
    let s = await t.as(3, 'submit_definition', { p_round_id: roundId, p_text: 'c' });
    expect(s.round).toMatchObject({ state: 'collecting', submitted_count: 3, required_count: 3, reader_done: false });
    s = await t.as(0, 'submit_definition', { p_round_id: roundId, p_text: 'the reader’s own wording' });
    expect(s.round!.state).toBe('reading');
    // Three players' definitions and the genuine one, in the reader's wording instead of the card's.
    expect(s.round!.definitions!.map((d) => d.text).sort()).toEqual(['a', 'b', 'c', 'the reader’s own wording']);
  });

  it('reader may skip; the correct definition appears exactly once', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t, 'w', 'THE TRUTH');
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'a' });
    await t.as(0, 'reader_skip', { p_round_id: roundId });
    const s = await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'b' });
    expect(s.round!.state).toBe('reading');
    const defs = (await t.state(0)).round!.definitions!;
    expect(defs.filter((d) => d.text === 'THE TRUTH')).toHaveLength(1);
    expect(defs.map((d) => d.position)).toEqual([1, 2, 3]);
  });

  it('keeps identical definitions, and a correct guess, as separate credited entries', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t, 'w', 'same text');
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'same text' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'twin' });
    await t.as(3, 'submit_definition', { p_round_id: roundId, p_text: 'twin' });
    await t.as(0, 'reader_skip', { p_round_id: roundId });
    const s = await t.as(0, 'reveal_answers', { p_round_id: roundId });
    const defs = s.round!.definitions!;
    expect(defs).toHaveLength(4);
    expect(defs.filter((d) => d.is_correct)).toHaveLength(1);
    expect(defs.filter((d) => d.text === 'same text' && !d.is_correct)[0].author_name).toBe('P2');
    expect(defs.filter((d) => d.text === 'twin').map((d) => d.author_name).sort()).toEqual(['P3', 'P4']);
  });

  it('reveal shows the same order with authors, to everyone; the reader’s wording is the correct definition', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t, 'w', 'truth');
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'p2' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'p3' });
    const reading = await t.as(0, 'submit_definition', { p_round_id: roundId, p_text: 'mine' });
    const order = reading.round!.definitions!.map((d) => d.id);
    await t.as(0, 'reveal_answers', { p_round_id: roundId });
    for (const i of [0, 1, 2]) {
      const defs = (await t.state(i)).round!.definitions!;
      expect(defs.map((d) => d.id)).toEqual(order);
      expect(defs).toHaveLength(3);
      expect(defs.find((d) => d.text === 'mine')).toMatchObject({ is_correct: true, author_id: null, by_reader: false });
      expect(defs.find((d) => d.text === 'truth')).toBeUndefined(); // the card's wording is not a separate entry
      expect((await t.state(i)).round!.card_definition).toBe('truth'); // but everyone is told it at the reveal
    }
  });

  it('the stored order survives refreshes, and a second close cannot reshuffle', async () => {
    const t = await table(db, 6);
    const { roundId } = await toCollecting(t);
    for (let i = 1; i < 6; i++) await t.as(i, 'submit_definition', { p_round_id: roundId, p_text: `d${i}` });
    const first = (await t.as(0, 'close_submissions', { p_round_id: roundId })).round!.definitions!;
    for (let k = 0; k < 5; k++) {
      await t.as(0, 'close_submissions', { p_round_id: roundId });
      expect((await t.state(0)).round!.definitions).toEqual(first);
    }
    expect(await db.admin(`select count(*)::int as n from public.shuffled_definitions where round_id = $1`, [roundId])).toEqual([{ n: 6 }]);
  });

  it('someone joining mid-round sits out until the next round and never blocks it', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t);
    const late = randomUUID();
    const j = await db.rpc(late, 'join_room', { p_code: t.code, p_name: 'Late' });
    let s = await db.rpc(late, 'get_state', { p_room_id: t.roomId });
    expect(s.round.eligible).toBe(false);
    expect(await code(db.rpc(late, 'submit_definition', { p_round_id: roundId, p_text: 'x' }))).toBe('not_eligible');
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'a' });
    await t.as(0, 'reader_skip', { p_round_id: roundId });
    s = await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'b' });
    expect(s.round!.state).toBe('reading');
    await t.as(0, 'reveal_answers', { p_round_id: roundId });
    await t.as(0, 'next_round', { p_round_id: roundId });
    s = await db.rpc(late, 'get_state', { p_room_id: t.roomId });
    expect(s.round.eligible).toBe(true);
    expect(s.players.map((p: any) => p.id)).toContain(j.player_id);
  });

  it('a removed player no longer holds up the round and their text is left out', async () => {
    const t = await table(db, 4);
    const { roundId } = await toCollecting(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'stay' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'goes' });
    await t.as(0, 'reader_skip', { p_round_id: roundId });
    await t.as(0, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[2] });
    const s = await t.as(0, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[3] });
    expect(s.round!.state).toBe('reading');
    expect(s.round!.definitions!.map((d) => d.text).sort()).toEqual(['Twenty-four sheets of paper.', 'stay']);
  });
});

describe('shuffle', () => {
  it('rand_int is in range and roughly uniform', async () => {
    const rows = await db.admin(
      `select v, count(*)::int as n from (select private.rand_int(6) as v from generate_series(1, 6000)) x group by v order by v`,
    );
    expect(rows.map((r) => r.v)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const r of rows) expect(r.n).toBeGreaterThan(850), expect(r.n).toBeLessThan(1150);
  });

  it('puts the correct definition in every position about equally often', async () => {
    const t = await table(db, 3);
    const counts = [0, 0, 0];
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const N = 150;
    for (let k = 0; k < N; k++) {
      await db.admin('delete from public.rate_limits'); // far more rounds per minute than a real table
      const r = t.ids.indexOf(s.round!.reader_id);
      const rid = s.round!.id;
      await t.as(r, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: 'TRUE' });
      for (let i = 0; i < 3; i++) if (i !== r) await t.as(i, 'submit_definition', { p_round_id: rid, p_text: `f${i}` });
      const defs = (await t.as(r, 'reader_skip', { p_round_id: rid })).round!.definitions!;
      counts[defs.findIndex((d) => d.text === 'TRUE')]++;
      await t.as(r, 'reveal_answers', { p_round_id: rid });
      s = await t.as(r, 'next_round', { p_round_id: rid });
    }
    // Expected 50 each; a fair shuffle lands within these bounds all but ~1 in 10^5 runs.
    for (const c of counts) expect(c).toBeGreaterThan(24), expect(c).toBeLessThan(78);
  });
});

describe('digital cards', () => {
  it('deals a word to the reader only, never repeats, and falls back when exhausted', async () => {
    const t = await table(db, 3, 'digital');
    let s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const seen: string[] = [];
    // 6 fixture words: draw 3 by replacing, then play on until they run out.
    expect(s.round).toMatchObject({ card_source: 'digital', pronunciation: 'fix·ture' });
    expect(s.round!.correct_definition).toMatch(/^Fixture definition/);
    expect((await t.state(1)).round!.word).toBeNull();
    seen.push(s.round!.word!);
    expect(await code(t.as(1, 'replace_card', { p_round_id: s.round!.id }))).toBe('not_reader');
    for (let k = 0; k < 2; k++) {
      s = await t.as(0, 'replace_card', { p_round_id: s.round!.id });
      seen.push(s.round!.word!);
    }
    // Play rounds until the six fixture words are used up.
    for (let k = 0; k < 4; k++) {
      const r = t.ids.indexOf(s.round!.reader_id);
      const rid = s.round!.id;
      await t.as(r, 'confirm_card', { p_round_id: rid, p_word: 'ignored', p_definition: 'ignored' });
      expect((await t.state((r + 1) % 3)).round!.word).toBe(seen[seen.length - 1]);
      expect(await code(t.as(r, 'replace_card', { p_round_id: rid }))).toBe('card_already_confirmed');
      await t.as(r, 'close_submissions', { p_round_id: rid });
      await t.as(r, 'reveal_answers', { p_round_id: rid });
      s = await t.as(r, 'next_round', { p_round_id: rid });
      s = await t.state(t.ids.indexOf(s.round!.reader_id)); // the new reader's view
      if (s.round!.word) seen.push(s.round!.word);
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    // Seventh card: dictionary exhausted, the reader enters one by hand.
    expect(s.round).toMatchObject({ card_source: 'manual_fallback', word: null });
    const r2 = t.ids.indexOf(s.round!.reader_id);
    expect(await code(t.as(r2, 'confirm_card', { p_round_id: s.round!.id }))).toBe('invalid_word');
    s = await t.as(r2, 'confirm_card', { p_round_id: s.round!.id, p_word: 'hand', p_definition: 'typed in' });
    expect(s.round).toMatchObject({ state: 'collecting', word: 'hand', correct_definition: 'typed in' });
  });

  it('a different room can use the same words again', async () => {
    const t = await table(db, 3, 'digital');
    const s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(s.round!.word).toMatch(/^fixtureword/);
  });

  it('redraws the card if the reader changes before confirming', async () => {
    const t = await table(db, 3, 'digital');
    const s = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const s2 = await t.as(0, 'skip_reader', { p_room_id: t.roomId, p_round_id: s.round!.id });
    expect(s2.round!.reader_name).toBe('P2');
    expect((await t.state(1)).round!.word).not.toBe(s.round!.word);
  });
});
