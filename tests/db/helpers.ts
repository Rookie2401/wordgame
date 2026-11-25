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
