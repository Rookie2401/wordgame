// An in-process Postgres (PGlite) loaded with the real migrations. Used by the
// automated tests and by the local dev server, so both exercise the same SQL
// that runs on Supabase. Not used in production.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Stand-ins for what Supabase provides: the client roles and auth.uid().
const SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`;

export const FIXTURE_WORDS = Array.from({ length: 6 }, (_, i) => ({
  word: `fixtureword${i + 1}`,
  definition: `Fixture definition number ${i + 1}.`,
}));

export async function createDb({ words = 'fixture' } = {}) {
  const pg = new PGlite();
  await pg.exec(SHIM);
  const dir = path.join(root, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(path.join(dir, f), 'utf8'));
  }
  const sample = path.join(root, 'supabase', 'seed', 'words.sample.sql');
  if (words === 'sample' && existsSync(sample)) {
    await pg.exec(readFileSync(sample, 'utf8'));
  } else if (words !== 'none') {
    for (const w of FIXTURE_WORDS) {
      await pg.query(
        `insert into public.words (word, definition, part_of_speech, pronunciation, source, license, verification, difficulty)
         values ($1, $2, 'n.', 'fix·ture', 'test fixture', 'n/a', 'fixture', 'obscure')`,
        [w.word, w.definition],
      );
    }
  }
  return new Db(pg);
}

const ARG = /^p_[a-z_]+$/;
const FN = /^[a-z_]+$/;

function encode(v) {
  if (Array.isArray(v)) return `{${v.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
  return v;
}

export class RpcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RpcError';
  }
}

export class Db {
  constructor(pg) {
    this.pg = pg;
  }

  /** Calls public.<fn> as a signed-in user, the way PostgREST would. */
  async rpc(userId, fn, args = {}) {
    if (!FN.test(fn)) throw new RpcError('bad_function');
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    if (!keys.every((k) => ARG.test(k))) throw new RpcError('bad_argument');
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`;
    const out = await this.asRole(userId ? 'authenticated' : 'anon', userId, async (tx) => {
      const res = await tx.query(sql, keys.map((k) => encode(args[k])));
      return res.rows[0].result;
    });
    // Some failures are returned rather than raised (so rate limits still count them).
    if (out && typeof out === 'object' && typeof out.error === 'string') throw new RpcError(out.error);
    return out;
  }

  /** Runs raw SQL as a client role: what a hostile client could try directly. */
  async queryAs(userId, sql, params = []) {
    return this.asRole(userId ? 'authenticated' : 'anon', userId, async (tx) => (await tx.query(sql, params)).rows);
  }

  async asRole(role, userId, body) {
    try {
      return await this.pg.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
        await tx.exec(`set local role ${role}`);
        return body(tx);
      });
    } catch (e) {
      throw new RpcError(e?.message ?? String(e));
    }
  }

  /** Superuser access, for test assertions and time travel only. */
  async admin(sql, params = []) {
    return (await this.pg.query(sql, params)).rows;
  }

  async close() {
    await this.pg.close();
  }
}
