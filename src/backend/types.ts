// The shape of the data the backend returns. Nothing here is computed on the
// client: get_state builds a different snapshot for each caller.

export type GameMode = 'physical' | 'digital';
export type RoomStatus = 'lobby' | 'playing' | 'ended';
export type RoundState =
  | 'card_selection'
  | 'collecting'
  | 'adjudicating'
  | 'reading'
  | 'voting'
  | 'voting_closed'
  | 'reveal'
  | 'results'
  | 'done';
export type ScoringMode = 'digital' | 'traditional';
export type WinType = 'target' | 'rotations' | 'unlimited';
export type ScoreCategory =
  | 'CORRECT_GUESS'
  | 'SUCCESSFUL_DECEPTION'
  | 'CORRECT_WRITTEN_DEFINITION'
  | 'READER_BONUS'
  | 'MANUAL_ADJUSTMENT';

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
  /** The caller's own definition (shown to them alone). */
  mine?: boolean;
  /** Digital scoring: 0 hidden, 1 voters shown, 2 author and correctness shown. */
  stage?: number;
  voters?: string[];
  // Present only once revealed:
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
  // Reader while reading; voters while voting; everyone after the reveal:
  definitions?: DefinitionItem[];
  rotation?: number;
  // Reader, while adjudicating:
  adjudication?: { submission_id: string; text: string; correct: boolean }[];
  // Voting:
  can_vote?: boolean;
  voters_total?: number;
  votes_cast?: number;
  my_vote?: string | null;
  voters?: { id: string; name: string; voted: boolean }[];
  /** The card's own wording, once revealed (the reader may have reworded it). */
  card_definition?: string | null;
  // Settled round:
  is_final?: boolean;
  reader_bonus?: boolean;
  written_correct?: { name: string; text: string }[];
  abstained?: string[];
  my_result?: {
    round_points: number;
    previous: number;
    total: number;
    items: { category: ScoreCategory; points: number; voters: string[] | null }[];
  };
}

export interface Standing {
  player_id: string;
  name: string;
  total: number;
  last: number;
  rank: number;
}

export interface Award {
  key: 'great_deceiver' | 'lexicographer' | 'master_reader' | 'scholar' | 'convincing_bluff';
  count: number;
  names?: string[];
  bluffs?: { name: string; text: string }[];
}

export interface PlayerStats {
  correct_guesses: number;
  incorrect_guesses: number;
  abstentions: number;
  votes_received: number;
  reader_rounds: number;
  reader_bonuses: number;
  correct_written: number;
  best_bluff_votes: number;
}

export interface Snapshot {
  version: number;
  room: {
    id: string;
    code: string;
    mode: GameMode;
    status: RoomStatus;
    host_player_id: string | null;
    scoring: ScoringMode;
    win_type: WinType;
    target_score: number | null;
    rotation_limit: number | null;
    game_number: number;
  };
  me: { id: string; name: string; is_host: boolean; is_reader: boolean };
  players: PlayerInfo[];
  round: RoundInfo | null;
  // Digital scoring only:
  standings?: Standing[];
  completed_rounds?: number;
  final_rotation?: boolean;
  adjustments?: { name: string; points: number; note: string }[];
  final?: { winners: string[]; awards: Award[]; my_stats: PlayerStats };
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
