// Keeps one room's authoritative snapshot current.
//
// The snapshot always comes from get_state. Realtime only says "look again";
// a slow poll covers missed notifications, and coming back to the foreground
// or back online looks again at once. Snapshots carry a version, so a late or
// repeated answer can never overwrite a newer one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GameError, type Backend, type Snapshot } from '../backend/types';

const POLL_MS = 4000;
const FATAL = new Set(['room_not_found', 'not_member', 'removed_from_room']);

export interface RoomHandle {
  snapshot: Snapshot | null;
  /** Set when this device can no longer be in the room. */
  fatal: string | null;
  /** False while requests are failing to reach the backend. */
  online: boolean;
  /** Name of the action awaiting the backend's answer, if any. */
  busy: string | null;
  /** Runs a game action once; resolves true when the backend accepted it. */
  act(fn: string, args?: Record<string, unknown>): Promise<boolean>;
  /** Like act, for calls that return something other than a snapshot. */
  call<T>(fn: string, args?: Record<string, unknown>): Promise<T | null>;
  error: string | null;
  clearError(): void;
}

function isSnapshot(x: unknown): x is Snapshot {
  return typeof x === 'object' && x !== null && 'version' in x && 'room' in x;
}

export function useRoom(backend: Backend, roomId: string): RoomHandle {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);

  const apply = useCallback((s: Snapshot) => {
    if (!aliveRef.current || s.version < versionRef.current) return;
    versionRef.current = s.version;
    setSnapshot(s);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await backend.rpc<Snapshot>('get_state', { p_room_id: roomId });
      if (!aliveRef.current) return;
      setOnline(true);
      apply(s);
    } catch (e) {
      if (!aliveRef.current) return;
      if (e instanceof GameError) {
        setOnline(true);
        if (FATAL.has(e.code) || e.code === 'not_authenticated') setFatal(e.code);
      } else {
        setOnline(false);
      }
    }
  }, [backend, roomId, apply]);

  useEffect(() => {
    aliveRef.current = true;
    versionRef.current = 0;
    void refresh();
    const unsubscribe = backend.subscribe(roomId, () => void refresh());
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const wake = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      aliveRef.current = false;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [backend, roomId, refresh]);

  const call = useCallback(
    async <T,>(fn: string, args: Record<string, unknown> = {}): Promise<T | null> => {
      if (busyRef.current) return null; // a second tap while the first is in flight
      busyRef.current = true;
      setBusy(fn);
      setError(null);
      try {
        const out = await backend.rpc<T>(fn, args);
        if (isSnapshot(out)) apply(out);
        setOnline(true);
        return out;
      } catch (e) {
        if (e instanceof GameError) {
          if (FATAL.has(e.code)) setFatal(e.code);
          else setError(e.code);
          void refresh();
        } else {
          setOnline(false);
          setError('network');
        }
        return null;
      } finally {
        busyRef.current = false;
        if (aliveRef.current) setBusy(null);
      }
    },
    [backend, apply, refresh],
  );

  const act = useCallback(
    async (fn: string, args: Record<string, unknown> = {}) => (await call(fn, args)) !== null,
    [call],
  );

  return { snapshot, fatal, online, busy, act, call, error, clearError: () => setError(null) };
}
