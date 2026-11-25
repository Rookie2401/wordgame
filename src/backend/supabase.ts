import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { GameError, NetworkError, type Backend } from './types';

const KNOWN = /^[a-z_]+$/;

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const client: SupabaseClient = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'balderdash.auth' },
  });
  let pending: Promise<void> | null = null;

  async function ensureSession() {
    const { data } = await client.auth.getSession();
    if (data.session) return;
    const { error } = await client.auth.signInAnonymously();
    if (error) throw new NetworkError(error.message);
  }

  return {
    ready() {
      pending ??= ensureSession().catch((e) => {
        pending = null;
        throw e;
      });
      return pending;
    },

    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      await this.ready();
      let res;
      try {
        res = await client.rpc(fn, args);
      } catch (e) {
        throw new NetworkError(String(e));
      }
      if (res.error) {
        const msg = res.error.message ?? '';
        // Errors raised by the game functions are bare snake_case codes.
        if (KNOWN.test(msg)) throw new GameError(msg);
        if (res.status === 401 || res.status === 403) {
          // Session gone: start a new one next time. Membership is recovered
          // with a rejoin code from the host.
          pending = null;
          throw new GameError('not_authenticated');
        }
        throw new NetworkError(msg);
      }
      // Some failures are returned rather than raised, so rate limits count them.
      const data = res.data as { error?: unknown } | null;
      if (data && typeof data === 'object' && typeof data.error === 'string') throw new GameError(data.error);
      return res.data as T;
    },

    subscribe(roomId, onChange) {
      const channel = client
        .channel(`room-${roomId}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
          () => onChange(),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') onChange();
        });
      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
