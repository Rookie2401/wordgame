// Small, failure-tolerant wrappers over localStorage. Only this device's own
// data is kept here: which room it is in, its name, its unsent draft and a
// layout preference. Never cards or other players' definitions.

const PREFIX = 'balderdash.';

export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode or full storage: carry on without it */
  }
}

export interface StoredSession {
  roomId: string;
  code: string;
}

export const session = {
  get: () => load<StoredSession>('session'),
  set: (s: StoredSession | null) => save('session', s),
};

export const draft = {
  get: (roundId: string) => load<string>(`draft.${roundId}`) ?? '',
  set: (roundId: string, text: string) => save(`draft.${roundId}`, text || null),
  /** Drops drafts left over from earlier rounds. */
  prune(keepRoundId: string | null) {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(PREFIX + 'draft.') && k !== `${PREFIX}draft.${keepRoundId}`) {
          localStorage.removeItem(k);
        }
      }
    } catch {
      /* ignore */
    }
  },
};
