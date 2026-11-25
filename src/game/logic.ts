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
  | 'reading-reader'
  | 'reading-waiting'
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
    case 'reading':
      return reader ? 'reading-reader' : 'reading-waiting';
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

const MESSAGES: Record<string, string> = {
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
