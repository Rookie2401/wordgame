// Pure helpers shared by the screens. The rules themselves are enforced by
// the database; these only decide what to show and catch mistakes early.
import type { Snapshot } from '../backend/types';

export const APP_NAME = 'Balderdash'; // working title; see docs/BRANDING.md
export const MAX_DEFINITION = 500;
export const MAX_NAME = 24;
export const MAX_WORD = 60;
export const MIN_PLAYERS = 3;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

export function validateDefinition(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return 'Please write a definition first.';
  if ([...t].length > MAX_DEFINITION) return `Please keep it under ${MAX_DEFINITION} characters.`;
  return null;
}

export function validateName(name: string): string | null {
  const t = name.trim().replace(/\s+/g, ' ');
  if (t.length === 0) return 'Please enter your name.';
  if ([...t].length > MAX_NAME) return `Please keep your name under ${MAX_NAME} characters.`;
  return null;
}

/** Room codes as typed: upper case, spaces and punctuation dropped. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/** A, B, … Z, AA, AB … for the reading list. */
export function letterFor(position: number): string {
  let n = position;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function inviteUrl(code: string, base: string = location.origin + location.pathname): string {
  return `${base}?room=${encodeURIComponent(code)}`;
}

export function codeFromUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get('room');
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length > 0 ? code.slice(0, 12) : null;
}

export type Screen =
  | 'lobby'
  | 'ended'
  | 'card-reader'
  | 'card-waiting'
  | 'submit-reader'
  | 'submit-player'
  | 'submitted'
  | 'sitting-out'
  | 'adjudicate-reader'
  | 'adjudicate-waiting'
  | 'reading-reader'
  | 'reading-waiting'
  | 'vote-reader'
  | 'vote-ballot'
  | 'vote-waiting'
  | 'reveal-staged'
  | 'results'
  | 'reveal';

/** Which view a player should see, from the authoritative snapshot alone. */
export function screenFor(s: Snapshot): Screen {
  if (s.room.status === 'lobby') return 'lobby';
  if (s.room.status === 'ended' || !s.round) return 'ended';
  const r = s.round;
  const reader = s.me.is_reader;
  switch (r.state) {
    case 'card_selection':
      return reader ? 'card-reader' : 'card-waiting';
    case 'collecting':
      if (reader) return 'submit-reader';
      if (!r.eligible) return 'sitting-out';
      return r.my_submission == null ? 'submit-player' : 'submitted';
    case 'adjudicating':
      return reader ? 'adjudicate-reader' : 'adjudicate-waiting';
    case 'reading':
      return reader ? 'reading-reader' : 'reading-waiting';
    case 'voting':
      if (reader) return 'vote-reader';
      return r.can_vote ? 'vote-ballot' : 'vote-waiting';
    case 'voting_closed':
      return 'reveal-staged';
    case 'reveal':
      return s.room.scoring === 'digital' ? 'reveal-staged' : 'reveal';
    case 'results':
      return 'results';
    default:
      return 'reveal';
  }
}

/** Progress line: everyone expected, the reader included. */
export function progress(s: Snapshot): { ready: number; total: number } {
  const r = s.round;
  if (!r) return { ready: 0, total: 0 };
  return { ready: r.submitted_count + (r.reader_done ? 1 : 0), total: r.required_count + 1 };
}

/** "Daniel", "Daniel and Sarah", "Daniel, Sarah and James". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function points(n: number): string {
  return `${n} ${Math.abs(n) === 1 ? 'point' : 'points'}`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export const TARGET_CHOICES = [15, 25, 50, 100];
export const ROTATION_CHOICES = [1, 2, 3, 5];

/** One line describing how the game ends, for the lobby and the scoreboard. */
export function describeEnding(room: Snapshot['room']): string {
  if (room.win_type === 'target') return `First to ${room.target_score ?? 25} points, then the rotation is finished`;
  if (room.win_type === 'rotations') {
    const n = room.rotation_limit ?? 1;
    return n === 1 ? 'One turn as reader each' : `${n} turns as reader each`;
  }
  return 'Play until the host ends the game';
}

export const CATEGORY_LABEL: Record<string, string> = {
  CORRECT_GUESS: 'Correct Guess',
  SUCCESSFUL_DECEPTION: 'Successful Deception',
  CORRECT_WRITTEN_DEFINITION: 'Correct Written Definition',
  READER_BONUS: 'Reader Bonus',
  MANUAL_ADJUSTMENT: 'Score Adjustment',
};

const MESSAGES: Record<string, string> = {
  voting_closed: 'Voting has closed for this round.',
  not_eligible_to_vote: 'You are not voting in this round.',
  own_definition: 'You cannot vote for your own definition.',
  invalid_definition_id: 'That definition is not on this ballot.',
  voting_not_closed: 'Voting has to close before the answers are revealed.',
  not_ready_to_vote: 'The definitions are not ready yet.',
  cannot_adjudicate_own: 'You cannot mark your own definition.',
  invalid_points: 'Enter a number of points between -100 and 100, not zero.',
  invalid_note: 'Please give a short reason (up to 120 characters).',
  invalid_target: 'Choose a target between 5 and 1000 points.',
  invalid_rotations: 'Choose between 1 and 50 rotations.',
  game_in_progress: 'A game is still in progress.',
  room_not_found: 'That game could not be found. It may have ended or expired.',
  removed_from_room: 'The host has removed you from this game.',
  not_member: 'You are no longer part of this game.',
  room_full: 'This game is full.',
  invalid_name: 'Please enter a name of up to 24 characters.',
  invalid_definition: 'Please write a definition of up to 500 characters.',
  invalid_word: 'Please enter the word (up to 60 characters).',
  need_three_players: 'At least three players are needed to begin.',
  submissions_closed: 'Submissions have closed for this round.',
  not_eligible: 'You will join in from the next round.',
  not_reader: 'Only the reader can do that.',
  not_host: 'Only the host can do that.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
  invalid_rejoin_code: 'That rejoin code is not valid, or has expired.',
  host_still_present: 'The host is still connected.',
  cannot_claim: 'This device is already hosting or reading. Ask the host for help.',
  not_authenticated: 'Your session was lost. Please rejoin the game.',
  game_already_started: 'The game has already started.',
  card_already_confirmed: 'The card has already been confirmed.',
};

export function messageFor(code: string): string {
  return MESSAGES[code] ?? 'Something went wrong. Please try again.';
}
