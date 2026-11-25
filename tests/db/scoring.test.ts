// What each round is worth, and that it is worth that exactly once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIE, TRUTH, advance, castVotes, code, ledger, newDb, openVoting, prepareReading, quickRound, scoredTable, settle, totals,
  type RoundCtx, type Table, type TestDb,
} from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

const events = (roundId: string) =>
  db.admin(
    `select category, points, player_id, idem_key from public.score_events where round_id = $1 order by idem_key`,
    [roundId],
  );
const categories = async (roundId: string) => (await events(roundId)).map((e) => e.category).sort();
const sorted = (xs: any[]) => [...xs].sort();

/** player i's my_result items as [category, points, voters sorted] */
async function items(t: Table, i: number) {
  const r = ((await t.state(i)) as any).round.my_result;
  return r.items.map((x: any) => [x.category, x.points, x.voters ? sorted(x.voters) : null]);
}

describe('the four worked examples', () => {
  it('A: six players; guesses and deceptions add up (Daniel 3, Sarah 0, Matthew 4, Elizabeth 0, James 0, Reader 0)', async () => {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Daniel', 'Sarah', 'Matthew', 'Elizabeth', 'James'] });
    const ctx = await quickRound(t, {
      votes: { 1: TRUTH, 3: TRUTH, 2: LIE(3), 4: LIE(3), 5: LIE(1) }, // Daniel, Matthew right; Sarah+Elizabeth -> Matthew's; James -> Daniel's
    });
    const snap: any = await t.state(0);
    expect(snap.round.state).toBe('results');
    expect(totals(snap)).toEqual({ Reader: 0, Daniel: 3, Sarah: 0, Matthew: 4, Elizabeth: 0, James: 0 });
    expect(snap.round.reader_bonus).toBe(false);
    expect(await categories(ctx.roundId)).toEqual(
      ['CORRECT_GUESS', 'CORRECT_GUESS', 'SUCCESSFUL_DECEPTION', 'SUCCESSFUL_DECEPTION', 'SUCCESSFUL_DECEPTION'],
    );
    // each player's own breakdown says the same
    expect(await items(t, 1)).toEqual([['CORRECT_GUESS', 2, null], ['SUCCESSFUL_DECEPTION', 1, ['James']]]);
    expect(await items(t, 3)).toEqual([['CORRECT_GUESS', 2, null], ['SUCCESSFUL_DECEPTION', 2, ['Elizabeth', 'Sarah']]]);
    expect(await items(t, 2)).toEqual([]);
    const sarah: any = await t.state(2);
    expect(sarah.round.my_result).toMatchObject({ round_points: 0, previous: 0, total: 0 });
    const matthew: any = await t.state(3);
    expect(matthew.round.my_result).toMatchObject({ round_points: 4, previous: 0, total: 4 });
  });

  it('B: five voters, none right, three fooled by the reader and two by Sarah: reader 6 (3 + bonus 3), Sarah 2', async () => {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Sarah', 'Ann', 'Ben', 'Cat', 'Dan'] });
    const ctx = await quickRound(t, {
      readerWrites: 'the reader’s false definition',
      votes: {
        1: 'the reader’s false definition', // Sarah
        2: LIE(1), // Ann -> Sarah
        3: LIE(1), // Ben -> Sarah
        4: 'the reader’s false definition', // Cat
        5: 'the reader’s false definition', // Dan
      },
    });
    const snap: any = await t.state(0);
    expect(totals(snap)).toEqual({ Reader: 6, Sarah: 2, Ann: 0, Ben: 0, Cat: 0, Dan: 0 });
    expect(snap.round.reader_bonus).toBe(true);
    expect(await items(t, 0)).toEqual([['SUCCESSFUL_DECEPTION', 3, ['Cat', 'Dan', 'Sarah']], ['READER_BONUS', 3, null]]);
    expect(await items(t, 1)).toEqual([['SUCCESSFUL_DECEPTION', 2, ['Ann', 'Ben']]]);
    expect(await categories(ctx.roundId)).toEqual(
      Array(5).fill('SUCCESSFUL_DECEPTION').concat('READER_BONUS').sort(),
    );
    // the ballot marked the reader's definition as the reader's
    const defs = ((await t.state(3)) as any).round.definitions as any[];
    expect(defs.find((d) => d.text === 'the reader’s false definition')).toMatchObject({ by_reader: true, is_correct: false });
  });

  it('C: Sarah’s written definition is accepted: Sarah 3, she does not vote, her text is not on the ballot, no reader bonus', async () => {
    const t = await scoredTable(db, 5, { names: ['Reader', 'Sarah', 'Xavier', 'Yolanda', 'Zed'] });
    const ctx = await prepareReading(t, { accept: [1] });
    const open = await openVoting(t, ctx);
    expect(Object.keys(ctx.defs)).not.toContain(LIE(1));
    expect(open.round.voters_total).toBe(3);
    expect(((await t.state(1)) as any).round.can_vote).toBe(false);
    await castVotes(t, ctx, { 2: LIE(3), 3: LIE(4), 4: LIE(2) }); // everyone left to vote is wrong
    const snap = await settle(t, ctx);
    expect(totals(snap)).toEqual({ Reader: 0, Sarah: 3, Xavier: 1, Yolanda: 1, Zed: 1 });
    expect(snap.round.reader_bonus).toBe(false);
    expect(snap.round.written_correct).toEqual([{ name: 'Sarah', text: LIE(1) }]);
    expect(await items(t, 1)).toEqual([['CORRECT_WRITTEN_DEFINITION', 3, null]]);
    expect(await categories(ctx.roundId)).toEqual(
      ['CORRECT_WRITTEN_DEFINITION', 'SUCCESSFUL_DECEPTION', 'SUCCESSFUL_DECEPTION', 'SUCCESSFUL_DECEPTION'],
    );
    // the same everyone-wrong round without the accepted definition does pay the bonus
    const t2 = await scoredTable(db, 5, { names: ['Reader', 'Sarah', 'Xavier', 'Yolanda', 'Zed'] });
    await quickRound(t2, { votes: { 1: LIE(2), 2: LIE(3), 3: LIE(4), 4: LIE(1) } });
    expect(totals((await t2.state(0)) as any).Reader).toBe(3);
  });

  it('D: right themselves, and four others fall for their false definition: 2 + 4 = 6', async () => {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Hero', 'V1', 'V2', 'V3', 'V4'] });
    await quickRound(t, { votes: { 1: TRUTH, 2: LIE(1), 3: LIE(1), 4: LIE(1), 5: LIE(1) } });
    const snap: any = await t.state(0);
    expect(totals(snap)).toEqual({ Reader: 0, Hero: 6, V1: 0, V2: 0, V3: 0, V4: 0 });
    expect(await items(t, 1)).toEqual([['CORRECT_GUESS', 2, null], ['SUCCESSFUL_DECEPTION', 4, ['V1', 'V2', 'V3', 'V4']]]);
    expect(((await t.state(1)) as any).round.my_result).toMatchObject({ round_points: 6, previous: 0, total: 6 });
  });
});

describe('the reader bonus', () => {
  it('is not paid when any eligible voter abstains', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await quickRound(t, { votes: { 1: LIE(2), 2: LIE(3), 3: LIE(1) } }); // P5 never votes
    const snap: any = await t.state(0);
    expect(snap.round.abstained).toEqual(['P5']);
    expect(snap.round.reader_bonus).toBe(false);
    expect(totals(snap).P1).toBe(0);
    expect((await events(ctx.roundId)).map((e) => e.category)).not.toContain('READER_BONUS');
  });

  it('is not paid when nobody votes at all', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await quickRound(t, { votes: {} });
    const snap: any = await t.state(0);
    expect(snap.round.abstained).toEqual(['P2', 'P3', 'P4']);
    expect(await events(ctx.roundId)).toEqual([]);
    expect(Object.values(totals(snap))).toEqual([0, 0, 0, 0]);
  });

  it('is not paid when a single voter found the genuine definition', async () => {
    const t = await scoredTable(db, 4);
    await quickRound(t, { votes: { 1: TRUTH, 2: LIE(3), 3: LIE(1) } });
    expect(totals((await t.state(0)) as any)).toEqual({ P1: 0, P2: 3, P3: 0, P4: 1 });
  });
});

describe('accumulating and separating points', () => {
  it('points from different categories, and from different rounds, add up', async () => {
    const t = await scoredTable(db, 5);
    // round 1 (P1 reads): P2 is accepted as correct (+3); P3 and P4 each vote P5's lie; P5 votes the truth.
    const r1 = await quickRound(t, { accept: [1], votes: { 2: LIE(4), 3: LIE(4), 4: TRUTH } });
    expect(totals((await t.state(0)) as any)).toEqual({ P1: 0, P2: 3, P3: 0, P4: 0, P5: 4 });
    await advance(t, r1);
    // round 2 (P2 reads): P1 and P5 vote the truth; P3 votes P4's lie, P4 votes P5's lie
    await quickRound(t, { votes: { 0: TRUTH, 4: TRUTH, 2: LIE(3), 3: LIE(4) } });
    const snap: any = await t.state(1);
    expect(totals(snap)).toEqual({ P1: 2, P2: 3, P3: 0, P4: 1, P5: 4 + 2 + 1 });
    const p5: any = await t.state(4);
    expect(p5.round.my_result).toMatchObject({ round_points: 3, previous: 4, total: 7 });
    expect(await items(t, 4)).toEqual([['CORRECT_GUESS', 2, null], ['SUCCESSFUL_DECEPTION', 1, ['P4']]]);
  });

  it('two players who write the same false text are scored separately, per definition', async () => {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Twin1', 'Twin2', 'V1', 'V2', 'V3'] });
    const ctx = await prepareReading(t, { lies: { 1: 'the very same lie', 2: 'the very same lie' } });
    const open = await openVoting(t, ctx);
    const twins = open.round.definitions.filter((d: any) => d.text === 'the very same lie');
    expect(twins).toHaveLength(2);
    expect(twins[0].id).not.toBe(twins[1].id);
    const author = async (id: string) =>
      (await db.admin(`select author_player_id from public.shuffled_private where definition_id = $1`, [id]))[0].author_player_id;
    const [a, b] = [await author(twins[0].id), await author(twins[1].id)];
    expect(sorted([a, b])).toEqual(sorted([t.ids[1], t.ids[2]]));
    const say = (voter: number, defId: string) => t.as(voter, 'cast_vote', { p_round_id: ctx.roundId, p_definition_id: defId });
    await say(3, twins[0].id);
    await say(4, twins[0].id);
    await say(5, twins[1].id);
    await settle(t, ctx);
    const snap: any = await t.state(0);
    const byId = Object.fromEntries(snap.standings.map((s: any) => [s.player_id, s.total]));
    expect(byId[a]).toBe(2);
    expect(byId[b]).toBe(1);
    const sd = await db.admin(
      `select player_id, count(*)::int as n from public.score_events where round_id = $1 and category = 'SUCCESSFUL_DECEPTION' group by player_id`,
      [ctx.roundId],
    );
    expect(Object.fromEntries(sd.map((r) => [r.player_id, r.n]))).toEqual({ [a]: 2, [b]: 1 });
  });
});

describe('settlement happens once', () => {
  async function scenarioA() {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Daniel', 'Sarah', 'Matthew', 'Elizabeth', 'James'] });
    const ctx = await quickRound(t, { votes: { 1: TRUTH, 3: TRUTH, 2: LIE(3), 4: LIE(3), 5: LIE(1) } });
    return { t, ctx };
  }
  const settledAt = async (id: string) => (await db.admin(`select settled_at from public.rounds where id = $1`, [id]))[0].settled_at;

  it('repeating reveal_answers, reveal_step or the settlement itself changes nothing', async () => {
    const { t, ctx } = await scenarioA();
    const before = await events(ctx.roundId);
    const stamp = await settledAt(ctx.roundId);
    expect(before).toHaveLength(5);
    for (let k = 0; k < 3; k++) {
      await t.as(0, 'reveal_answers', { p_round_id: ctx.roundId });
      await t.as(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ctx.defs[TRUTH] });
      await db.admin(`select private.settle_round($1)`, [ctx.roundId]);
    }
    expect(await events(ctx.roundId)).toEqual(before);
    expect(await settledAt(ctx.roundId)).toEqual(stamp);
    expect(totals((await t.state(0)) as any)).toEqual({ Reader: 0, Daniel: 3, Sarah: 0, Matthew: 4, Elizabeth: 0, James: 0 });
  });

  it('settling again after the flags are wound back (as after a crash) adds nothing twice', async () => {
    const { t, ctx } = await scenarioA();
    const before = await events(ctx.roundId);
    await db.admin(`update public.rounds set settled_at = null, state = 'reveal' where id = $1`, [ctx.roundId]);
    await t.as(0, 'reveal_answers', { p_round_id: ctx.roundId });
    expect(await events(ctx.roundId)).toEqual(before);
    expect(((await t.state(0)) as any).round.state).toBe('results');
    expect(totals((await t.state(0)) as any).Matthew).toBe(4);
  });

  it('a settlement interrupted part-way can be retried: missing events return, none duplicate', async () => {
    const { t, ctx } = await scenarioA();
    const before = await events(ctx.roundId);
    // keep two events, lose the other three, and mark the round as not settled
    await db.admin(
      `delete from public.score_events where round_id = $1
          and id not in (select id from public.score_events where round_id = $1 order by idem_key limit 2)`,
      [ctx.roundId],
    );
    await db.admin(`update public.rounds set settled_at = null, state = 'reveal' where id = $1`, [ctx.roundId]);
    expect(await events(ctx.roundId)).toHaveLength(2);
    const snap: any = await t.as(0, 'reveal_answers', { p_round_id: ctx.roundId });
    expect(snap.round.state).toBe('results');
    expect(await events(ctx.roundId)).toEqual(before);
    expect(totals(snap)).toEqual({ Reader: 0, Daniel: 3, Sarah: 0, Matthew: 4, Elizabeth: 0, James: 0 });

    // and with every event lost, and the retry done through the staged reveal this time
    await db.admin(`delete from public.score_events where round_id = $1`, [ctx.roundId]);
    await db.admin(`update public.rounds set settled_at = null, state = 'reveal' where id = $1`, [ctx.roundId]);
    await db.admin(`update public.shuffled_definitions set reveal_stage = 1 where id = $1`, [ctx.defs[TRUTH]]);
    const again: any = await t.as(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ctx.defs[TRUTH] });
    expect(again.round.state).toBe('results');
    expect(await events(ctx.roundId)).toEqual(before);
    expect(totals(again).Daniel).toBe(3);
  });

  it('a staged reveal settles when the last definition is fully revealed, and not before', async () => {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Daniel', 'Sarah', 'Matthew', 'Elizabeth', 'James'] });
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await castVotes(t, ctx, { 1: TRUTH, 3: TRUTH, 2: LIE(3), 4: LIE(3), 5: LIE(1) });
    expect(((await t.state(0)) as any).round.state).toBe('voting_closed');
    const ids = Object.values(ctx.defs);
    expect(ids).toHaveLength(6);
    const step = (id: string) => t.as<any>(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: id });
    for (let k = 0; k < ids.length; k++) {
      let s = await step(ids[k]);
      expect(s.round.state).toBe('reveal');
      expect(s.round.definitions.find((d: any) => d.id === ids[k]).stage).toBe(1);
      expect(await events(ctx.roundId)).toHaveLength(0);
      s = await step(ids[k]);
      if (k < ids.length - 1) {
        expect(s.round.state).toBe('reveal');
        expect(s.round.definitions.find((d: any) => d.id === ids[k]).stage).toBe(2);
        expect(await events(ctx.roundId)).toHaveLength(0);
        expect(s.completed_rounds).toBe(0);
      } else {
        expect(s.round.state).toBe('results');
        expect(s.completed_rounds).toBe(1);
      }
    }
    const done = await events(ctx.roundId);
    expect(done).toHaveLength(5);
    expect(await code(step(ids[0]))).toBe('ok'); // extra clicks are harmless
    expect(await events(ctx.roundId)).toEqual(done);
    expect(totals((await t.state(0)) as any)).toEqual({ Reader: 0, Daniel: 3, Sarah: 0, Matthew: 4, Elizabeth: 0, James: 0 });
  });

  it('reveal_answers part-way through a staged reveal finishes it', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await castVotes(t, ctx, { 1: TRUTH, 2: TRUTH, 3: LIE(1) });
    await t.as(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ctx.defs[TRUTH] });
    const s: any = await t.as(0, 'reveal_answers', { p_round_id: ctx.roundId });
    expect(s.round.state).toBe('results');
    expect(s.round.definitions.every((d: any) => d.stage === 2)).toBe(true);
    expect(await events(ctx.roundId)).toHaveLength(3); // two right guesses and one deception
    expect(await code(t.as(0, 'reveal_answers', { p_round_id: ctx.roundId }))).toBe('ok');
  });

  it('reveal_answers before voting is closed is refused', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    expect(await code(t.as(0, 'reveal_answers', { p_round_id: ctx.roundId }))).toBe('voting_not_closed');
    await openVoting(t, ctx);
    expect(await code(t.as(0, 'reveal_answers', { p_round_id: ctx.roundId }))).toBe('voting_not_closed');
    expect(await code(t.as(0, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ctx.defs[TRUTH] }))).toBe('voting_not_closed');
  });
});

describe('manual adjustments', () => {
  it('are their own ledger rows, shown to everyone, counted in the totals, and leave the awards alone', async () => {
    const t = await scoredTable(db, 6, { names: ['Reader', 'Hero', 'V1', 'V2', 'V3', 'V4'] });
    const ctx = await quickRound(t, { votes: { 1: TRUTH, 2: LIE(1), 3: LIE(1), 4: LIE(1), 5: LIE(1) } });
    const base = ((await t.as(0, 'end_game', { p_room_id: t.roomId })) as any).final.awards;
    expect(base.length).toBeGreaterThan(0);
    const before = await events(ctx.roundId);

    const snap: any = await t.as(0, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[1], p_points: -2, p_note: 'Miscounted a vote' });
    const rows = await db.admin(`select * from public.score_events where category = 'MANUAL_ADJUSTMENT' and room_id = $1`, [t.roomId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ player_id: t.ids[1], points: -2, note: 'Miscounted a vote', created_by: t.ids[0], round_id: null });
    expect(snap.adjustments).toEqual([{ name: 'Hero', points: -2, note: 'Miscounted a vote' }]);
    expect(totals(snap).Hero).toBe(4);
    expect(((await t.state(2)) as any).adjustments).toEqual(snap.adjustments); // everyone sees it
    expect((await ledger(t))[t.ids[1]]).toBe(4);
    expect(snap.final.awards).toEqual(base); // an adjustment is not a deception, a guess or a bonus
    expect(await events(ctx.roundId)).toEqual(before); // the round's own events were not touched

    const more: any = await t.as(0, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[2], p_points: 5, p_note: 'Bonus for the best bluff' });
    expect(more.adjustments.map((a: any) => [a.name, a.points])).toEqual([['Hero', -2], ['V1', 5]]);
    expect(totals(more).V1).toBe(5);
    expect(more.final.awards).toEqual(base);
  });

  it('counts toward the target when it is checked at the end of the rotation', async () => {
    const t = await scoredTable(db, 3, { win_type: 'target', target: 5 });
    const r1 = await quickRound(t); // P2, P3 each 2
    await advance(t, r1);
    const mid: any = await t.as(0, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[1], p_points: 3, p_note: 'House rule' });
    expect(mid.final_rotation).toBe(true); // 2 + 3 = 5 reached the target
  });

  it('is validated: points, note, player, and only in a started digital game', async () => {
    const t = await scoredTable(db, 3);
    const adj = (args: Record<string, unknown>) =>
      t.as(0, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[1], p_points: 1, p_note: 'ok', ...args });
    expect(await code(adj({}))).toBe('no_scores_to_adjust'); // still in the lobby
    await t.as(0, 'start_game', { p_room_id: t.roomId });
    expect(await code(adj({ p_points: 0 }))).toBe('invalid_points');
    expect(await code(adj({ p_points: 101 }))).toBe('invalid_points');
    expect(await code(adj({ p_points: -101 }))).toBe('invalid_points');
    expect(await code(adj({ p_points: null }))).toBe('invalid_points');
    expect(await code(adj({ p_note: '' }))).toBe('invalid_note');
    expect(await code(adj({ p_note: '   ' }))).toBe('invalid_note');
    expect(await code(adj({ p_note: 'x'.repeat(121) }))).toBe('invalid_note');
    expect(await code(adj({ p_player_id: '00000000-0000-4000-8000-000000000000' }))).toBe('player_not_found');
    expect(await code(adj({ p_points: 100 }))).toBe('ok');
    expect(await code(adj({ p_points: -100, p_note: 'x'.repeat(120) }))).toBe('ok');
    expect(((await t.state(0)) as any).adjustments).toHaveLength(2);

    const trad = await scoredTable(db, 3, { scoring: 'traditional' });
    await trad.as(0, 'start_game', { p_room_id: trad.roomId });
    expect(
      await code(trad.as(0, 'adjust_score', { p_room_id: trad.roomId, p_player_id: trad.ids[1], p_points: 1, p_note: 'ok' })),
    ).toBe('no_scores_to_adjust');
  });
});

describe('standings', () => {
  it('always equal the ledger sums, round after round, and my_result adds up for every player', async () => {
    const t = await scoredTable(db, 4);
    let ctx: RoundCtx | undefined;
    for (let r = 0; r < 4; r++) {
      if (ctx) await advance(t, ctx);
      const readerIdx = r; // readers go round in join order
      const votes: Record<number, string> = {};
      for (let v = 0; v < 4; v++) {
        if (v === readerIdx) continue;
        const targets = [0, 1, 2, 3].filter((x) => x !== readerIdx && x !== v);
        votes[v] = (v + r) % 3 === 0 ? TRUTH : LIE(targets[(v + r) % targets.length]);
      }
      ctx = await quickRound(t, { votes });
      const snap: any = await t.state(0);
      expect(snap.completed_rounds).toBe(r + 1);
      const sums = await ledger(t);
      for (const s of snap.standings) expect(s.total, `${s.name} after round ${r + 1}`).toBe(sums[s.player_id] ?? 0);
      const roundSums = Object.fromEntries(
        (await db.admin(`select player_id, sum(points)::int as n from public.score_events where round_id = $1 group by player_id`, [ctx.roundId]))
          .map((x) => [x.player_id, x.n]),
      );
      for (let i = 0; i < 4; i++) {
        const mine: any = ((await t.state(i)) as any).round.my_result;
        expect(mine.total).toBe(sums[t.ids[i]] ?? 0);
        expect(mine.round_points).toBe(roundSums[t.ids[i]] ?? 0);
        expect(mine.previous + mine.round_points).toBe(mine.total);
        expect(snap.standings.find((s: any) => s.player_id === t.ids[i]).last).toBe(roundSums[t.ids[i]] ?? 0);
      }
    }
    expect(Object.values(await ledger(t)).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('give equal totals the same rank and skip the ranks that follow (1, 1, 3)', async () => {
    const t = await scoredTable(db, 3);
    await t.as(0, 'start_game', { p_room_id: t.roomId });
    const adj = (i: number, pts: number) => t.as<any>(0, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[i], p_points: pts, p_note: 'set up' });
    await adj(0, 5);
    await adj(1, 5);
    const snap = await adj(2, 1);
    expect(snap.standings.map((s: any) => [s.name, s.total, s.rank])).toEqual([['P1', 5, 1], ['P2', 5, 1], ['P3', 1, 3]]);
    // nobody has scored yet at a fresh table: everybody shares first place
    const fresh = await scoredTable(db, 3);
    const s: any = await fresh.as(0, 'start_game', { p_room_id: fresh.roomId });
    expect(s.standings.map((x: any) => x.rank)).toEqual([1, 1, 1]);
  });
});
