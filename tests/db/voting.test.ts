// Who may vote, how a ballot behaves, and when voting closes.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TRUTH, LIE, advance, castVotes, code, joinLate, newDb, openVoting, prepareReading, quickRound, scoredTable, settle, vote,
  type TestDb,
} from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

const votesIn = (roundId: string) =>
  db.admin(`select voter_id, definition_id from public.votes where round_id = $1`, [roundId]);

describe('who may vote', () => {
  it('every non-reader player can vote, and sees their own choice', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    const open = await openVoting(t, ctx);
    expect(open.round.state).toBe('voting');
    expect(open.round.voters_total).toBe(3);
    for (const i of [1, 2, 3]) {
      const s: any = await t.state(i);
      expect(s.round.can_vote).toBe(true);
      expect(s.round.my_vote).toBeNull();
    }
    const s: any = await vote(t, ctx, 1, TRUTH);
    expect(s.round.my_vote).toBe(ctx.defs[TRUTH]);
    expect(s.round.votes_cast).toBe(1);
    expect(((await t.state(2)) as any).round.my_vote).toBeNull();
  });

  it('the reader cannot vote', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    const open = await openVoting(t, ctx);
    expect(open.round.can_vote).toBe(false);
    expect(await code(vote(t, ctx, ctx.reader, TRUTH))).toBe('not_eligible_to_vote');
    expect(await votesIn(ctx.roundId)).toEqual([]);
  });

  it('nobody can vote for their own definition, but may vote for anyone else’s', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    expect(await code(vote(t, ctx, 1, LIE(1)))).toBe('own_definition');
    expect(await code(vote(t, ctx, 2, LIE(2)))).toBe('own_definition');
    expect(await votesIn(ctx.roundId)).toEqual([]);
    expect(await code(vote(t, ctx, 1, LIE(2)))).toBe('ok');
  });

  it('a writer whose definition was accepted as correct cannot vote and is not on any ballot', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t, { accept: [1] });
    // the accepted text is out of the shuffle already, while still reading
    expect(Object.keys(ctx.defs).sort()).toEqual([TRUTH, LIE(2), LIE(3), LIE(4)].sort());
    const open = await openVoting(t, ctx);
    expect(open.round.voters_total).toBe(3);
    const accepted: any = await t.state(1);
    expect(accepted.round.can_vote).toBe(false);
    expect(await code(t.as(1, 'cast_vote', { p_round_id: ctx.roundId, p_definition_id: ctx.defs[TRUTH] }))).toBe(
      'not_eligible_to_vote',
    );
    for (const i of [0, 2, 3, 4]) {
      const s: any = await t.state(i);
      expect(JSON.stringify(s.round.definitions ?? []), `player ${i}`).not.toContain(LIE(1));
    }
    // the others carry on voting normally
    for (const i of [2, 3, 4]) expect(await code(vote(t, ctx, i, TRUTH))).toBe('ok');
    expect(((await t.state(0)) as any).round.state).toBe('voting_closed');
  });

  it('a player who joins mid-round cannot vote', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    const late = await joinLate(t, 'Late');
    await openVoting(t, ctx);
    const s: any = await t.state(late);
    expect(s.round.can_vote).toBe(false);
    expect(s.round.eligible).toBe(false);
    expect(await code(vote(t, ctx, late, TRUTH))).toBe('not_eligible_to_vote');
    // nor one who joins once voting is already open
    const later = await joinLate(t, 'Later');
    expect(await code(vote(t, ctx, later, TRUTH))).toBe('not_eligible_to_vote');
    expect(((await t.state(0)) as any).round.voters_total).toBe(3);
  });
});

describe('the ballot', () => {
  it('can be changed before voting closes, and there is still exactly one row per voter', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, LIE(2));
    let s: any = await vote(t, ctx, 1, LIE(3));
    expect(s.round.my_vote).toBe(ctx.defs[LIE(3)]);
    s = await vote(t, ctx, 1, TRUTH);
    expect(s.round.my_vote).toBe(ctx.defs[TRUTH]);
    expect(s.round.votes_cast).toBe(1);
    const rows = await votesIn(ctx.roundId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ voter_id: t.ids[1], definition_id: ctx.defs[TRUTH] });
    // voting for the same thing twice changes nothing
    await vote(t, ctx, 1, TRUTH);
    expect(await votesIn(ctx.roundId)).toHaveLength(1);
  });

  it('closes by itself when every eligible voter has voted, without revealing anything', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, TRUTH);
    await vote(t, ctx, 2, LIE(3));
    expect(((await t.state(0)) as any).round.state).toBe('voting');
    const s: any = await vote(t, ctx, 3, LIE(1));
    expect(s.round.state).toBe('voting_closed'); // not 'reveal' / 'results'
    expect(s.round.votes_cast).toBe(3);
    expect(s.round.voters_total).toBe(3);
    const reader: any = await t.state(0);
    expect(reader.round.state).toBe('voting_closed');
    expect(reader.completed_rounds).toBe(0);
    expect(reader.standings.every((x: any) => x.total === 0)).toBe(true);
    expect(await db.admin(`select 1 from public.score_events where round_id = $1`, [ctx.roundId])).toHaveLength(0);
    const rd = await db.admin(`select settled_at from public.rounds where id = $1`, [ctx.roundId]);
    expect(rd[0].settled_at).toBeNull();
    // and once closed, a ballot cannot be changed
    expect(await code(vote(t, ctx, 1, LIE(2)))).toBe('voting_closed');
  });

  it('can be closed by the reader with ballots missing; the missing voters are recorded as abstentions', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, TRUTH);
    await vote(t, ctx, 2, LIE(3));
    const closed: any = await t.as(ctx.reader, 'close_voting', { p_round_id: ctx.roundId });
    expect(closed.round.state).toBe('voting_closed');
    expect(closed.round.votes_cast).toBe(2);
    expect(closed.round.voters_total).toBe(4);
    // a late ballot is turned away and nothing is stored
    expect(await code(vote(t, ctx, 3, TRUTH))).toBe('voting_closed');
    expect(await votesIn(ctx.roundId)).toHaveLength(2);
    const results = await settle(t, ctx);
    expect(results.round.state).toBe('results');
    expect(results.round.abstained).toEqual(['P4', 'P5']);
  });

  it('is the same list, in the same order, for the reader and for every voter, and stays stable', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t, { readerWrites: 'lie of the reader' });
    await openVoting(t, ctx);
    const strip = (defs: any[]) => defs.map((d) => ({ id: d.id, position: d.position, text: d.text }));
    const readerView = strip(((await t.state(0)) as any).round.definitions);
    expect(readerView).toHaveLength(6); // genuine + 4 writers + the reader's own
    expect(readerView.map((d) => d.position)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const i of [1, 2, 3, 4]) {
      const first = strip(((await t.state(i)) as any).round.definitions);
      expect(first, `player ${i}`).toEqual(readerView);
      for (let k = 0; k < 3; k++) expect(strip(((await t.state(i)) as any).round.definitions)).toEqual(readerView);
    }
    // still the same after somebody votes and after voting closes
    await vote(t, ctx, 1, TRUTH);
    expect(strip(((await t.state(0)) as any).round.definitions)).toEqual(readerView);
  });

  it('marks only the caller’s own definition with `mine`', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    for (const i of [1, 2, 3, 4]) {
      const defs = ((await t.state(i)) as any).round.definitions as any[];
      const mine = defs.filter((d) => d.mine);
      expect(mine.map((d) => d.text), `player ${i}`).toEqual([LIE(i)]);
      expect(mine[0].mine).toBe(true);
    }
    const readerDefs = ((await t.state(0)) as any).round.definitions as any[];
    expect(readerDefs.some((d) => 'mine' in d)).toBe(false);
  });

  it('does not open by itself once every definition is in: the round waits in `reading`', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    for (let k = 0; k < 2; k++) {
      for (const i of [0, 1, 2, 3]) expect(((await t.state(i)) as any).round.state).toBe('reading');
    }
    expect(await code(vote(t, ctx, 1, TRUTH))).toBe('voting_closed');
    expect(await db.admin(`select 1 from public.round_voters where round_id = $1`, [ctx.roundId])).toHaveLength(0);
    await openVoting(t, ctx);
    expect(((await t.state(1)) as any).round.state).toBe('voting');
    // opening again is harmless
    const again: any = await t.as(ctx.reader, 'open_voting', { p_round_id: ctx.roundId });
    expect(again.round.state).toBe('voting');
    expect(again.round.voters_total).toBe(3);
  });

  it('rejects a definition from another round, another room, or nowhere: invalid_definition_id', async () => {
    const t = await scoredTable(db, 4);
    const other = await scoredTable(db, 4);
    const oldRound = await quickRound(t);
    await advance(t, oldRound);
    const otherCtx = await prepareReading(other);
    await openVoting(other, otherCtx);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    const voter = ctx.reader === 1 ? 2 : 1;
    const call = (id: string) => t.as(voter, 'cast_vote', { p_round_id: ctx.roundId, p_definition_id: id });
    expect(await code(call(oldRound.defs[TRUTH]))).toBe('invalid_definition_id'); // earlier round, same room
    expect(await code(call(otherCtx.defs[TRUTH]))).toBe('invalid_definition_id'); // another room
    expect(await code(call(randomUUID()))).toBe('invalid_definition_id');
    expect(await votesIn(ctx.roundId)).toEqual([]);
    expect(await code(call(ctx.defs[TRUTH]))).toBe('ok');
  });
});

describe('voters who go away or change', () => {
  it('a voter who leaves does not block the automatic close (before or after the others vote)', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, TRUTH);
    await t.as(4, 'leave_room', { p_room_id: t.roomId });
    await vote(t, ctx, 2, LIE(3));
    expect(((await t.state(0)) as any).round.state).toBe('voting');
    const s: any = await vote(t, ctx, 3, TRUTH);
    expect(s.round.state).toBe('voting_closed');
    expect(s.round.votes_cast).toBe(3);

    // leaving last: the others have all voted already, the leave itself closes voting
    const t2 = await scoredTable(db, 5);
    const c2 = await prepareReading(t2);
    await openVoting(t2, c2);
    for (const i of [1, 2, 3]) await vote(t2, c2, i, TRUTH);
    expect(((await t2.state(0)) as any).round.state).toBe('voting');
    await t2.as(4, 'leave_room', { p_room_id: t2.roomId });
    expect(((await t2.state(0)) as any).round.state).toBe('voting_closed');
  });

  // Not stated in the brief, but a ballot count of '3 of 4' after the fourth has left is odd.
  it('a voter who has left is no longer counted in voters_total', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await t.as(4, 'leave_room', { p_room_id: t.roomId });
    expect(((await t.state(0)) as any).round.voters_total).toBe(3);
  });

  it('a voter removed by the host does not block the close either', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, TRUTH);
    await vote(t, ctx, 2, LIE(1));
    const s: any = await t.as(0, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[3] });
    expect(s.round.state).toBe('voting_closed');
  });

  it('when the host swaps the reader mid-vote the new reader loses their ballot and the old reader cannot vote', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, TRUTH);
    await vote(t, ctx, 2, LIE(3)); // P3's ballot, for P4's definition
    await vote(t, ctx, 3, LIE(4)); // P4's ballot, cast before P4 becomes the reader
    expect(await votesIn(ctx.roundId)).toHaveLength(3);

    const s: any = await t.as(0, 'set_reader', { p_room_id: t.roomId, p_player_id: t.ids[3] });
    expect(s.round.reader_id).toBe(t.ids[3]);
    expect(s.round.state).toBe('voting');
    const rows = await votesIn(ctx.roundId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.voter_id)).not.toContain(t.ids[3]);
    expect(await db.admin(`select 1 from public.round_voters where round_id = $1 and player_id = $2`, [ctx.roundId, t.ids[3]])).toHaveLength(0);

    // the new reader sees the voters (no longer including themselves) and cannot vote
    const newReader: any = await t.state(3);
    expect(newReader.round.can_vote).toBe(false);
    expect(newReader.round.voters.map((v: any) => v.name).sort()).toEqual(['P2', 'P3', 'P5']);
    expect(await code(vote(t, ctx, 3, TRUTH))).toBe('not_eligible_to_vote');
    // the old reader may not vote either
    expect(await code(vote(t, ctx, 0, TRUTH))).toBe('not_eligible_to_vote');
    expect(((await t.state(0)) as any).round.can_vote).toBe(false);
    // the remaining voter (P5) finishes the round off
    expect(((await t.state(0)) as any).round.state).toBe('voting');
    const done: any = await vote(t, ctx, 4, TRUTH);
    expect(done.round.state).toBe('voting_closed');
    expect(done.round.votes_cast).toBe(3);
  });
});

describe('when there is nobody to vote', () => {
  it('goes straight to voting_closed, and the round can still be revealed and the game moved on', async () => {
    const t = await scoredTable(db, 3, { names: ['Reader', 'Ann', 'Bob'] });
    const ctx = await prepareReading(t, { accept: [1, 2] });
    expect(Object.keys(ctx.defs)).toEqual([TRUTH]); // only the genuine definition is left
    const open = await openVoting(t, ctx);
    expect(open.round.state).toBe('voting_closed');
    expect(open.round.voters_total).toBe(0);
    expect(open.round.votes_cast).toBe(0);
    expect(await code(vote(t, ctx, 1, TRUTH))).toBe('voting_closed');
    const results = await settle(t, ctx);
    expect(results.round.state).toBe('results');
    expect(results.standings.map((s: any) => [s.name, s.total]).sort()).toEqual([['Ann', 3], ['Bob', 3], ['Reader', 0]]);
    expect(results.round.reader_bonus).toBe(false);
    const next: any = await advance(t, ctx);
    expect(next.round.number).toBe(2);
    expect(next.round.state).toBe('card_selection');
  });

  it('nobody writing anything leaves just the genuine definition, and the others can still vote for it', async () => {
    const t = await scoredTable(db, 3);
    const ctx = await prepareReading(t, { skip: [1, 2] });
    expect(Object.keys(ctx.defs)).toEqual([TRUTH]);
    const open = await openVoting(t, ctx);
    expect(open.round.voters_total).toBe(2);
    await castVotes(t, ctx, { 1: TRUTH, 2: TRUTH });
    const r = await settle(t, ctx);
    expect(r.round.my_result.round_points).toBe(0); // the reader earns nothing for that
    expect(r.standings.map((s: any) => s.total).sort()).toEqual([0, 2, 2]);
  });
});

describe('further edge cases', () => {
  it('limits how fast a ballot can be changed (60 a minute), and the ballot survives intact', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await db.admin('delete from public.rate_limits');
    for (let k = 0; k < 60; k++) await vote(t, ctx, 1, k % 2 ? LIE(2) : LIE(3));
    expect(await code(vote(t, ctx, 1, TRUTH))).toBe('rate_limited');
    const rows = await votesIn(ctx.roundId);
    expect(rows).toHaveLength(1);
    expect(rows[0].definition_id).toBe(ctx.defs[LIE(2)]); // the 60th change stands
  });

  it('a reader replaced before voting opens is not a voter, nor is the new reader', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    const s: any = await t.as(0, 'set_reader', { p_room_id: t.roomId, p_player_id: t.ids[2] });
    expect(s.round.reader_id).toBe(t.ids[2]);
    expect(s.round.state).toBe('reading');
    const open: any = await t.as(2, 'open_voting', { p_round_id: ctx.roundId });
    expect(open.round.voters_total).toBe(3);
    expect(open.round.voters.map((v: any) => v.name)).toEqual(['P2', 'P4', 'P5']);
    expect(await code(vote(t, ctx, 0, TRUTH))).toBe('not_eligible_to_vote'); // the old reader
    expect(await code(vote(t, ctx, 2, TRUTH))).toBe('not_eligible_to_vote'); // the new reader
    // the old reader's own written definition is not an issue: they wrote none here
    for (const i of [1, 3, 4]) expect(await code(vote(t, ctx, i, TRUTH))).toBe('ok');
    expect(((await t.state(2)) as any).round.state).toBe('voting_closed');
  });

  it('a reader who leaves during voting hands the role on; the new reader loses their ballot and voting still closes', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await vote(t, ctx, 1, TRUTH); // P2: next in turn, will take over
    await vote(t, ctx, 2, LIE(1));
    await t.as(0, 'leave_room', { p_room_id: t.roomId });
    const s: any = await t.state(1);
    expect(s.round.reader_id).toBe(t.ids[1]);
    expect(s.round.can_vote).toBe(false);
    expect((await votesIn(ctx.roundId)).map((r) => r.voter_id)).toEqual([t.ids[2]]);
    await vote(t, ctx, 3, TRUTH);
    const done: any = await vote(t, ctx, 4, TRUTH);
    expect(done.round.state).toBe('voting_closed');
  });

  it('reveal_step with a definition from elsewhere is refused and changes nothing', async () => {
    const t = await scoredTable(db, 4);
    const other = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await castVotes(t, ctx, { 1: TRUTH, 2: TRUTH, 3: TRUTH });
    const o = await prepareReading(other);
    expect(await code(t.as(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: o.defs[TRUTH] }))).toBe('invalid_definition_id');
    expect(await code(t.as(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: randomUUID() }))).toBe('invalid_definition_id');
    expect(((await t.state(0)) as any).round.state).toBe('voting_closed');
  });
});
