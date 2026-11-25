// What a hostile or curious player can reach in the voting and scoring system.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIE, TRUTH, advance, beginRound, castVotes, code, newDb, openVoting, prepareReading, quickRound, scoredTable, settle, vote,
  type RoundCtx, type Table, type TestDb,
} from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

const NEW_TABLES: Record<string, string> = {
  votes: 'voter_id',
  round_voters: 'player_id',
  adjudications: 'player_id',
  score_events: 'points',
  rotation_members: 'rotation',
};

describe('direct database access', () => {
  it('the new tables cannot be read, written, updated or deleted by a player or an anonymous visitor', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await quickRound(t, { accept: [1], votes: { 2: TRUTH, 3: LIE(2) } });
    expect(ctx.roundId).toBeTruthy();
    for (const who of [t.users[2], t.users[0], null]) {
      for (const [tbl, col] of Object.entries(NEW_TABLES)) {
        const label = `${tbl} as ${who ? 'player' : 'anon'}`;
        expect(await code(db.queryAs(who, `select * from public.${tbl}`)), `${label} select`).toMatch(/permission denied/);
        expect(await code(db.queryAs(who, `insert into public.${tbl} default values`)), `${label} insert`).toMatch(/permission denied/);
        expect(await code(db.queryAs(who, `update public.${tbl} set ${col} = ${col}`)), `${label} update`).toMatch(/permission denied/);
        expect(await code(db.queryAs(who, `delete from public.${tbl}`)), `${label} delete`).toMatch(/permission denied/);
      }
    }
    // nothing was disturbed
    expect((await db.admin(`select count(*)::int as n from public.votes where round_id = $1`, [ctx.roundId]))[0].n).toBe(2);
  });

  it('row level security is on for every table, including the new ones', async () => {
    expect(
      await db.admin(
        `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      ),
    ).toEqual([]);
    for (const tbl of Object.keys(NEW_TABLES)) {
      const r = await db.admin(`select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`, [tbl]);
      expect(r[0].relrowsecurity, tbl).toBe(true);
    }
    // even with a stray grant, a player would see no rows
    const t = await scoredTable(db, 4);
    await quickRound(t);
    const list = Object.keys(NEW_TABLES).map((x) => `public.${x}`).join(', ');
    await db.admin(`grant select on ${list} to authenticated`);
    try {
      for (const tbl of Object.keys(NEW_TABLES)) expect(await db.queryAs(t.users[1], `select * from public.${tbl}`), tbl).toEqual([]);
    } finally {
      await db.admin(`revoke select on ${list} from authenticated`);
    }
  });

  it('no client role can run the internal functions; only is_member is open to signed-in users', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    const calls = [
      `select private.settle_round('${ctx.roundId}')`,
      `select private.shuffle_round('${ctx.roundId}')`,
      `select private.maybe_close('${ctx.roundId}')`,
      `select private.close_round('${ctx.roundId}')`,
      `select private.change_reader('${ctx.roundId}', '${t.ids[2]}')`,
      `select private.standings(null::public.rooms)`,
      `select private.awards(null::public.rooms)`,
      `select private.player_stats(null::public.rooms, null)`,
      `select private.is_final(null::public.rooms, null::public.rounds)`,
      `select private.max_total(null::public.rooms)`,
      `select private.begin_rotation(null::public.rooms, 1)`,
      `select private.next_in_rotation(null::public.rooms, 1, 1)`,
      `select private.start_round(null::public.rooms, 0, 0)`,
      `select private.apply_rules('${t.roomId}', 'digital', 'unlimited', null, null)`,
      `select private.default_ruleset()`,
    ];
    for (const who of [t.users[1], t.users[0], null]) {
      for (const sql of calls) expect(await code(db.queryAs(who, sql)), `${who ? 'player' : 'anon'}: ${sql}`).toMatch(/permission denied/);
    }
    // the catalogue agrees: nothing in `private` is executable by clients, apart from the one membership check
    const open = await db.admin(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`,
    );
    expect(open.map((r) => r.proname)).toEqual(['is_member']);
    const anonOpen = await db.admin(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(anonOpen).toEqual([]);
    // and the game itself was not disturbed by any of that
    expect(((await t.state(0)) as any).round.state).toBe('reading');
  });

  it('nobody can write a ballot for someone else: no function takes a voter, and the table is shut', async () => {
    const t = await scoredTable(db, 4);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    const takers = await db.admin(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and exists (select 1 from unnest(coalesce(p.proargnames, '{}'::text[])) a where a ilike '%voter%')`,
    );
    expect(takers).toEqual([]);
    const sig = await db.admin(`select proargnames from pg_proc where proname = 'cast_vote' and pronamespace = 'public'::regnamespace`);
    expect(sig[0].proargnames).toEqual(['p_round_id', 'p_definition_id']);
    // naming a different voter is not possible through the function ...
    expect(
      await code(t.as(1, 'cast_vote', { p_round_id: ctx.roundId, p_definition_id: ctx.defs[TRUTH], p_voter_id: t.ids[2] })),
    ).toMatch(/does not exist|not_authenticated|bad_argument/i);
    // ... nor through the table
    for (const who of [t.users[1], null]) {
      expect(await code(db.queryAs(who, `update public.votes set definition_id = '${ctx.defs[TRUTH]}'`))).toMatch(/permission denied/);
      expect(
        await code(db.queryAs(who, `insert into public.votes (round_id, voter_id, definition_id) values ('${ctx.roundId}', '${t.ids[2]}', '${ctx.defs[TRUTH]}')`)),
      ).toMatch(/permission denied/);
    }
    // a vote only ever lands in the caller's own row
    await vote(t, ctx, 1, TRUTH);
    expect((await db.admin(`select voter_id from public.votes where round_id = $1`, [ctx.roundId])).map((r) => r.voter_id)).toEqual([t.ids[1]]);
  });
});

/** Everything a player must not learn from one snapshot while voting is open or closed. */
function expectNoVotingLeak(snap: any, who: string) {
  const json = JSON.stringify(snap);
  const round = snap.round;
  for (const k of ['voters', 'adjudication', 'correct_definition', 'submitted_player_ids', 'my_result', 'written_correct', 'abstained', 'is_final', 'reader_bonus']) {
    expect(round, `${who}: ${k}`).not.toHaveProperty(k);
  }
  expect(json, who).not.toContain('is_correct');
  expect(json, who).not.toContain('author');
  expect(json, who).not.toContain('by_reader');
  expect(json, who).not.toContain('"stage"');
  expect(typeof round.votes_cast, who).toBe('number'); // a count, never a per-definition tally
  expect(typeof round.voters_total, who).toBe('number');
  for (const d of round.definitions ?? []) {
    expect(Object.keys(d).filter((k) => k !== 'mine').sort(), who).toEqual(['id', 'position', 'text']);
  }
}

describe('while voting is open or just closed', () => {
  async function inVoting(): Promise<{ t: Table; ctx: RoundCtx }> {
    // round 2: P2 reads, so the host (P1) is an ordinary voter
    const t = await scoredTable(db, 5);
    await advance(t, await quickRound(t));
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    return { t, ctx };
  }

  it('no player’s snapshot shows another voter’s choice, a tally, an author, or which definition is genuine', async () => {
    const { t, ctx } = await inVoting();
    expect(ctx.reader).toBe(1);
    await castVotes(t, ctx, { 0: LIE(2), 2: TRUTH, 3: LIE(2) }); // P5 has not voted yet
    for (const i of [0, 2, 3, 4]) {
      const s: any = await t.state(i);
      expect(s.round.state).toBe('voting');
      expectNoVotingLeak(s, `P${i + 1} open`);
      expect(s.round.votes_cast).toBe(3);
    }
    // each sees only their own ballot
    expect(((await t.state(0)) as any).round.my_vote).toBe(ctx.defs[LIE(2)]);
    expect(((await t.state(2)) as any).round.my_vote).toBe(ctx.defs[TRUTH]);
    expect(((await t.state(4)) as any).round.my_vote).toBeNull();

    await vote(t, ctx, 4, LIE(0));
    for (const i of [0, 2, 3, 4]) {
      const s: any = await t.state(i);
      expect(s.round.state).toBe('voting_closed');
      expectNoVotingLeak(s, `P${i + 1} closed`);
    }
  });

  it('the reader sees who has voted, never what; the ballot carries no authors', async () => {
    const { t, ctx } = await inVoting();
    await castVotes(t, ctx, { 0: LIE(2), 2: TRUTH });
    const s: any = await t.state(ctx.reader);
    expect(s.round.state).toBe('voting');
    expect(s.round.voters).toEqual([
      { id: t.ids[0], name: 'P1', voted: true },
      { id: t.ids[2], name: 'P3', voted: true },
      { id: t.ids[3], name: 'P4', voted: false },
      { id: t.ids[4], name: 'P5', voted: false },
    ]);
    for (const d of s.round.definitions) expect(Object.keys(d).sort()).toEqual(['id', 'position', 'text']);
    const json = JSON.stringify(s);
    for (const k of ['my_vote', 'is_correct', 'author', 'by_reader', '"stage"', 'definition_id']) expect(json, k).not.toContain(k);
    expect(s.round).not.toHaveProperty('my_result');
    expect(s.round.votes_cast).toBe(2);
  });

  it('the host, when not the reader, is shown exactly what any other voter is shown', async () => {
    const { t, ctx } = await inVoting();
    await castVotes(t, ctx, { 2: TRUTH });
    const host: any = await t.state(0);
    const other: any = await t.state(3);
    expect(host.me.is_host).toBe(true);
    expect(Object.keys(host).sort()).toEqual(Object.keys(other).sort());
    expect(Object.keys(host.round).sort()).toEqual(Object.keys(other.round).sort());
    expect(host.round.definitions.map((d: any) => [d.id, d.position, d.text])).toEqual(
      other.round.definitions.map((d: any) => [d.id, d.position, d.text]),
    );
    expect(host.round.votes_cast).toBe(other.round.votes_cast);
    expect(host.standings).toEqual(other.standings);
    expectNoVotingLeak(host, 'host');
  });
});

describe('while the answers are being revealed', () => {
  async function inClosedVoting() {
    const t = await scoredTable(db, 5, { names: ['Host', 'Reader', 'Ann', 'Bea', 'Cy'] });
    await advance(t, await quickRound(t)); // round 1 puts points on the board; Reader reads round 2
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await castVotes(t, ctx, { 0: LIE(2), 2: TRUTH, 3: LIE(2), 4: LIE(0) });
    expect(((await t.state(0)) as any).round.state).toBe('voting_closed');
    return { t, ctx };
  }
  const namesVoting = async (defId: string) =>
    (await db.admin(`select p.name from public.votes v join public.players p on p.id = v.voter_id where v.definition_id = $1 order by p.rotation_pos`, [defId])).map(
      (r) => r.name,
    );

  it('an unrevealed definition shows nothing; stage 1 shows its voters only; stage 2 adds the author and the truth', async () => {
    const { t, ctx } = await inClosedVoting();
    const target = ctx.defs[LIE(2)]; // Ann's, with two votes
    const everyone = [0, 1, 2, 3, 4];
    const step = () => t.as(1, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: target });

    await step();
    for (const i of everyone) {
      const s: any = await t.state(i);
      expect(s.round.state).toBe('reveal');
      const json = JSON.stringify(s);
      for (const d of s.round.definitions as any[]) {
        const keys = Object.keys(d).filter((k) => k !== 'mine').sort();
        if (d.id === target) {
          expect(d.stage).toBe(1);
          expect(keys, `P${i} stage 1`).toEqual(['id', 'position', 'stage', 'text', 'voters']);
          expect(d.voters).toEqual(await namesVoting(target));
          expect(d.voters).toEqual(['Host', 'Bea']);
        } else {
          expect(d.stage).toBe(0);
          expect(keys, `P${i} stage 0`).toEqual(['id', 'position', 'stage', 'text']);
        }
      }
      expect(json).not.toContain('is_correct');
      expect(json).not.toContain('author');
      expect(json).not.toContain('by_reader');
      expect(s.round).not.toHaveProperty('my_result');
      if (i !== 1) expect(s.round).not.toHaveProperty('correct_definition');
    }

    await step();
    for (const i of everyone) {
      const s: any = await t.state(i);
      for (const d of s.round.definitions as any[]) {
        if (d.id === target) {
          expect(d).toMatchObject({ stage: 2, is_correct: false, author_name: 'Ann', by_reader: false });
          expect(d.voters).toEqual(['Host', 'Bea']);
        } else {
          expect(d.stage).toBe(0);
          expect(d).not.toHaveProperty('voters');
          expect(d).not.toHaveProperty('is_correct');
          expect(d).not.toHaveProperty('author_name');
          expect(d).not.toHaveProperty('author_id');
        }
      }
    }
  });

  it('the standings do not move until the round is settled', async () => {
    const { t, ctx } = await inClosedVoting();
    const view = async (i: number) => {
      const s: any = await t.state(i);
      return JSON.stringify({ standings: s.standings, completed: s.completed_rounds });
    };
    const before = await Promise.all([0, 1, 2, 3, 4].map(view));
    expect(JSON.parse(before[0]).completed).toBe(1);
    const ids = Object.values(ctx.defs);
    for (let k = 0; k < ids.length - 1; k++) {
      await t.as(1, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ids[k] });
      await t.as(1, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ids[k] });
      expect(await Promise.all([0, 1, 2, 3, 4].map(view)), `after definition ${k + 1}`).toEqual(before);
    }
    // the last step settles the round, and only then do the numbers change
    await t.as(1, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ids[ids.length - 1] });
    expect(await view(0)).toBe(before[0]);
    await t.as(1, 'reveal_step', { p_round_id: ctx.roundId, p_definition_id: ids[ids.length - 1] });
    const after = await Promise.all([0, 1, 2, 3, 4].map(view));
    expect(after[0]).not.toBe(before[0]);
    expect(JSON.parse(after[0]).completed).toBe(2);
  });

  it('a settled round shows the results to everyone; only then do the accepted definitions appear', async () => {
    const t = await scoredTable(db, 5, { names: ['Reader', 'Ann', 'Bea', 'Cy', 'Di'] });
    const ctx = await prepareReading(t, { accept: [2] });
    // while reading and voting nobody learns who was accepted
    for (const i of [1, 2, 3, 4]) {
      const j = JSON.stringify(((await t.state(i)) as any).round);
      expect(j).not.toContain('adjudication');
      expect(j).not.toContain('written_correct');
    }
    await openVoting(t, ctx);
    for (const i of [1, 2, 3, 4]) {
      const r = ((await t.state(i)) as any).round;
      expect(r).not.toHaveProperty('written_correct');
      expect(r).not.toHaveProperty('adjudication');
    }
    await castVotes(t, ctx, { 1: TRUTH, 3: LIE(1), 4: LIE(3) });
    await settle(t, ctx);
    for (const i of [0, 1, 2, 3, 4]) {
      expect(((await t.state(i)) as any).round.written_correct, `P${i}`).toEqual([{ name: 'Bea', text: LIE(2) }]);
    }
  });
});

describe('the reader’s check of written definitions', () => {
  async function adjudicating() {
    const t = await scoredTable(db, 5);
    const { roundId, reader } = await beginRound(t);
    for (const i of [1, 2, 3, 4]) await t.as(i, 'submit_definition', { p_round_id: roundId, p_text: LIE(i) });
    const snap: any = await t.as(reader, 'reader_skip', { p_round_id: roundId });
    expect(snap.round.state).toBe('adjudicating');
    return { t, roundId, reader, snap };
  }

  it('is invisible to the other players, before and after each decision', async () => {
    const { t, roundId, reader, snap } = await adjudicating();
    expect(snap.round.adjudication).toHaveLength(4);
    for (const a of snap.round.adjudication) {
      expect(Object.keys(a).sort()).toEqual(['correct', 'submission_id', 'text']); // no author
      expect(a.correct).toBe(false);
    }
    const watch = [2, 3, 4];
    const beforeJson = await Promise.all(watch.map(async (i) => JSON.stringify(((await t.state(i)) as any).round)));
    for (const j of beforeJson) {
      expect(j).not.toContain('adjudication');
      expect(j).not.toContain('submitted_player_ids');
    }
    const entry = snap.round.adjudication.find((a: any) => a.text === LIE(2));
    await t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: entry.submission_id, p_correct: true });
    const afterJson = await Promise.all(watch.map(async (i) => JSON.stringify(((await t.state(i)) as any).round)));
    expect(afterJson).toEqual(beforeJson); // including the writer whose text was accepted (P3)
    // nobody but the reader can see anybody else's text in this state
    for (const i of [1, 2, 3, 4]) {
      const j = JSON.stringify(((await t.state(i)) as any).round);
      for (const k of [1, 2, 3, 4]) if (k !== i) expect(j).not.toContain(LIE(k));
    }
    // the decision is reversible until the reader finishes
    const undo: any = await t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: entry.submission_id, p_correct: false });
    expect(undo.round.adjudication.find((a: any) => a.text === LIE(2)).correct).toBe(false);
  });

  it('can only be done by the reader', async () => {
    const t = await scoredTable(db, 5);
    await advance(t, await quickRound(t)); // P2 reads round 2; P1 is host but not reader
    const { roundId, reader } = await beginRound(t);
    expect(reader).toBe(1);
    for (const i of [0, 2, 3, 4]) await t.as(i, 'submit_definition', { p_round_id: roundId, p_text: LIE(i) });
    const snap: any = await t.as(reader, 'reader_skip', { p_round_id: roundId });
    expect(snap.round.state).toBe('adjudicating');
    const sub = snap.round.adjudication[0].submission_id;
    const defId = randomUUID();
    for (const who of [0, 2]) {
      // 0 is the host, 2 an ordinary player
      const calls: [string, Record<string, unknown>][] = [
        ['adjudicate', { p_round_id: roundId, p_submission_id: sub, p_correct: true }],
        ['finish_adjudication', { p_round_id: roundId }],
        ['open_voting', { p_round_id: roundId }],
        ['close_voting', { p_round_id: roundId }],
        ['reveal_step', { p_round_id: roundId, p_definition_id: defId }],
        ['reveal_answers', { p_round_id: roundId }],
      ];
      for (const [fn, args] of calls) expect(await code(t.as(who, fn, args)), `P${who + 1} ${fn}`).toBe('not_reader');
    }
    expect(await code(t.as(2, 'next_round', { p_round_id: roundId }))).toBe('not_reader');
    // the host may move the table on, but not before the round is over
    expect(await code(t.as(0, 'next_round', { p_round_id: roundId }))).toBe('not_revealed_yet');
    expect(((await t.state(1)) as any).round.state).toBe('adjudicating');
    expect(await db.admin(`select 1 from public.adjudications where round_id = $1`, [roundId])).toEqual([]);
  });

  it('cannot cover the reader’s own definition or anything from another round', async () => {
    const t = await scoredTable(db, 3);
    const { roundId, reader } = await beginRound(t);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: LIE(1) });
    await t.as(reader, 'submit_definition', { p_round_id: roundId, p_text: 'the reader’s own' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: LIE(2) });
    const snap: any = await t.state(reader);
    expect(snap.round.state).toBe('adjudicating');
    expect(snap.round.adjudication.map((a: any) => a.text).sort()).toEqual([LIE(1), LIE(2)]); // the reader's own is not offered
    const own = (await db.admin(`select id from public.submissions where round_id = $1 and player_id = $2`, [roundId, t.ids[reader]]))[0].id;
    expect(await code(t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: own, p_correct: true }))).toBe('cannot_adjudicate_own');
    expect(await code(t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: own, p_correct: false }))).toBe('cannot_adjudicate_own');
    expect(await code(t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: randomUUID(), p_correct: true }))).toBe('submission_not_found');
    const other = await scoredTable(db, 3);
    const o = await beginRound(other);
    for (const i of [1, 2]) await other.as(i, 'submit_definition', { p_round_id: o.roundId, p_text: LIE(i) });
    await other.as(o.reader, 'reader_skip', { p_round_id: o.roundId });
    const foreign = (await db.admin(`select id from public.submissions where round_id = $1 limit 1`, [o.roundId]))[0].id;
    expect(await code(t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: foreign, p_correct: true }))).toBe('submission_not_found');
    expect(await db.admin(`select 1 from public.adjudications where round_id = $1`, [roundId])).toEqual([]);
  });
});

describe('host-only controls and outsiders', () => {
  it('only the host can adjust scores, start another game or change the settings', async () => {
    const t = await scoredTable(db, 3, { win_type: 'rotations', rotations: 1 });
    await quickRound(t);
    for (const i of [1, 2]) {
      expect(await code(t.as(i, 'adjust_score', { p_room_id: t.roomId, p_player_id: t.ids[1], p_points: 5, p_note: 'cheat' })), `P${i + 1}`).toBe('not_host');
      expect(await code(t.as(i, 'play_again', { p_room_id: t.roomId }))).toBe('not_host');
      expect(
        await code(t.as(i, 'update_settings', { p_room_id: t.roomId, p_mode: 'physical', p_scoring: 'digital', p_win_type: 'unlimited' })),
      ).toBe('not_host');
    }
    expect(await db.admin(`select 1 from public.score_events where category = 'MANUAL_ADJUSTMENT' and room_id = $1`, [t.roomId])).toEqual([]);
    // the same once the game is over
    await t.as(0, 'end_game', { p_room_id: t.roomId });
    expect(await code(t.as(1, 'play_again', { p_room_id: t.roomId }))).toBe('not_host');
    expect(((await t.state(0)) as any).room.status).toBe('ended');
    expect(await code(t.as(0, 'play_again', { p_room_id: t.roomId }))).toBe('ok');
  });

  it('a signed-in outsider from another room, or with no room at all, is turned away from everything', async () => {
    const a = await scoredTable(db, 4);
    const b = await scoredTable(db, 3);
    const ctx = await prepareReading(a);
    await openVoting(a, ctx);
    const def = ctx.defs[TRUTH];
    const sub = randomUUID();
    const calls: [string, Record<string, unknown>][] = [
      ['get_state', { p_room_id: a.roomId }],
      ['cast_vote', { p_round_id: ctx.roundId, p_definition_id: def }],
      ['adjudicate', { p_round_id: ctx.roundId, p_submission_id: sub, p_correct: true }],
      ['finish_adjudication', { p_round_id: ctx.roundId }],
      ['open_voting', { p_round_id: ctx.roundId }],
      ['close_voting', { p_round_id: ctx.roundId }],
      ['reveal_step', { p_round_id: ctx.roundId, p_definition_id: def }],
      ['reveal_answers', { p_round_id: ctx.roundId }],
      ['next_round', { p_round_id: ctx.roundId }],
      ['submit_definition', { p_round_id: ctx.roundId, p_text: 'sneaky' }],
      ['adjust_score', { p_room_id: a.roomId, p_player_id: a.ids[1], p_points: 5, p_note: 'cheat' }],
      ['play_again', { p_room_id: a.roomId }],
      ['end_game', { p_room_id: a.roomId }],
      ['set_reader', { p_room_id: a.roomId, p_player_id: b.ids[1] }],
      ['update_settings', { p_room_id: a.roomId, p_mode: 'physical', p_scoring: 'digital', p_win_type: 'unlimited' }],
    ];
    const strangers = [b.users[0], b.users[1], randomUUID()]; // even another room's host
    for (const user of strangers) {
      for (const [fn, args] of calls) expect(await code(db.rpc(user, fn, args)), fn).toBe('not_member');
    }
    expect(await code(db.rpc(b.users[1], 'cast_vote', { p_round_id: randomUUID(), p_definition_id: def }))).toBe('round_not_found');
    expect(await db.admin(`select 1 from public.votes where round_id = $1`, [ctx.roundId])).toEqual([]);
    // an anonymous visitor cannot even try
    for (const [fn, args] of calls) {
      const argList = Object.entries(args).map(([k, v]) => `${k} => ${typeof v === 'string' ? `'${v}'` : v}`).join(', ');
      const sql = `select public.${fn}(${argList})`;
      expect(await code(db.queryAs(null, sql)), fn).toMatch(/permission denied/);
    }
  });

  it('a player who left, or was removed, is also turned away', async () => {
    const t = await scoredTable(db, 5);
    const ctx = await prepareReading(t);
    await openVoting(t, ctx);
    await t.as(3, 'leave_room', { p_room_id: t.roomId });
    await t.as(0, 'remove_player', { p_room_id: t.roomId, p_player_id: t.ids[4] });
    expect(await code(vote(t, ctx, 3, TRUTH))).toBe('not_member');
    expect(await code(vote(t, ctx, 4, TRUTH))).toBe('removed_from_room');
    expect(await db.admin(`select 1 from public.votes where round_id = $1`, [ctx.roundId])).toEqual([]);
  });
});
