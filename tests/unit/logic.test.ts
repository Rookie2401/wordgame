import { describe, expect, it } from 'vitest';
import type { RoundInfo, Snapshot } from '../../src/backend/types';
import {
  codeFromUrl,
  inviteUrl,
  isValidCode,
  letterFor,
  messageFor,
  normalizeCode,
  progress,
  screenFor,
  validateDefinition,
  validateName,
} from '../../src/game/logic';

function snap(over: Omit<Partial<Snapshot>, 'round'> & { round?: Partial<RoundInfo> | null; reader?: boolean }): Snapshot {
  const round: RoundInfo | null =
    over.round === null
      ? null
      : {
          id: 'r1', number: 1, state: 'collecting', reader_id: 'p1', reader_name: 'Ann', word: 'quire',
          card_source: 'physical', eligible: true, required_count: 3, submitted_count: 1, reader_done: false,
          my_submission: null, ...over.round,
        };
  return {
    version: 1,
    room: {
      id: 'room', code: 'ABCDE', mode: 'physical', status: 'playing', host_player_id: 'p1', scoring: 'traditional',
      win_type: 'unlimited', target_score: null, rotation_limit: null, game_number: 1, ...over.room,
    },
    me: { id: 'p2', name: 'Bob', is_host: false, is_reader: !!over.reader },
    players: [],
    round,
  };
}

describe('validation', () => {
  it('rejects blank and over-long definitions', () => {
    expect(validateDefinition('')).not.toBeNull();
    expect(validateDefinition(' \n\t ')).not.toBeNull();
    expect(validateDefinition('x'.repeat(501))).not.toBeNull();
    expect(validateDefinition('x'.repeat(500))).toBeNull();
    expect(validateDefinition('  A kind of hat.  ')).toBeNull();
  });
  it('validates names', () => {
    expect(validateName('  ')).not.toBeNull();
    expect(validateName('x'.repeat(25))).not.toBeNull();
    expect(validateName('Daniel')).toBeNull();
  });
});

describe('codes and links', () => {
  it('normalises typed codes', () => {
    expect(normalizeCode(' ab-c d2!x')).toBe('ABCD2');
    expect(isValidCode('ABCD2')).toBe(true);
    expect(isValidCode('ABCO2')).toBe(false); // O is not in the alphabet
    expect(isValidCode('ABC')).toBe(false);
  });
  it('builds and reads invitation links', () => {
    const url = inviteUrl('HMZVB', 'https://example.github.io/balderdash/');
    expect(url).toBe('https://example.github.io/balderdash/?room=HMZVB');
    expect(codeFromUrl(new URL(url).search)).toBe('HMZVB');
    expect(codeFromUrl('?room=hm-zvb')).toBe('HMZVB');
    expect(codeFromUrl('?other=1')).toBeNull();
    expect(codeFromUrl('?room=<script>')).toBe('SCRIPT');
  });
});

describe('letters', () => {
  it('labels A to Z and beyond', () => {
    expect([1, 2, 26, 27, 28, 52, 53].map(letterFor)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });
});

describe('screen selection', () => {
  it('follows room status', () => {
    expect(screenFor(snap({ room: { status: 'lobby' } as never, round: null }))).toBe('lobby');
    expect(screenFor(snap({ room: { status: 'ended' } as never, round: null }))).toBe('ended');
  });
  it('gives the reader and the players different views at every stage', () => {
    const cases: [RoundInfo['state'], string, string][] = [
      ['card_selection', 'card-reader', 'card-waiting'],
      ['collecting', 'submit-reader', 'submit-player'],
      ['reading', 'reading-reader', 'reading-waiting'],
      ['reveal', 'reveal', 'reveal'],
    ];
    for (const [state, reader, player] of cases) {
      expect(screenFor(snap({ round: { state }, reader: true }))).toBe(reader);
      expect(screenFor(snap({ round: { state } }))).toBe(player);
    }
  });
  it('shows waiting after submitting and sitting-out for late joiners', () => {
    expect(screenFor(snap({ round: { my_submission: 'x' } }))).toBe('submitted');
    expect(screenFor(snap({ round: { eligible: false } }))).toBe('sitting-out');
  });
});

describe('progress and messages', () => {
  it('counts the reader among those expected', () => {
    expect(progress(snap({ round: { submitted_count: 4, required_count: 6, reader_done: true } }))).toEqual({ ready: 5, total: 7 });
    expect(progress(snap({ round: null }))).toEqual({ ready: 0, total: 0 });
  });
  it('has a plain message for every code, known or not', () => {
    expect(messageFor('room_not_found')).toMatch(/ended or expired/);
    expect(messageFor('never_heard_of_it')).toMatch(/went wrong/);
  });
});
