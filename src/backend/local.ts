// Talks to dev-server/server.mjs, which runs the real SQL in an in-process
// Postgres. For development and end-to-end tests only.
import { GameError, NetworkError, type Backend } from './types';

export function createLocalBackend(baseUrl: string): Backend {
  const KEY = 'balderdash.devuser';
  function user() {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  }
  return {
    async ready() {
      user();
    },
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/rpc/${fn}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user': user() },
          body: JSON.stringify(args),
        });
      } catch (e) {
        throw new NetworkError(String(e));
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (body?.message && /^[a-z_]+$/.test(body.message)) throw new GameError(body.message);
        throw new NetworkError(body?.message ?? `http ${res.status}`);
      }
      return body as T;
    },
    subscribe(roomId, onChange) {
      const es = new EventSource(`${baseUrl}/events?room=${encodeURIComponent(roomId)}`);
      es.onmessage = () => onChange();
      es.onopen = () => onChange();
      return () => es.close();
    },
  };
}
