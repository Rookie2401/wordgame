import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RoundInfo, Snapshot } from '../backend/types';
import { MAX_DEFINITION, MAX_WORD, letterFor, progress, validateDefinition } from '../game/logic';
import { draft, load, save } from '../storage';
import type { RoomHandle } from '../sync/useRoom';
import { Button, Confirm, Flourish, Notice, Page } from './common';

interface Props {
  s: Snapshot;
  round: RoundInfo;
  room: RoomHandle;
}

function RoundHeader({ round, showWord = true }: { round: RoundInfo; showWord?: boolean }) {
  return (
    <header className="round-head">
      <p className="eyebrow" data-testid="round-number">
        Round {round.number}
      </p>
      {showWord && round.word && (
        <h1 className="word" data-testid="word">
          {round.word}
        </h1>
      )}
      <Flourish />
    </header>
  );
}

function Progress({ s }: { s: Snapshot }) {
  const { ready, total } = progress(s);
  return (
    <p className="progress" data-testid="progress" role="status">
      {ready} of {total} players ready.
    </p>
  );
}

/** A text area that keeps the submit button in view above the phone keyboard. */
function DefinitionField(props: {
  value: string;
  onChange(v: string): void;
  label: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const left = MAX_DEFINITION - [...props.value].length;
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <textarea
        ref={ref}
        className="input textarea"
        value={props.value}
        rows={5}
        maxLength={MAX_DEFINITION}
        placeholder={props.placeholder}
        autoComplete="off"
        autoCorrect="on"
        spellCheck
        onFocus={() => setTimeout(() => ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250)}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {left <= 60 && <small className="hint">{left} characters left</small>}
    </label>
  );
}

// ------------------------------------------------------------ card stage --

export function CardWaiting({ round }: Props) {
  return (
    <Page label="Card preparation">
      <RoundHeader round={round} showWord={false} />
      <p className="waiting" data-testid="status">
        {round.reader_name} is preparing the next card.
      </p>
    </Page>
  );
}

export function CardReader({ round, room }: Props) {
  const manual = round.card_source !== 'digital';
  const [word, setWord] = useState('');
  const [definition, setDefinition] = useState('');
  const [error, setError] = useState<string | null>(null);

  function confirm(e: FormEvent) {
    e.preventDefault();
    if (manual) {
      if (!word.trim()) return setError('Please enter the word.');
      const bad = validateDefinition(definition);
      if (bad) return setError('Please enter the correct definition from the card.');
      void room.act('confirm_card', { p_round_id: round.id, p_word: word, p_definition: definition });
    } else {
      void room.act('confirm_card', { p_round_id: round.id });
    }
  }

  return (
    <Page label="Card preparation">
      <header className="round-head">
        <p className="eyebrow" data-testid="round-number">
          Round {round.number}
        </p>
        <h1 className="heading" data-testid="reader-banner">
          You are the Reader.
        </h1>
        <Flourish />
      </header>
      <form className="form" onSubmit={confirm} noValidate>
        {manual ? (
          <>
            {round.card_source === 'manual_fallback' && (
              <Notice>Every word in the dictionary has been played in this game. Please enter a card by hand.</Notice>
            )}
            <p className="lede">Draw a card and enter it here. Only the word will be shown to the others.</p>
            <label className="field">
              <span className="label">Word</span>
              <input
                className="input"
                value={word}
                maxLength={MAX_WORD}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setWord(e.target.value)}
              />
            </label>
            <DefinitionField value={definition} onChange={setDefinition} label="Correct definition" />
          </>
        ) : (
          <article className="card" aria-label="Your card, visible only to you">
            <h2 className="word" data-testid="word">
              {round.word}
            </h2>
            {(round.pronunciation || round.part_of_speech) && (
              <p className="pron">
                {round.pronunciation}
                {round.pronunciation && round.part_of_speech ? ' · ' : ''}
                <em>{round.part_of_speech}</em>
              </p>
            )}
            <p className="definition" data-testid="correct-definition">
              {round.correct_definition}
            </p>
          </article>
        )}
        {error && <Notice tone="warn">{error}</Notice>}
        <div className="stack">
          <Button type="submit" working={room.busy === 'confirm_card'}>
            {manual ? 'Confirm card' : 'Use this card'}
          </Button>
          {!manual && (
            <Button
              variant="secondary"
              working={room.busy === 'replace_card'}
              onClick={() => room.act('replace_card', { p_round_id: round.id })}
            >
              Draw a different card
            </Button>
          )}
        </div>
      </form>
    </Page>
  );
}

// ------------------------------------------------------ submission stage --

function useDraft(roundId: string, initial: string | null) {
  const [text, setText] = useState(() => draft.get(roundId) || initial || '');
  useEffect(() => {
    draft.prune(roundId);
  }, [roundId]);
  return [
    text,
    (v: string) => {
      setText(v);
      draft.set(roundId, v);
    },
  ] as const;
}

export function PlayerSubmit({ s, round, room }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useDraft(round.id, round.my_submission);
  const [error, setError] = useState<string | null>(null);
  const submitted = round.my_submission != null && !editing;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = validateDefinition(text);
    if (bad) return setError(bad);
    setError(null);
    const ok = await room.act('submit_definition', { p_round_id: round.id, p_text: text });
    if (ok) {
      draft.set(round.id, '');
      setEditing(false);
    }
  }

  if (submitted) {
    return (
      <Page label="Waiting">
        <RoundHeader round={round} />
        <p className="confirmed" data-testid="status">
          Definition submitted.
        </p>
        <blockquote className="mine" data-testid="my-submission">
          {round.my_submission}
        </blockquote>
        <Progress s={s} />
        <div className="stack">
          <Button
            variant="secondary"
            onClick={() => {
              setText(round.my_submission ?? '');
              setEditing(true);
            }}
          >
            Edit Submission
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page label="Write your definition">
      <RoundHeader round={round} />
      <form className="form" onSubmit={submit} noValidate>
        <DefinitionField value={text} onChange={setText} label="What do you think this word means?" />
        {error && <Notice tone="warn">{error}</Notice>}
        {room.busy === 'submit_definition' && <p className="hint center">Sending your definition…</p>}
        <div className="stack">
          <Button type="submit" working={room.busy === 'submit_definition'}>
            {editing ? 'Save Definition' : 'Submit Definition'}
          </Button>
          {editing && (
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Keep what I had
            </Button>
          )}
        </div>
      </form>
    </Page>
  );
}

export function SittingOut({ round }: Props) {
  return (
    <Page label="Waiting for the next round">
      <RoundHeader round={round} />
      <p className="waiting" data-testid="status">
        This round is already under way. You will join in from the next one.
      </p>
    </Page>
  );
}

export function ReaderSubmit({ s, round, room }: Props) {
  const [text, setText] = useDraft(round.id, round.my_submission);
  const [editing, setEditing] = useState(round.my_submission == null && !round.reader_skipped);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const done = new Set(round.submitted_player_ids ?? []);
  const expected = s.players.filter((p) => p.id !== round.reader_id);
  const { ready, total } = progress(s);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = validateDefinition(text);
    if (bad) return setError(bad);
    setError(null);
    const ok = await room.act('submit_definition', { p_round_id: round.id, p_text: text });
    if (ok) {
      draft.set(round.id, '');
      setEditing(false);
    }
  }

  async function skip() {
    setError(null);
    if (await room.act('reader_skip', { p_round_id: round.id })) setEditing(false);
  }

  return (
    <Page label="Reader: collecting definitions">
      <RoundHeader round={round} />
      <article className="card" aria-label="Correct definition, visible only to you">
        <p className="card-label">Correct definition — for your eyes only</p>
        {round.pronunciation && <p className="pron">{round.pronunciation}</p>}
        <p className="definition" data-testid="correct-definition">
          {round.correct_definition}
        </p>
      </article>

      {editing ? (
        <form className="form" onSubmit={submit} noValidate>
          <DefinitionField
            value={text}
            onChange={setText}
            label="Your own false definition (optional)"
            placeholder="Invent a convincing meaning, or skip."
          />
          {error && <Notice tone="warn">{error}</Notice>}
          <div className="stack">
            <Button type="submit" working={room.busy === 'submit_definition'}>
              Submit Definition
            </Button>
            <Button variant="secondary" working={room.busy === 'reader_skip'} onClick={skip}>
              Skip
            </Button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <p className="confirmed" data-testid="reader-status">
            {round.my_submission != null ? 'Your false definition is in.' : 'You are not adding a definition.'}
          </p>
          <Button variant="quiet" onClick={() => setEditing(true)}>
            {round.my_submission != null ? 'Edit my definition' : 'Write one after all'}
          </Button>
        </div>
      )}

      <section aria-label="Submission progress">
        <Progress s={s} />
        <ul className="roster">
          {expected.map((p) => (
            <li key={p.id} className={done.has(p.id) ? 'roster-done' : 'roster-wait'}>
              <span aria-hidden="true">{done.has(p.id) ? '✓' : '…'}</span> {p.name}
              <span className="sr-only">{done.has(p.id) ? ' has submitted' : ' is still writing'}</span>
              {!p.connected && <em className="tag">away</em>}
            </li>
          ))}
        </ul>
      </section>

      <div className="stack">
        <Button variant="secondary" working={room.busy === 'close_submissions'} onClick={() => setClosing(true)}>
          Close Submissions
        </Button>
      </div>
      <Confirm
        open={closing}
        title="Close submissions?"
        body={
          ready < total
            ? 'Not everyone has finished. Anyone still writing will be left out of this round.'
            : 'Everyone is ready. Move on to reading.'
        }
        confirmLabel="Close Submissions"
        onCancel={() => setClosing(false)}
        onConfirm={() => {
          setClosing(false);
          void room.act('close_submissions', { p_round_id: round.id });
        }}
      />
    </Page>
  );
}

// --------------------------------------------------------- reading stage --

export function ReadingWaiting({ round }: Props) {
  return (
    <Page label="Reading">
      <RoundHeader round={round} />
      <p className="waiting" data-testid="status">
        The reader is presenting the definitions.
      </p>
      <p className="hint center">Listen, then vote aloud.</p>
    </Page>
  );
}

export function ReadingReader({ round, room }: Props) {
  const defs = round.definitions ?? [];
  const [single, setSingle] = useState(() => load<boolean>('reading.single') ?? false);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const i = Math.min(index, Math.max(defs.length - 1, 0));

  function layout(one: boolean) {
    setSingle(one);
    save('reading.single', one);
  }

  return (
    <Page label="Reader: read the definitions aloud">
      <RoundHeader round={round} />
      <div className="toggle" role="group" aria-label="Reading layout">
        <button className={!single ? 'toggle-on' : ''} aria-pressed={!single} onClick={() => layout(false)}>
          All together
        </button>
        <button className={single ? 'toggle-on' : ''} aria-pressed={single} onClick={() => layout(true)}>
          One at a time
        </button>
      </div>

      {single ? (
        <section className="reading-one" aria-live="polite">
          {defs[i] && (
            <p className="reading-item" data-testid="definition">
              <span className="letter">{letterFor(defs[i].position)}.</span> {defs[i].text}
            </p>
          )}
          <div className="row">
            <Button variant="secondary" disabled={i === 0} onClick={() => setIndex(i - 1)}>
              Previous
            </Button>
            <span className="meta" aria-label={`Definition ${i + 1} of ${defs.length}`}>
              {i + 1} / {defs.length}
            </span>
            <Button variant="secondary" disabled={i >= defs.length - 1} onClick={() => setIndex(i + 1)}>
              Next
            </Button>
          </div>
        </section>
      ) : (
        <ol className="reading-list">
          {defs.map((d) => (
            <li key={d.id} className="reading-item" data-testid="definition">
              <span className="letter">{letterFor(d.position)}.</span> {d.text}
            </li>
          ))}
        </ol>
      )}

      <p className="hint center">Read each aloud, take the votes, then reveal.</p>
      <div className="stack">
        <Button working={room.busy === 'reveal_answers'} onClick={() => setConfirming(true)}>
          Reveal Answers
        </Button>
      </div>
      <Confirm
        open={confirming}
        title="Reveal the answers?"
        body="Everyone will see which definition is correct and who wrote the others. This cannot be undone."
        confirmLabel="Reveal Answers"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void room.act('reveal_answers', { p_round_id: round.id });
        }}
      />
    </Page>
  );
}

// ---------------------------------------------------------------- reveal --

export function Reveal({ s, round, room }: Props) {
  const defs = round.definitions ?? [];
  const mayAdvance = s.me.is_reader || s.me.is_host;
  return (
    <Page label="Answers revealed">
      <RoundHeader round={round} />
      <ol className="reading-list">
        {defs.map((d) => (
          <li
            key={d.id}
            className={`reading-item ${d.is_correct ? 'correct' : ''}`}
            data-testid="revealed"
            data-correct={d.is_correct ? 'true' : 'false'}
          >
            <span className="letter">{letterFor(d.position)}.</span> {d.text}
            <span className="attribution">
              {d.is_correct
                ? 'Correct Definition.'
                : d.by_reader
                  ? 'Submitted by the Reader.'
                  : `Submitted by ${d.author_name ?? 'a player who has left'}.`}
            </span>
          </li>
        ))}
      </ol>
      <div className="stack">
        {mayAdvance ? (
          <>
            <p className="hint center">Once the scores are on paper:</p>
            <Button working={room.busy === 'next_round'} onClick={() => room.act('next_round', { p_round_id: round.id })}>
              Next Round
            </Button>
          </>
        ) : (
          <p className="waiting">Mark your scores. {round.reader_name} will begin the next round.</p>
        )}
      </div>
    </Page>
  );
}
