// Local stand-in for Supabase: the real migrations in an in-process Postgres,
// behind a tiny HTTP API. Development and end-to-end tests only.
//
//   POST /rpc/<function>   header x-user: <uuid>, JSON body of p_ arguments
//   GET  /events?room=<id> server-sent "something changed" notifications
//   POST /admin/<action>   test helpers (expire rooms, etc.)
import http from 'node:http';
import { createDb } from './db.mjs';

const port = Number(process.env.PORT ?? 5197);
const db = await createDb({ words: process.env.WORDS ?? 'sample' });
const listeners = new Set();
const UUID = /^[0-9a-f-]{36}$/i;

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-user',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });
      res.write('retry: 1000\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/rpc/')) {
      const user = req.headers['x-user'];
      if (typeof user !== 'string' || !UUID.test(user)) return send(res, 401, { message: 'not_authenticated' });
      const fn = url.pathname.slice(5);
      try {
        const out = await db.rpc(user, fn, await readJson(req));
        if (fn !== 'get_state' && fn !== 'room_exists') {
          for (const l of listeners) l.write('data: changed\n\n');
        }
        return send(res, 200, out);
      } catch (e) {
        return send(res, 400, { message: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/admin/expire-rooms') {
      await db.admin(`update public.rooms set last_activity_at = now() - interval '2 days'`);
      const [{ n }] = await db.admin('select private.cleanup_rooms() as n');
      return send(res, 200, { deleted: n });
    }

    send(res, 404, { message: 'not_found' });
  })
  .listen(port, '127.0.0.1', () => console.log(`dev backend on http://127.0.0.1:${port}`));
