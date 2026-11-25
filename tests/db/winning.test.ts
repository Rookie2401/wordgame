// When a game ends, who has won, and what happens next.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIE, TRUTH, advance, beginRound, code, joinLate, newDb, quickRound, scoredTable, table, toCollecting,
  type QuickOpts, type Table, type TestDb,
} from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

/** Plays rounds (default votes: everyone finds the genuine definition) until the game ends. */
async function run(t: Table, quick: (round: number) => QuickOpts = () => ({}), cap = 60) {
  const log: { reader: number; rotation: number; number: number; isFinal: boolean; finalRotation: boolean }[] = [];
  for (let r = 0; r < cap; r++) {
    const ctx = await quickRound(t, quick(r));
    const res: any = await t.state(ctx.reader);
    log.push({
      reader: ctx.reader,
      rotation: res.round.rotation,
      number: res.round.number,
      isFinal: res.round.is_final,
      finalRotation: res.final_rotation,
    });
    const next: any = await advance(t, ctx);
    if (next.room.status === 'ended') return { log, ended: next, last: ctx };
  }
  throw new Error('the game never ended');
}

const roundCount = async (t: Table) =>
  (await db.admin(`select count(*)::int as n from public.rounds where room_id = $1`, [t.roomId]))[0].n;

describe('playing to a target score', () => {
  it('reaching the target mid-rotation lets the rotation finish, then the game ends', async () => {
    const t = await scoredTable(db, 4, { win_type: 'target', target: 5 });
    const mk = async (votes?: QuickOpts['votes']) => quickRound(t, votes ? { votes } : {});
    // rounds 1-3: every voter finds the genuine definition (2 each)
    let ctx = await mk();
    let s: any = await t.state(0);
    expect(s.final_rotation).toBe(false);
    expect(s.room).toMatchObject({ win_type: 'target', target_score: 5, rotation_limit: null });
    await advance(t, ctx);
    ctx = await mk();
    expect((await t.state(0) as any).final_rotation).toBe(false); // best is 4
    await advance(t, ctx);
    ctx = await mk(); // P4 reaches 6
    s = await t.state(0);
    expect(Object.fromEntries(s.standings.map((x: any) => [x.name, x.total]))).toEqual({ P1: 4, P2: 4, P3: 4, P4: 6 });
    expect(s.final_rotation).toBe(true);
    expect(s.round.is_final).toBe(false); // P4 has yet to read this rotation
    s = await advance(t, ctx);
    expect(s.room.status).toBe('playing');
    expect(s.round).toMatchObject({ number: 4, rotation: 1, state: 'card_selection' });
    expect(s.round.reader_id).toBe(t.ids[3]);
    expect(s.final_rotation).toBe(true);
    // last round of the rotation: nobody finds the genuine definition; each voter fools one other (+1), reader P4 gets the bonus (+3)
    ctx = await mk({ 0: LIE(1), 1: LIE(2), 2: LIE(0) });
    const results: any = await t.state(0);
    expect(results.round.is_final).toBe(true);
    expect((await t.state(3) as any).round.is_final).toBe(true);
    const ended: any = await advance(t, ctx);
    expect(ended.room.status).toBe('ended');
    expect(ended.round).toBeNull();
    expect(ended.final.winners).toEqual(['P4']);
    expect(Object.fromEntries(ended.standings.map((x: any) => [x.name, x.total]))).toEqual({ P1: 5, P2: 5, P3: 5, P4: 9 });
    expect(await roundCount(t)).toBe(4);
    // nothing more can happen to a finished game
    expect(await code(advance(t, ctx))).toBe('ok');
    expect(((await t.state(0)) as any).room.status).toBe('ended');
    expect(await roundCount(t)).toBe(4);
  });

  it('a target reached at no point goes on into another rotation; once reached the rotation in progress is the last', async () => {
    const t = await scoredTable(db, 3, { win_type: 'target', target: 5 });
    const { log, ended } = await run(t);
    // after round 3 everybody has 4; in rotation 2 (round 4) the target is reached
    expect(log.map((x) => x.rotation)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(log.map((x) => x.finalRotation)).toEqual([false, false, false, true, true, true]);
    expect(log.map((x) => x.isFinal)).toEqual([false, false, false, false, false, true]);
    expect(log.map((x) => x.reader)).toEqual([0, 1, 2, 0, 1, 2]);
    // everybody ends on 8: a three-way share
    expect(ended.final.winners).toEqual(['P1', 'P2', 'P3']);
    expect(ended.standings.map((x: any) => x.rank)).toEqual([1, 1, 1]);
  });
});

describe('playing a set number of rotations', () => {
  it('three players, two rotations: exactly six rounds', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 2 });
    const { log, ended } = await run(t);
    expect(log).toHaveLength(6);
    expect(log.map((x) => x.rotation)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(log.map((x) => x.reader)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(log.map((x) => x.isFinal)).toEqual([false, false, false, false, false, true]);
    expect(log.every((x) => x.finalRotation === false)).toBe(true); // only a target game has a "final rotation"
    expect(ended.room).toMatchObject({ win_type: 'rotations', rotation_limit: 2, status: 'ended' });
    expect(await roundCount(t)).toBe(6);
    expect(ended.completed_rounds).toBe(6);
  });

  it('four players, one rotation: exactly four rounds', async () => {
    const t = await scoredTable(db, 4, { win_type: 'rotations', rotations: 1 });
    const { log } = await run(t);
    expect(log.map((x) => x.reader)).toEqual([0, 1, 2, 3]);
    expect(log.map((x) => x.isFinal)).toEqual([false, false, false, true]);
    expect(await roundCount(t)).toBe(4);
  });

  it('a rotations room created without a number plays two', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations' });
    expect(((await t.state(0)) as any).room.rotation_limit).toBe(2);
    expect((await run(t)).log).toHaveLength(6);
  });
});

describe('playing without a limit', () => {
  it('goes on past any number of rotations until the host ends it', async () => {
    const t = await scoredTable(db, 3);
    let last: any;
    for (let r = 0; r < 7; r++) {
      const ctx = await quickRound(t);
      const res: any = await t.state(ctx.reader);
      expect(res.round.is_final, `round ${r + 1}`).toBe(false);
      expect(res.final_rotation).toBe(false);
      last = await advance(t, ctx);
      expect(last.room.status).toBe('playing');
    }
    expect(last.round).toMatchObject({ number: 8, rotation: 3 });
    expect(await code(t.as(1, 'end_game', { p_room_id: t.roomId }))).toBe('not_host');
    const ended: any = await t.as(0, 'end_game', { p_room_id: t.roomId });
    expect(ended.room.status).toBe('ended');
    expect(ended.final.winners.length).toBeGreaterThan(0);
    expect(ended.completed_rounds).toBe(7);
  });
});

describe('winners', () => {
  it('equal leaders share the win and the first rank', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    // round 1: P2 alone finds the genuine definition (P3 does not vote); then P1 and P3 do in round 2, P1 and P2 in round 3
    const plan: QuickOpts[] = [{ votes: { 1: TRUTH } }, {}, {}];
    const { ended } = await run(t, (r) => plan[r]);
    expect(ended.standings.map((x: any) => [x.name, x.total, x.rank])).toEqual([['P1', 4, 1], ['P2', 4, 1], ['P3', 2, 3]]);
    expect(ended.final.winners).toEqual(['P1', 'P2']);
  });

  it('a lone leader wins alone', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    const plan: QuickOpts[] = [{}, { votes: { 2: TRUTH } }, { votes: {} }];
    const { ended } = await run(t, (r) => plan[r]);
    expect(ended.standings.map((x: any) => [x.name, x.total, x.rank])).toEqual([['P3', 4, 1], ['P2', 2, 2], ['P1', 0, 3]]);
    expect(ended.final.winners).toEqual(['P3']);
  });
});

describe('players who join and leave', () => {
  it('a player who joins mid-rotation does not extend it, and first reads in the next one', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 2 });
    await beginRound(t);
    const late = await joinLate(t, 'Late');
    expect(((await t.state(late)) as any).round.eligible).toBe(false);
    const { log } = await run(t);
    expect(log.map((x) => x.reader)).toEqual([0, 1, 2, 0, 1, 2, late]);
    expect(log.map((x) => x.rotation)).toEqual([1, 1, 1, 2, 2, 2, 2]);
    expect(log.map((x) => x.isFinal)).toEqual([false, false, false, false, false, false, true]);
    const members = await db.admin(
      `select rotation, count(*)::int as n from public.rotation_members where room_id = $1 group by rotation order by rotation`,
      [t.roomId],
    );
    expect(members.map((m) => [m.rotation, m.n])).toEqual([[1, 3], [2, 4]]);
    // the newcomer played as a writer and voter from round 2 on
    expect(
      (await db.admin(`select count(*)::int as n from public.votes where voter_id = $1`, [t.ids[late]]))[0].n,
    ).toBe(5); // rounds 2-6 (round 7 they read)
  });

  it('with one rotation to play, a mid-rotation joiner never reads and does not add a round', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    await beginRound(t);
    await joinLate(t, 'Late');
    const { log } = await run(t);
    expect(log.map((x) => x.reader)).toEqual([0, 1, 2]);
    expect(await roundCount(t)).toBe(3);
  });

  it('a player due to read who leaves first is skipped, and the count stays right', async () => {
    const t = await scoredTable(db, 4, { win_type: 'rotations', rotations: 1 });
    const r1 = await quickRound(t);
    await t.as(2, 'leave_room', { p_room_id: t.roomId }); // P3 was due to read round 3
    expect(((await advance(t, r1)) as any).round.reader_id).toBe(t.ids[1]);
    const { log, ended } = await run(t); // plays round 2 onward
    expect(log.map((x) => x.reader)).toEqual([1, 3]);
    expect(log.map((x) => x.isFinal)).toEqual([false, true]);
    expect(await roundCount(t)).toBe(3);
    expect((await db.admin(`select number, reader_id from public.rounds where room_id = $1 order by number`, [t.roomId])).map((r) => r.reader_id)).toEqual([
      t.ids[0], t.ids[1], t.ids[3],
    ]);
    // the player who left kept the points they earned, and is listed with them
    expect(ended.standings.map((x: any) => x.name)).toContain('P3');
  });

  it('a player who leaves having scored nothing disappears from the standings', async () => {
    const t = await scoredTable(db, 4, { win_type: 'rotations', rotations: 1 });
    await t.as(3, 'leave_room', { p_room_id: t.roomId });
    const s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(s.standings.map((x: any) => x.name)).toEqual(['P1', 'P2', 'P3']);
  });
});

describe('awards', () => {
  it('are worked out from what happened, in the order of the brief, with ties and absent ones as stated', async () => {
    const t = await scoredTable(db, 4, { win_type: 'rotations', rotations: 1 });
    const plan: QuickOpts[] = [
      { votes: { 1: LIE(2), 2: TRUTH, 3: LIE(2) } }, // P1 reads: P3 fools P2 and P4 and finds the truth
      { votes: { 0: LIE(2), 2: LIE(3), 3: LIE(0) } }, // P2 reads: all wrong, reader bonus
      { accept: [1], votes: { 0: TRUTH, 3: LIE(0) } }, // P3 reads: P2's definition is accepted
      { votes: { 0: TRUTH, 1: TRUTH, 2: LIE(1) } }, // P4 reads
    ];
    const { ended } = await run(t, (r) => plan[r]);
    expect(Object.fromEntries(ended.standings.map((x: any) => [x.name, x.total]))).toEqual({ P1: 6, P2: 9, P3: 5, P4: 1 });
    expect(ended.final.winners).toEqual(['P2']);
    const awards = ended.final.awards;
    expect(awards.map((a: any) => a.key)).toEqual(['great_deceiver', 'lexicographer', 'master_reader', 'scholar', 'convincing_bluff']);
    const by = Object.fromEntries(awards.map((a: any) => [a.key, a]));
    expect(by.great_deceiver).toMatchObject({ count: 3, names: ['P3'] });
    expect(by.lexicographer).toMatchObject({ count: 2, names: ['P1'] });
    expect(by.master_reader).toMatchObject({ count: 1, names: ['P2'] });
    expect(by.scholar).toMatchObject({ count: 1, names: ['P2'] });
    expect(by.convincing_bluff).toMatchObject({ count: 2, bluffs: [{ name: 'P3', text: LIE(2) }] });
    // and each player's own statistics agree
    const p2: any = (await t.as(1, 'get_state', { p_room_id: t.roomId })).final!.my_stats;
    expect(p2).toMatchObject({ correct_guesses: 1, correct_written: 1, reader_rounds: 1, reader_bonuses: 1, votes_received: 1, incorrect_guesses: 1, abstentions: 0 });
    const p3: any = (await t.as(2, 'get_state', { p_room_id: t.roomId })).final!.my_stats;
    expect(p3).toMatchObject({ correct_guesses: 1, incorrect_guesses: 2, votes_received: 3, best_bluff_votes: 2 });
  });

  it('are left out when nobody earned them, and a tie lists every name', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    const { ended } = await run(t); // everybody always finds the genuine definition
    expect(ended.final.awards).toEqual([{ key: 'lexicographer', count: 2, names: ['P1', 'P2', 'P3'] }]);
  });

  it('a game where everyone is fooled in turn ties great_deceiver and master_reader three ways', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    const plan: QuickOpts[] = [{ votes: { 1: LIE(2), 2: LIE(1) } }, { votes: { 0: LIE(2), 2: LIE(0) } }, { votes: { 0: LIE(1), 1: LIE(0) } }];
    const { ended } = await run(t, (r) => plan[r]);
    expect(ended.final.winners).toEqual(['P1', 'P2', 'P3']);
    const by = Object.fromEntries(ended.final.awards.map((a: any) => [a.key, a]));
    expect(Object.keys(by).sort()).toEqual(['convincing_bluff', 'great_deceiver', 'master_reader']);
    expect(by.great_deceiver).toMatchObject({ count: 2, names: ['P1', 'P2', 'P3'] });
    expect(by.master_reader).toMatchObject({ count: 1, names: ['P1', 'P2', 'P3'] });
    expect(by.convincing_bluff.count).toBe(1);
    expect(by.convincing_bluff.bluffs).toHaveLength(6); // six false definitions drew one vote each
  });
});

describe('another game at the same table', () => {
  it('is only allowed once the game has ended', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(await code(t.as(0, 'play_again', { p_room_id: t.roomId }))).toBe('game_in_progress');
    const lobby = await scoredTable(db, 3);
    const same: any = await lobby.as(0, 'play_again', { p_room_id: lobby.roomId });
    expect(same.room).toMatchObject({ status: 'lobby', game_number: 1 }); // nothing to restart: no change
  });

  it('starts a clean second game with the same players and settings; the first game’s ledger does not count', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    const first = await run(t);
    expect(first.ended.room.game_number).toBe(1);
    const firstTotals = first.ended.standings.map((x: any) => x.total);
    expect(firstTotals.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0);

    const lobby: any = await t.as(0, 'play_again', { p_room_id: t.roomId });
    expect(lobby.room).toMatchObject({ status: 'lobby', game_number: 2, win_type: 'rotations', rotation_limit: 1, scoring: 'digital' });
    expect(lobby.round).toBeNull();
    expect(lobby.players.map((p: any) => p.id)).toEqual(t.ids);

    const s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(s.round).toMatchObject({ number: 1, rotation: 1, state: 'card_selection' });
    expect(s.round.reader_id).toBe(t.ids[0]);
    expect(s.standings.map((x: any) => x.player_id)).toEqual(t.ids);
    expect(s.standings.every((x: any) => x.total === 0 && x.rank === 1 && x.last === 0)).toBe(true);
    expect(s.completed_rounds).toBe(0);
    expect(s.final).toBeUndefined();
    expect(s.adjustments).toEqual([]);

    const ctx = await quickRound(t);
    const after: any = await t.state(0);
    expect(Object.fromEntries(after.standings.map((x: any) => [x.name, x.total]))).toEqual({ P1: 0, P2: 2, P3: 2 }); // not 4 + 2 or any carry-over
    expect(after.completed_rounds).toBe(1);

    // the old game's records are still there, under game 1
    const old = await db.admin(
      `select game_number, count(*)::int as n from public.score_events where room_id = $1 group by game_number order by game_number`,
      [t.roomId],
    );
    expect(old.map((r) => r.game_number)).toEqual([1, 2]);
    expect(old[0].n).toBeGreaterThan(0);
    const rounds = await db.admin(`select game_number, number from public.rounds where room_id = $1 order by game_number, number`, [t.roomId]);
    expect(rounds.filter((r) => r.game_number === 2).map((r) => r.number)).toEqual([1]);
    expect(rounds.filter((r) => r.game_number === 1).map((r) => r.number)).toEqual([1, 2, 3]);

    // and the second game runs to its own end after one more rotation
    await advance(t, ctx);
    const rest = await run(t);
    expect(rest.log).toHaveLength(2);
    expect(rest.ended.room.game_number).toBe(2);
    expect(await roundCount(t)).toBe(6);
    expect(
      (await db.admin(`select count(*)::int as n from public.rotation_members where room_id = $1 and game_number = 2`, [t.roomId]))[0].n,
    ).toBe(3);
  });
});

describe('changing the settings', () => {
  const setup = (t: Table, args: Record<string, unknown>) =>
    t.as<any>(0, 'update_settings', { p_room_id: t.roomId, p_mode: 'physical', p_scoring: 'digital', p_win_type: 'unlimited', ...args });

  it('the host can change them in the lobby, and only there', async () => {
    const t = await scoredTable(db, 3);
    let s = await setup(t, { p_win_type: 'target', p_target: 10 });
    expect(s.room).toMatchObject({ scoring: 'digital', win_type: 'target', target_score: 10, rotation_limit: null });
    s = await setup(t, { p_win_type: 'rotations', p_rotations: 3 });
    expect(s.room).toMatchObject({ win_type: 'rotations', target_score: null, rotation_limit: 3 });
    s = await setup(t, { p_win_type: 'target' });
    expect(s.room.target_score).toBe(25);
    s = await setup(t, { p_win_type: 'rotations' });
    expect(s.room.rotation_limit).toBe(2);
    s = await setup(t, { p_win_type: 'unlimited', p_target: 99, p_rotations: 9 });
    expect(s.room).toMatchObject({ win_type: 'unlimited', target_score: null, rotation_limit: null });

    expect(await code(t.as(1, 'update_settings', { p_room_id: t.roomId, p_mode: 'physical', p_scoring: 'digital', p_win_type: 'unlimited' }))).toBe('not_host');
    await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(await code(setup(t, {}))).toBe('game_already_started');
    expect(await code(t.as(1, 'update_settings', { p_room_id: t.roomId, p_mode: 'physical', p_scoring: 'digital', p_win_type: 'unlimited' }))).toBe('not_host');
  });

  it('refuses nonsense and leaves everything as it was', async () => {
    const t = await scoredTable(db, 3, { win_type: 'target', target: 30 });
    expect(await code(setup(t, { p_mode: 'digital', p_win_type: 'target', p_target: 4 }))).toBe('invalid_target');
    expect(await code(setup(t, { p_win_type: 'target', p_target: 1001 }))).toBe('invalid_target');
    expect(await code(setup(t, { p_win_type: 'rotations', p_rotations: 0 }))).toBe('invalid_rotations');
    expect(await code(setup(t, { p_win_type: 'rotations', p_rotations: 51 }))).toBe('invalid_rotations');
    expect(await code(setup(t, { p_win_type: 'forever' }))).toBe('invalid_win_type');
    expect(await code(setup(t, { p_scoring: 'maybe' }))).toBe('invalid_scoring');
    expect(await code(setup(t, { p_mode: 'telepathy' }))).toBe('invalid_mode');
    const s: any = await t.state(0);
    expect(s.room).toMatchObject({ mode: 'physical', scoring: 'digital', win_type: 'target', target_score: 30 });
    expect(await code(db.rpc(randomUUID(), 'create_room', { p_name: 'A', p_mode: 'physical', p_scoring: 'digital', p_win_type: 'target', p_target: 4 }))).toBe('invalid_target');
  });

  it('can be changed again between games', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    await run(t);
    expect(await code(setup(t, { p_win_type: 'unlimited' }))).toBe('game_already_started'); // still the finished game
    await t.as(0, 'play_again', { p_room_id: t.roomId });
    const s = await setup(t, { p_win_type: 'target', p_target: 5 });
    expect(s.room).toMatchObject({ win_type: 'target', target_score: 5, game_number: 2 });
  });
});

describe('traditional rooms', () => {
  it('keep the old flow: reading, reveal_answers, reveal, next_round; no voting and no standings', async () => {
    const t = await table(db, 3); // two-argument create_room
    const lobby: any = await t.state(0);
    expect(lobby.room).toMatchObject({ scoring: 'traditional', win_type: 'unlimited', target_score: null, rotation_limit: null, game_number: 1 });
    const { roundId, reader } = await toCollecting(t, 'quire', 'A set of paper sheets.');
    expect(reader).toBe(0);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'one' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'two' });
    let s: any = await t.as(0, 'reader_skip', { p_round_id: roundId });
    expect(s.round.state).toBe('reading'); // never 'adjudicating'
    expect(s.standings).toBeUndefined();
    expect(await code(t.as(0, 'open_voting', { p_round_id: roundId }))).toBe('not_digital_scoring');
    expect(await code(t.as(1, 'open_voting', { p_round_id: roundId }))).toBe('not_reader');
    expect(await code(t.as(1, 'cast_vote', { p_round_id: roundId, p_definition_id: s.round.definitions[0].id }))).toBe('voting_closed');
    expect(await code(t.as(0, 'reveal_step', { p_round_id: roundId, p_definition_id: s.round.definitions[0].id }))).toBe('not_digital_scoring');
    expect(await code(t.as(0, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[1], p_points: 1, p_note: 'x' }))).toBe('no_scores_to_adjust');
    s = await t.as(0, 'reveal_answers', { p_round_id: roundId });
    expect(s.round.state).toBe('reveal');
    expect(s.round.definitions.map((d: any) => d.is_correct).sort()).toEqual([false, false, true]);
    expect(s.standings).toBeUndefined();
    expect(await db.admin(`select 1 from public.score_events where room_id = $1`, [t.roomId])).toEqual([]);
    s = await t.as(0, 'next_round', { p_round_id: roundId });
    expect(s.round).toMatchObject({ number: 2, state: 'card_selection' });
    expect(s.round.reader_id).toBe(t.ids[1]);
  });

  it('a traditional room asked for a target score plays without a limit', async () => {
    const r: any = await db.rpc(randomUUID(), 'create_room', {
      p_name: 'H', p_mode: 'physical', p_scoring: 'traditional', p_win_type: 'target', p_target: 30,
    });
    const room = (await db.admin(`select scoring, win_type, target_score, rotation_limit from public.rooms where id = $1`, [r.room_id]))[0];
    expect(room).toEqual({ scoring: 'traditional', win_type: 'unlimited', target_score: null, rotation_limit: null });
    // the same through update_settings
    const t = await table(db, 3);
    const s: any = await t.as(0, 'update_settings', {
      p_room_id: t.roomId, p_mode: 'physical', p_scoring: 'traditional', p_win_type: 'target', p_target: 40,
    });
    expect(s.room).toMatchObject({ scoring: 'traditional', win_type: 'unlimited', target_score: null });
    // switching the same room to digital scoring keeps a real target
    const d: any = await t.as(0, 'update_settings', {
      p_room_id: t.roomId, p_mode: 'physical', p_scoring: 'digital', p_win_type: 'target', p_target: 40,
    });
    expect(d.room).toMatchObject({ scoring: 'digital', win_type: 'target', target_score: 40 });
  });
});

describe('ending a game early', () => {
  it('ending before any round is settled declares no winner and no awards', async () => {
    const t = await scoredTable(db, 3);
    await beginRound(t);
    const ended: any = await t.as(0, 'end_game', { p_room_id: t.roomId });
    expect(ended.room.status).toBe('ended');
    expect(ended.final.winners).toEqual([]);
    expect(ended.final.awards).toEqual([]);
    expect(ended.completed_rounds).toBe(0);
  });
});
