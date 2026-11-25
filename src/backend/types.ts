// The shape of the data the backend returns. Nothing here is computed on the
// client: get_state builds a different snapshot for each caller.

export type GameMode = 'physical' | 'digital';
export type RoomStatus = 'lobby' | 'playing' | 'ended';
export type RoundState = 'card_selection' | 'collecting' | 'reading' | 'reveal' | 'done';

export interface PlayerInfo {
  id: string;
  name: string;
  join_order: number;
  rotation_pos: number;
  connected: boolean;
}

export interface DefinitionItem {
  id: string;
  position: number;
  text: string;
  // Present only after the reveal:
  is_correct?: boolean;
  author_id?: string | null;
  author_name?: string | null;
  by_reader?: boolean;
}

export interface RoundInfo {
  id: string;
  number: number;
  state: RoundState;
  reader_id: string;
  reader_name: string;
  word: string | null;
  card_source: 'physical' | 'digital' | 'manual_fallback';
  eligible: boolean;
  required_count: number;
  submitted_count: number;
  reader_done: boolean;
  my_submission: string | null;
  // Reader only:
  correct_definition?: string | null;
  pronunciation?: string | null;
  part_of_speech?: string | null;
  reader_skipped?: boolean;
  submitted_player_ids?: string[];
  // Reader while reading; everyone after the reveal:
  definitions?: DefinitionItem[];
}

export interface Snapshot {
  version: number;
  room: { id: string; code: string; mode: GameMode; status: RoomStatus; host_player_id: string | null };
  me: { id: string; name: string; is_host: boolean; is_reader: boolean };
  players: PlayerInfo[];
  round: RoundInfo | null;
}

export interface JoinResult {
  room_id: string;
  code: string;
  player_id: string;
}

/** An error the backend raised on purpose; `code` is one of its error names. */
export class GameError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'GameError';
    this.code = code;
  }
}

/** The request never got an answer (offline, timeout). */
export class NetworkError extends Error {
  constructor(message = 'network') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface Backend {
  /** Makes sure this device has an anonymous session. */
  ready(): Promise<void>;
  rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T>;
  /** Calls onChange whenever the room may have changed. Returns an unsubscribe. */
  subscribe(roomId: string, onChange: () => void): () => void;
}
