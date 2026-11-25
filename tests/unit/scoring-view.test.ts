import { describe, expect, it } from 'vitest';
import type { RoundInfo, Snapshot } from '../../src/backend/types';
import { describeEnding, listNames, messageFor, points, screenFor, signed } from '../../src/game/logic';
import { DEFAULT_RULES, rulesArgs, rulesFromRoom, validateRules } from '../../src/ui/Settings';

function snap(state: RoundInfo['state'], opts: { reader?: boolean; canVote?: boolean; scoring?: 'digital' | 'traditional' } = {}): Snapshot {
  return {
    version: 1,
    room: {
      id: 'room', code: 'ABCDE', mode: 'physical', status: 'playing', host_player_id: 'p1',
      scoring: opts.scoring ?? 'digital', win_type: 'target', target_score: 25, rotation_limit: null, game_number: 1,
    },
    me: { id: 'p2', name: 'Bob', is_host: false, is_reader: !!opts.reader },
    players: [],
    round: {
      id: 'r1', number: 1, state, reader_id: 'p1', reader_name: 'Ann', word: 'quire', card_source: 'physical',
      eligible: true, required_count: 3, submitted_count: 3, reader_done: true, my_submission: 'x',
      can_vote: opts.canVote,
    },
  };
}

describe('screens for a scored round', () => {
  it('gives reader, voter and bystander their own view of each stage', () => {
    expect(screenFor(snap('adjudicating', { reader: true }))).toBe('adjudicate-reader');
    expect(screenFor(snap('adjudicating'))).toBe('adjudicate-waiting');
    expect(screenFor(snap('voting', { reader: true }))).toBe('vote-reader');
    expect(screenFor(snap('voting', { canVote: true }))).toBe('vote-ballot');
    expect(screenFor(snap('voting', { canVote: false }))).toBe('vote-waiting');
    expect(screenFor(snap('voting_closed', { canVote: true }))).toBe('reveal-staged');
    expect(screenFor(snap('reveal'))).toBe('reveal-staged');
    expect(screenFor(snap('results'))).toBe('results');
  });
  it('keeps the original reveal screen for traditional rooms', () => {
    expect(screenFor(snap('reveal', { scoring: 'traditional' }))).toBe('reveal');
    expect(screenFor(snap('reading', { scoring: 'traditional', reader: true }))).toBe('reading-reader');
  });
});

describe('wording', () => {
  it('lists names the way they are read aloud', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Daniel'])).toBe('Daniel');
    expect(listNames(['Daniel', 'Sarah'])).toBe('Daniel and Sarah');
    expect(listNames(['Daniel', 'Sarah', 'James'])).toBe('Daniel, Sarah and James');
  });
  it('formats points', () => {
    expect([points(1), points(3), points(0), points(-1)]).toEqual(['1 point', '3 points', '0 points', '-1 point']);
    expect([signed(5), signed(0), signed(-2)]).toEqual(['+5', '0', '-2']);
  });
  it('describes how the game ends', () => {
    const room = snap('voting').room;
    expect(describeEnding(room)).toMatch(/First to 25 points/);
    expect(describeEnding({ ...room, win_type: 'rotations', rotation_limit: 1 })).toBe('One turn as reader each');
    expect(describeEnding({ ...room, win_type: 'rotations', rotation_limit: 3 })).toBe('3 turns as reader each');
    expect(describeEnding({ ...room, win_type: 'unlimited' })).toMatch(/host ends/);
  });
  it('has plain messages for the new refusals', () => {
    for (const c of ['voting_closed', 'own_definition', 'not_eligible_to_vote', 'invalid_points', 'invalid_note']) {
      expect(messageFor(c)).not.toMatch(/went wrong/);
    }
  });
});

describe('game options', () => {
  it('defaults to voting in the app with a target of 25', () => {
    expect(DEFAULT_RULES).toMatchObject({ scoring: 'digital', winType: 'target', target: 25 });
    expect(rulesArgs(DEFAULT_RULES)).toEqual({
      p_mode: 'digital', p_scoring: 'digital', p_win_type: 'target', p_target: 25, p_rotations: null,
    });
  });
  it('a traditional game cannot have a target score', () => {
    expect(rulesArgs({ ...DEFAULT_RULES, scoring: 'traditional' })).toMatchObject({ p_win_type: 'unlimited', p_target: null });
  });
  it('validates custom numbers', () => {
    expect(validateRules({ ...DEFAULT_RULES, target: 4 })).not.toBeNull();
    expect(validateRules({ ...DEFAULT_RULES, target: NaN })).not.toBeNull();
    expect(validateRules({ ...DEFAULT_RULES, target: 60 })).toBeNull();
    expect(validateRules({ ...DEFAULT_RULES, winType: 'rotations', rotations: 0 })).not.toBeNull();
    expect(validateRules({ ...DEFAULT_RULES, winType: 'rotations', rotations: 4 })).toBeNull();
  });
  it('reads the options back from a room', () => {
    expect(rulesFromRoom({ ...snap('voting').room, win_type: 'rotations', rotation_limit: 3 })).toMatchObject({
      winType: 'rotations', rotations: 3, target: 25,
    });
  });
});
