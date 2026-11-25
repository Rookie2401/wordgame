// Applying the voting-and-scoring migration to a database that already holds
// a game in progress, the way it is applied to the live project.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../../supabase/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const SHIM = `
  create role anon nologin; create role authenticated nologin; create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;`;

async function rpc(pg: PGlite, user: string, fn: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
    await tx.exec('set local role authenticated');
    const res = await tx.query<{ r: any }>(
      `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
      keys.map((k) => args[k]),
    );
    return res.rows[0].r;
  });
}

describe('migrating a live database', () => {
  it('a game in progress carries on unchanged, and an old copy of the app still creates a traditional room', async () => {
    const pg = new PGlite();
    await pg.exec(SHIM);
    for (const f of files.filter((f) => f < '20261125')) await pg.exec(readFileSync(path.join(dir, f), 'utf8'));

    // Before the migration: three players, round 1 revealed, round 2 collecting.
    const u = [randomUUID(), randomUUID(), randomUUID()];
    const room = await rpc(pg, u[0], 'create_room', { p_name: 'A', p_mode: 'physical' });
    await rpc(pg, u[1], 'join_room', { p_code: room.code, p_name: 'B' });
    await rpc(pg, u[2], 'join_room', { p_code: room.code, p_name: 'C' });
    let s = await rpc(pg, u[0], 'start_game', { p_room_id: room.room_id });
    await rpc(pg, u[0], 'confirm_card', { p_round_id: s.round.id, p_word: 'w1', p_definition: 'd1' });
    await rpc(pg, u[0], 'close_submissions', { p_round_id: s.round.id });
    await rpc(pg, u[0], 'reveal_answers', { p_round_id: s.round.id });
    s = await rpc(pg, u[0], 'next_round', { p_round_id: s.round.id });
    expect(s.round.reader_name).toBe('B');
    await rpc(pg, u[1], 'confirm_card', { p_round_id: s.round.id, p_word: 'w2', p_definition: 'd2' });
    await rpc(pg, u[2], 'submit_definition', { p_round_id: s.round.id, p_text: 'kept through the migration' });
    const round2 = s.round.id;

    // The migration.
    for (const f of files.filter((f) => f >= '20261125')) await pg.exec(readFileSync(path.join(dir, f), 'utf8'));

    // The same game, mid-round, still traditional.
    s = await rpc(pg, u[2], 'get_state', { p_room_id: room.room_id });
    expect(s.room).toMatchObject({ scoring: 'traditional', win_type: 'unlimited', game_number: 1 });
    expect(s.round).toMatchObject({ id: round2, state: 'collecting', my_submission: 'kept through the migration' });
    expect(s.standings).toBeUndefined();
    await rpc(pg, u[0], 'submit_definition', { p_round_id: round2, p_text: 'a' });
    s = await rpc(pg, u[1], 'reader_skip', { p_round_id: round2 });
    expect(s.round.state).toBe('reading'); // no adjudication, no voting
    s = await rpc(pg, u[1], 'reveal_answers', { p_round_id: round2 });
    expect(s.round.state).toBe('reveal');
    expect(s.round.definitions).toHaveLength(3);
    s = await rpc(pg, u[1], 'next_round', { p_round_id: round2 });
    // The reader order is not disturbed: C is next, then back to A.
    expect(s.round).toMatchObject({ number: 3, reader_name: 'C' });
    await rpc(pg, u[2], 'confirm_card', { p_round_id: s.round.id, p_word: 'w3', p_definition: 'd3' });
    await rpc(pg, u[2], 'close_submissions', { p_round_id: s.round.id });
    await rpc(pg, u[2], 'reveal_answers', { p_round_id: s.round.id });
    s = await rpc(pg, u[2], 'next_round', { p_round_id: s.round.id });
    expect(s.round).toMatchObject({ number: 4, reader_name: 'A' });

    // A copy of the app that has not refreshed sends only name and card mode.
    const old = await rpc(pg, randomUUID(), 'create_room', { p_name: 'Old', p_mode: 'digital' });
    const [row] = (await pg.query<{ scoring: string }>(`select scoring from public.rooms where id = $1`, [old.room_id])).rows;
    expect(row.scoring).toBe('traditional');
    await pg.close();
  });
});
