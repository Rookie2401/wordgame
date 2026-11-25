// The reader does not write a bluff. What the reader submits is the real
// definition in their own words, and it takes the card definition's place.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, newDb, scoredTable, table, toCollecting, type TestDb } from './helpers';

let db: TestDb;
beforeAll(async () => {
  db = await newDb();
});
afterAll(() => db.close());

const CARD = 'CARD-WORDING of the definition.';
const OWN = 'The same meaning, as the reader puts it.';

describe('the reader’s wording', () => {
  it('replaces the card’s wording on the ballot, is the correct answer, and earns the reader nothing by itself', async () => {
    const t = await scoredTable(db, 4);
    let s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round.id;
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: CARD });
    for (const i of [1, 2, 3]) await t.as(i, 'submit_definition', { p_round_id: rid, p_text: `bluff ${i}` });
    s = await t.as(0, 'submit_definition', { p_round_id: rid, p_text: OWN });
    // The reader's own text is not offered for adjudication; the card's wording is still what they compare against.
    expect(s.round.state).toBe('adjudicating');
    expect(s.round.adjudication.map((a: any) => a.text).sort()).toEqual(['bluff 1', 'bluff 2', 'bluff 3']);
    expect(s.round.correct_definition).toBe(CARD);
    s = await t.as(0, 'finish_adjudication', { p_round_id: rid });
    expect(s.round.definitions.map((d: any) => d.text).sort()).toEqual([OWN, 'bluff 1', 'bluff 2', 'bluff 3'].sort());

    await t.as(0, 'open_voting', { p_round_id: rid });
    const ballot: any = await t.state(1);
    // Voters see the reader's wording as an ordinary entry and never the card's.
    expect(JSON.stringify(ballot)).not.toContain('CARD-WORDING');
    expect(ballot.round.card_definition).toBeUndefined();
    const idOf = (text: string) => ballot.round.definitions.find((d: any) => d.text === text).id;
    await t.as(1, 'cast_vote', { p_round_id: rid, p_definition_id: idOf(OWN) });
    await t.as(2, 'cast_vote', { p_round_id: rid, p_definition_id: idOf('bluff 1') });
    await t.as(3, 'cast_vote', { p_round_id: rid, p_definition_id: idOf(OWN) });
    // Still hidden while the reveal is under way.
    await t.as(0, 'reveal_step', { p_round_id: rid, p_definition_id: idOf('bluff 1') });
    expect(JSON.stringify(await t.state(2))).not.toContain('CARD-WORDING');

    s = await t.as(0, 'reveal_answers', { p_round_id: rid });
    const own = s.round.definitions.find((d: any) => d.text === OWN);
    expect(own).toMatchObject({ is_correct: true, author_id: null, by_reader: false, voters: ['P2', 'P4'] });
    expect(s.round.definitions.filter((d: any) => d.is_correct)).toHaveLength(1);
    expect(s.round.card_definition).toBe(CARD);
    expect(((await t.state(2)) as any).round.card_definition).toBe(CARD);
    // P2 and P4 found the genuine definition; P2 also fooled P3. The reader scores nothing.
    const totals = Object.fromEntries(s.standings.map((x: any) => [x.name, x.total]));
    expect(totals).toEqual({ P1: 0, P2: 3, P3: 0, P4: 2 });
    const cats = await db.admin(`select distinct category from public.score_events where round_id = $1 order by 1`, [rid]);
    expect(cats.map((c) => c.category)).toEqual(['CORRECT_GUESS', 'SUCCESSFUL_DECEPTION']);
  });

  it('the reader still earns the bonus when their wording fools everyone', async () => {
    const t = await scoredTable(db, 3);
    let s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round.id;
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: CARD });
    await t.as(1, 'submit_definition', { p_round_id: rid, p_text: 'bluff 1' });
    await t.as(2, 'submit_definition', { p_round_id: rid, p_text: 'bluff 2' });
    await t.as(0, 'submit_definition', { p_round_id: rid, p_text: OWN });
    await t.as(0, 'finish_adjudication', { p_round_id: rid });
    await t.as(0, 'open_voting', { p_round_id: rid });
    const b: any = await t.state(1);
    const idOf = (text: string) => b.round.definitions.find((d: any) => d.text === text).id;
    await t.as(1, 'cast_vote', { p_round_id: rid, p_definition_id: idOf('bluff 2') });
    await t.as(2, 'cast_vote', { p_round_id: rid, p_definition_id: idOf('bluff 1') });
    s = await t.as(0, 'reveal_answers', { p_round_id: rid });
    expect(s.round.reader_bonus).toBe(true);
    expect(s.round.my_result).toMatchObject({ round_points: 3, items: [{ category: 'READER_BONUS', points: 3 }] });
  });

  it('skipping keeps the card’s wording, and card_definition then simply repeats it', async () => {
    const t = await scoredTable(db, 3);
    let s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round.id;
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: CARD });
    await t.as(1, 'submit_definition', { p_round_id: rid, p_text: 'bluff 1' });
    await t.as(2, 'submit_definition', { p_round_id: rid, p_text: 'bluff 2' });
    await t.as(0, 'reader_skip', { p_round_id: rid });
    s = await t.as(0, 'finish_adjudication', { p_round_id: rid });
    expect(s.round.definitions.map((d: any) => d.text)).toContain(CARD);
    // A reader who first reworded and then chose the card's wording gets the card's wording.
  });

  it('choosing the card’s wording after rewording discards the rewording', async () => {
    const t = await scoredTable(db, 3);
    let s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round.id;
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: CARD });
    await t.as(0, 'submit_definition', { p_round_id: rid, p_text: OWN });
    await t.as(0, 'reader_skip', { p_round_id: rid });
    await t.as(1, 'submit_definition', { p_round_id: rid, p_text: 'bluff 1' });
    s = await t.as(2, 'submit_definition', { p_round_id: rid, p_text: 'bluff 2' });
    s = await t.as(0, 'finish_adjudication', { p_round_id: rid });
    expect(s.round.definitions.map((d: any) => d.text).sort()).toEqual([CARD, 'bluff 1', 'bluff 2'].sort());
  });

  it('works the same in a traditional room', async () => {
    const t = await table(db, 3);
    const { roundId } = await toCollecting(t, 'w', CARD);
    await t.as(1, 'submit_definition', { p_round_id: roundId, p_text: 'bluff 1' });
    await t.as(2, 'submit_definition', { p_round_id: roundId, p_text: 'bluff 2' });
    let s: any = await t.as(0, 'submit_definition', { p_round_id: roundId, p_text: OWN });
    expect(s.round.state).toBe('reading');
    expect(s.round.definitions.map((d: any) => d.text).sort()).toEqual([OWN, 'bluff 1', 'bluff 2'].sort());
    expect(JSON.stringify(await t.state(1))).not.toContain('CARD-WORDING');
    await t.as(0, 'reveal_answers', { p_round_id: roundId });
    s = await t.state(2);
    expect(s.round.definitions.find((d: any) => d.is_correct).text).toBe(OWN);
    expect(s.round.card_definition).toBe(CARD);
  });

  it('a change of reader before the shuffle discards both readers’ texts, so no guess is read out as the answer', async () => {
    const t = await scoredTable(db, 4);
    let s: any = await t.as(0, 'start_game', { p_room_id: t.roomId });
    const rid = s.round.id;
    await t.as(0, 'confirm_card', { p_round_id: rid, p_word: 'w', p_definition: CARD });
    await t.as(0, 'submit_definition', { p_round_id: rid, p_text: OWN }); // outgoing reader's rewording
    await t.as(1, 'submit_definition', { p_round_id: rid, p_text: 'P2 guessed before becoming reader' });
    await t.as(2, 'submit_definition', { p_round_id: rid, p_text: 'bluff 3' });
    await t.as(0, 'set_reader', { p_room_id: t.roomId, p_player_id: t.ids[1] });
    expect(await db.admin(`select body from public.submissions where round_id = $1 order by body`, [rid])).toEqual([{ body: 'bluff 3' }]);
    expect(await code(t.as(0, 'submit_definition', { p_round_id: rid, p_text: 'x' }))).toBe('not_eligible');
    await t.as(3, 'submit_definition', { p_round_id: rid, p_text: 'bluff 4' });
    await t.as(1, 'reader_skip', { p_round_id: rid });
    s = await t.as(1, 'finish_adjudication', { p_round_id: rid });
    expect(s.round.definitions.map((d: any) => d.text).sort()).toEqual([CARD, 'bluff 3', 'bluff 4'].sort());
  });
});
