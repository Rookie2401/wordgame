import { randomUUID } from 'node:crypto';
import { createDb } from '../../dev-server/db.mjs';
import type { Snapshot } from '../../src/backend/types';

export interface TestDb {
  rpc<T = any>(user: string | null, fn: string, args?: Record<string, unknown>): Promise<T>;
  queryAs(user: string | null, sql: string, params?: unknown[]): Promise<any[]>;
  admin(sql: string, params?: unknown[]): Promise<any[]>;
  close(): Promise<void>;
}

export const newDb = (opts?: { words?: 'fixture' | 'sample' | 'none' }): Promise<TestDb> => createDb(opts);

export interface Table {
  db: TestDb;
  roomId: string;
  code: string;
  users: string[]; // users[0] is the host
  ids: string[]; // player ids, same order
  state(i: number): Promise<Snapshot>;
  as<T = Snapshot>(i: number, fn: string, args?: Record<string, unknown>): Promise<T>;
}

/** Creates a room with n players named P1..Pn (P1 hosts). */
export async function table(db: TestDb, n: number, mode: 'physical' | 'digital' = 'physical'): Promise<Table> {
  const users = Array.from({ length: n }, () => randomUUID());
  const room = await db.rpc(users[0], 'create_room', { p_name: 'P1', p_mode: mode });
  const ids = [room.player_id as string];
  for (let i = 1; i < n; i++) {
    const j = await db.rpc(users[i], 'join_room', { p_code: room.code, p_name: `P${i + 1}` });
    ids.push(j.player_id);
  }
  return {
    db,
    roomId: room.room_id,
    code: room.code,
    users,
    ids,
    state: (i) => db.rpc(users[i], 'get_state', { p_room_id: room.room_id }),
    as: (i, fn, args = {}) => db.rpc(users[i], fn, args),
  };
}

/** Starts the game and confirms a physical card; returns the round id. */
export async function toCollecting(t: Table, word = 'quire', definition = 'Twenty-four sheets of paper.') {
  const s = await t.as(0, 'start_game', { p_room_id: t.roomId });
  const reader = t.ids.indexOf(s.round!.reader_id);
  await t.as(reader, 'confirm_card', { p_round_id: s.round!.id, p_word: word, p_definition: definition });
  return { roundId: s.round!.id, reader };
}

export async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Helpers for digital-scoring rooms (voting, scoring, winning).
// Snapshots are typed `any` here: the scoring fields are newer than the shared types.
// ---------------------------------------------------------------------------

export interface ScoredOpts {
  scoring?: 'digital' | 'traditional';
  win_type?: 'target' | 'rotations' | 'unlimited';
  target?: number;
  rotations?: number;
  names?: string[];
}

/** The genuine definition used by every helper round unless a test says otherwise. */
export const TRUTH = 'The genuine definition of the word.';
/** The false definition player i (0-based) writes unless a test says otherwise. */
export const LIE = (i: number) => `lie of P${i + 1}`;

/** Like table(), but the room is created with the voting/scoring options. P1 hosts. */
export async function scoredTable(db: TestDb, n: number, opts: ScoredOpts = {}): Promise<Table> {
  const users = Array.from({ length: n }, () => randomUUID());
  const names = opts.names ?? Array.from({ length: n }, (_, i) => `P${i + 1}`);
  const args: Record<string, unknown> = {
    p_name: names[0],
    p_mode: 'physical',
    p_scoring: opts.scoring ?? 'digital',
    p_win_type: opts.win_type ?? 'unlimited',
  };
  if (opts.target !== undefined) args.p_target = opts.target;
  if (opts.rotations !== undefined) args.p_rotations = opts.rotations;
  const room = await db.rpc(users[0], 'create_room', args);
  const ids = [room.player_id as string];
  for (let i = 1; i < n; i++) {
    const j = await db.rpc(users[i], 'join_room', { p_code: room.code, p_name: names[i] });
    ids.push(j.player_id);
  }
  return {
    db,
    roomId: room.room_id,
    code: room.code,
    users,
    ids,
    state: (i) => db.rpc(users[i], 'get_state', { p_room_id: room.room_id }),
    as: (i, fn, args = {}) => db.rpc(users[i], fn, args),
  };
}

/** A player joins an existing table (mid-round or mid-game); returns the new table index. */
export async function joinLate(t: Table, name: string): Promise<number> {
  const u = randomUUID();
  const j = await t.db.rpc(u, 'join_room', { p_code: t.code, p_name: name });
  t.users.push(u);
  t.ids.push(j.player_id);
  return t.users.length - 1;
}

export interface RoundCtx {
  roundId: string;
  reader: number; // table index of the reader
  truth: string;
  /** definition text -> definition id, as the reader sees the ballot */
  defs: Record<string, string>;
  /** the reader's latest snapshot */
  snap: any;
}

export interface PrepareOpts {
  truth?: string;
  /** override the false definition text of player index i */
  lies?: Record<number, string>;
  /** indices that do not write a definition */
  skip?: number[];
  /** indices (non-reader) whose written definition the reader accepts as correct */
  accept?: number[];
  /** the reader writes a false definition of this text */
  readerWrites?: string;
}

/** Starts the game when still in the lobby, and has the reader confirm the card. */
export async function beginRound(t: Table, truth = TRUTH, viewer = 0) {
  let s: any = await t.state(viewer);
  if (s.room.status === 'lobby') s = await t.as(0, 'start_game', { p_room_id: t.roomId });
  const roundId: string = s.round.id;
  const reader = t.ids.indexOf(s.round.reader_id);
  if (s.round.state === 'card_selection') {
    await t.as(reader, 'confirm_card', { p_round_id: roundId, p_word: 'quire', p_definition: truth });
  }
  return { roundId, reader };
}

/** definition text -> id from a reader's snapshot. */
export function defsOf(snap: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of snap.round.definitions ?? []) out[d.text] = d.id;
  return out;
}

/**
 * Plays the round up to `reading`: everyone who may write does (unless in
 * `skip`), the reader skips or writes, the reader adjudicates, and the ballot
 * is read back as the reader sees it.
 */
export async function prepareReading(t: Table, o: PrepareOpts = {}): Promise<RoundCtx> {
  await t.db.admin('delete from public.rate_limits');
  const truth = o.truth ?? TRUTH;
  const { roundId, reader } = await beginRound(t, truth);
  const skip = new Set(o.skip ?? []);
  const textOf = (i: number) => o.lies?.[i] ?? LIE(i);
  for (let i = 0; i < t.users.length; i++) {
    if (i === reader || skip.has(i)) continue;
    let s: any;
    try {
      s = await t.state(i);
    } catch {
      continue; // left or removed
    }
    if (!s.round.eligible || s.round.state !== 'collecting') continue;
    await t.as(i, 'submit_definition', { p_round_id: roundId, p_text: textOf(i) });
  }
  let snap: any = await t.state(reader);
  if (snap.round.state === 'collecting') {
    if (o.readerWrites) await t.as(reader, 'submit_definition', { p_round_id: roundId, p_text: o.readerWrites });
    else await t.as(reader, 'reader_skip', { p_round_id: roundId });
    snap = await t.state(reader);
  }
  if (snap.round.state === 'collecting') snap = await t.as(reader, 'close_submissions', { p_round_id: roundId });
  if (snap.round.state === 'adjudicating') {
    for (const i of o.accept ?? []) {
      const entry = snap.round.adjudication.find((a: any) => a.text === textOf(i));
      if (!entry) throw new Error(`no adjudication entry for player ${i}`);
      snap = await t.as(reader, 'adjudicate', { p_round_id: roundId, p_submission_id: entry.submission_id, p_correct: true });
    }
    snap = await t.as(reader, 'finish_adjudication', { p_round_id: roundId });
  }
  if (snap.round.state !== 'reading') throw new Error(`expected reading, got ${snap.round.state}`);
  return { roundId, reader, truth, defs: defsOf(snap), snap };
}

/** Reader opens voting; refreshes ctx.defs from the voting ballot. */
export async function openVoting(t: Table, ctx: RoundCtx): Promise<any> {
  const snap: any = await t.as(ctx.reader, 'open_voting', { p_round_id: ctx.roundId });
  ctx.snap = snap;
  ctx.defs = defsOf(snap);
  return snap;
}

/** A voter votes for the definition with this text. */
export function vote(t: Table, ctx: RoundCtx, voter: number, text: string): Promise<any> {
  const id = ctx.defs[text];
  if (!id) throw new Error(`no definition with text "${text}"`);
  return t.as(voter, 'cast_vote', { p_round_id: ctx.roundId, p_definition_id: id });
}

/** Every listed voter votes (voter index -> definition text). */
export async function castVotes(t: Table, ctx: RoundCtx, votes: Record<number, string>) {
  await t.db.admin('delete from public.rate_limits');
  for (const [v, text] of Object.entries(votes)) await vote(t, ctx, Number(v), text);
}

/** Reader closes voting if needed, reveals everything and the round settles; returns the reader's snapshot. */
export async function settle(t: Table, ctx: RoundCtx): Promise<any> {
  let snap: any = await t.state(ctx.reader);
  if (snap.round.state === 'voting') snap = await t.as(ctx.reader, 'close_voting', { p_round_id: ctx.roundId });
  snap = await t.as(ctx.reader, 'reveal_answers', { p_round_id: ctx.roundId });
  ctx.snap = snap;
  return snap;
}

export interface QuickOpts extends PrepareOpts {
  /** voter index -> definition text. Default: every player who can vote picks the genuine definition. */
  votes?: Record<number, string>;
}

/** A whole round: write, adjudicate, read, vote, reveal. Leaves it in `results`. */
export async function quickRound(t: Table, o: QuickOpts = {}): Promise<RoundCtx> {
  const ctx = await prepareReading(t, o);
  await openVoting(t, ctx);
  let votes = o.votes;
  if (!votes) {
    votes = {};
    for (let i = 0; i < t.users.length; i++) {
      if (i === ctx.reader) continue;
      try {
        if (((await t.state(i)) as any).round.can_vote) votes[i] = ctx.truth;
      } catch {
        /* left */
      }
    }
  }
  await castVotes(t, ctx, votes);
  await settle(t, ctx);
  return ctx;
}

/** The reader (or another table index) moves the table on to the next round or the end. */
export async function advance(t: Table, ctx: RoundCtx, as = ctx.reader): Promise<any> {
  return t.as(as, 'next_round', { p_round_id: ctx.roundId });
}

/** Sum of the ledger per player id for the room's current game. */
export async function ledger(t: Table): Promise<Record<string, number>> {
  const rows = await t.db.admin(
    `select e.player_id, sum(e.points)::int as total from public.score_events e
       join public.rooms r on r.id = e.room_id and r.game_number = e.game_number
      where e.room_id = $1 group by e.player_id`,
    [t.roomId],
  );
  return Object.fromEntries(rows.map((r) => [r.player_id, r.total]));
}

/** name -> total from a snapshot's standings */
export function totals(snap: any): Record<string, number> {
  return Object.fromEntries(snap.standings.map((s: any) => [s.name, s.total]));
}
