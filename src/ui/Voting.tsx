// Screens for rooms that vote and score in the app: the reader's check of
// written definitions, the private ballot, the reader's voting dashboard, the
// staged reveal and the settled round.
import { useState, type ReactNode } from 'react';
import type { DefinitionItem, RoundInfo, Snapshot } from '../backend/types';
import { CATEGORY_LABEL, letterFor, listNames, points, signed } from '../game/logic';
import type { RoomHandle } from '../sync/useRoom';
import { Button, Confirm, Flourish, Notice, Page } from './common';
import { StandingsList } from './Scores';

interface Props {
  s: Snapshot;
  round: RoundInfo;
  room: RoomHandle;
}

function Head({ round }: { round: RoundInfo }) {
  return (
    <header className="round-head">
      <p className="eyebrow" data-testid="round-number">
        Round {round.number}
      </p>
      {round.word && (
        <h1 className="word" data-testid="word">
          {round.word}
        </h1>
      )}
      <Flourish />
    </header>
  );
}

// --------------------------------------------------------- adjudication --

export function AdjudicateWaiting({ round }: Props) {
  return (
    <Page label="The reader is checking the definitions">
      <Head round={round} />
      <p className="waiting" data-testid="status">
        {round.reader_name} is looking over the definitions.
      </p>
    </Page>
  );
}

export function AdjudicateReader({ round, room }: Props) {
  const items = round.adjudication ?? [];
  const [asking, setAsking] = useState<string | null>(null);
  const chosen = items.find((i) => i.submission_id === asking);
  const accepted = items.filter((i) => i.correct).length;

  return (
    <Page label="Reader: check for correct definitions">
      <Head round={round} />
      <article className="card" aria-label="Correct definition, visible only to you">
        <p className="card-label">Correct definition — for your eyes only</p>
        <p className="definition" data-testid="correct-definition">
          {round.correct_definition}
        </p>
      </article>
      <p className="lede">
        Did anyone write the real meaning? Mark any definition that is substantially correct. Its writer earns three
        points and it is left off the ballot.
      </p>
      <ul className="reading-list adjudication" aria-label="Submitted definitions, without names">
        {items.map((i) => (
          <li key={i.submission_id} className={`ballot-item ${i.correct ? 'ballot-on' : ''}`} data-testid="adjudicable">
            <p className="ballot-text">{i.text}</p>
            {i.correct ? (
              <div className="ballot-foot">
                <span className="attribution correct-mark">Accepted as correct.</span>
                <button
                  className="link"
                  onClick={() =>
                    room.act('adjudicate', { p_round_id: round.id, p_submission_id: i.submission_id, p_correct: false })
                  }
                >
                  Undo
                </button>
              </div>
            ) : (
              <button className="link" onClick={() => setAsking(i.submission_id)}>
                This is correct
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="stack">
        <Button
          working={room.busy === 'finish_adjudication'}
          onClick={() => room.act('finish_adjudication', { p_round_id: round.id })}
        >
          {accepted === 0 ? 'None are correct — continue' : 'Continue to reading'}
        </Button>
      </div>
      <Confirm
        open={!!chosen}
        title="Accept as correct?"
        body={`“${chosen?.text ?? ''}” — its writer will earn three points, will not vote this round, and the definition will not be read out.`}
        confirmLabel="Accept as correct"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          void room.act('adjudicate', { p_round_id: round.id, p_submission_id: asking, p_correct: true });
          setAsking(null);
        }}
      />
    </Page>
  );
}

// --------------------------------------------------------------- voting --

function VoteProgress({ round }: { round: RoundInfo }) {
  return (
    <p className="progress" data-testid="vote-progress" role="status">
      {round.votes_cast ?? 0} of {round.voters_total ?? 0} players have voted.
    </p>
  );
}

export function VoteBallot({ round, room }: Props) {
  const defs = round.definitions ?? [];
  const [choice, setChoice] = useState<string | null>(round.my_vote ?? null);
  const [changing, setChanging] = useState(false);
  const voted = round.my_vote != null && !changing;
  const open = round.state === 'voting';

  async function cast() {
    if (!choice) return;
    if (await room.act('cast_vote', { p_round_id: round.id, p_definition_id: choice })) setChanging(false);
  }

  return (
    <Page label="Your ballot">
      <Head round={round} />
      {voted ? (
        <p className="confirmed" data-testid="status">
          Vote submitted.
        </p>
      ) : (
        <p className="lede">Which is the real definition?</p>
      )}
      <div className="reading-list" role="radiogroup" aria-label="Definitions">
        {defs.map((d) => {
          const selected = (voted ? round.my_vote : choice) === d.id;
          return (
            <label
              key={d.id}
              className={`ballot-item ${selected ? 'ballot-on' : ''} ${d.mine ? 'ballot-mine' : ''}`}
              data-testid="ballot-option"
            >
              <input
                type="radio"
                name="ballot"
                className="sr-only"
                checked={selected}
                disabled={d.mine || voted || !open}
                onChange={() => setChoice(d.id)}
              />
              <span className="ballot-text">
                <span className="letter">{letterFor(d.position)}.</span> {d.text}
              </span>
              {d.mine && <span className="attribution">Your definition</span>}
              {selected && voted && <span className="attribution correct-mark">Your vote</span>}
            </label>
          );
        })}
      </div>
      <VoteProgress round={round} />
      <div className="stack">
        {!open ? (
          <p className="waiting">Voting is closed. {round.reader_name} will reveal the answers.</p>
        ) : voted ? (
          <Button
            variant="secondary"
            onClick={() => {
              setChoice(round.my_vote ?? null);
              setChanging(true);
            }}
          >
            Change my vote
          </Button>
        ) : (
          <>
            <Button disabled={!choice} working={room.busy === 'cast_vote'} onClick={cast}>
              Cast Vote
            </Button>
            {changing && (
              <Button variant="quiet" onClick={() => setChanging(false)}>
                Keep my vote
              </Button>
            )}
          </>
        )}
      </div>
    </Page>
  );
}

export function VoteWaiting({ round }: Props) {
  return (
    <Page label="Voting">
      <Head round={round} />
      <p className="waiting" data-testid="status">
        {round.state === 'voting' ? 'The others are voting.' : 'Voting is closed.'} You are not voting in this round.
      </p>
      <VoteProgress round={round} />
    </Page>
  );
}

export function VoteReader({ round, room }: Props) {
  const voters = round.voters ?? [];
  const [closing, setClosing] = useState(false);
  const waiting = voters.filter((v) => !v.voted).length;

  return (
    <Page label="Reader: voting in progress">
      <Head round={round} />
      <h2 className="heading">Voting in Progress</h2>
      <VoteProgress round={round} />
      <progress
        className="bar"
        max={Math.max(round.voters_total ?? 0, 1)}
        value={round.votes_cast ?? 0}
        aria-label="Votes received"
      />
      <ul className="roster" aria-label="Voters">
        {voters.map((v) => (
          <li key={v.id} className={v.voted ? 'roster-done' : 'roster-wait'} data-testid="voter">
            {v.name} — {v.voted ? 'Voted' : 'Waiting'}
          </li>
        ))}
      </ul>
      <div className="stack">
        <Button
          variant="secondary"
          working={room.busy === 'close_voting'}
          onClick={() => (waiting > 0 ? setClosing(true) : room.act('close_voting', { p_round_id: round.id }))}
        >
          Close Voting
        </Button>
      </div>
      <Confirm
        open={closing}
        title="Close voting?"
        body={`${waiting} ${waiting === 1 ? 'player has' : 'players have'} not voted yet. Anyone who has not voted will be counted as abstaining.`}
        confirmLabel="Close Voting"
        onCancel={() => setClosing(false)}
        onConfirm={() => {
          setClosing(false);
          void room.act('close_voting', { p_round_id: round.id });
        }}
      />
    </Page>
  );
}

// --------------------------------------------------------------- reveal --

function RevealedItem(props: { d: DefinitionItem; round: RoundInfo; showPoints: boolean; children?: ReactNode }) {
  const { d, round, showPoints } = props;
  const stage = d.stage ?? (round.state === 'results' ? 2 : 0);
  const voters = d.voters ?? [];
  const known = stage >= 2;
  return (
    <li
      className={`reading-item ${known && d.is_correct ? 'correct' : ''}`}
      data-testid="revealed"
      data-stage={stage}
      data-correct={known ? String(!!d.is_correct) : 'unknown'}
    >
      <span className="letter">{letterFor(d.position)}.</span> {d.text}
      {d.mine && <span className="attribution">Your definition</span>}
      {round.my_vote === d.id && <span className="attribution">Your vote</span>}
      {stage >= 1 && (
        <span className="attribution" data-testid="voted-by">
          {voters.length ? `Voted for by ${listNames(voters)}.` : 'No votes.'}
        </span>
      )}
      {known && (
        <span className="attribution verdict">
          {d.is_correct
            ? 'Correct definition.'
            : d.by_reader
              ? `Written by ${d.author_name ?? 'the Reader'}, the Reader.`
              : `Written by ${d.author_name ?? 'a player who has left'}.`}
        </span>
      )}
      {known && showPoints && voters.length > 0 && (
        <span className="attribution earned">
          {d.is_correct
            ? `${listNames(voters)} ${voters.length === 1 ? 'earns' : 'each earn'} two points.`
            : d.author_name
              ? `${d.author_name} earns ${points(voters.length)}.`
              : ''}
        </span>
      )}
      {props.children}
    </li>
  );
}

/** Voting has closed; the reader reveals as much or as little at a time as they like. */
export function RevealStaged({ s, round, room }: Props) {
  const defs = round.definitions ?? [];
  const reader = s.me.is_reader;
  const [confirming, setConfirming] = useState(false);
  const started = round.state === 'reveal';

  if (!reader && defs.length === 0) {
    return (
      <Page label="Voting is closed">
        <Head round={round} />
        <p className="waiting" data-testid="status">
          Voting is closed. {round.reader_name} will reveal the answers.
        </p>
      </Page>
    );
  }

  return (
    <Page label={reader ? 'Reader: reveal the answers' : 'The answers are being revealed'}>
      <Head round={round} />
      {!started && (
        <p className="confirmed" data-testid="status">
          Voting is closed.
        </p>
      )}
      {reader && (
        <p className="hint center">
          Reveal one step at a time — first who voted, then who wrote it — or all at once. Keep the real one for last
          if you like.
        </p>
      )}
      <ol className="reading-list">
        {defs.map((d) => (
          <RevealedItem key={d.id} d={d} round={round} showPoints={false}>
            {reader && (d.stage ?? 0) < 2 && (
              <button
                className="link reveal-step"
                data-testid="reveal-step"
                onClick={() => room.act('reveal_step', { p_round_id: round.id, p_definition_id: d.id })}
              >
                {(d.stage ?? 0) === 0 ? `Show who voted for ${letterFor(d.position)}` : `Show who wrote ${letterFor(d.position)}`}
              </button>
            )}
          </RevealedItem>
        ))}
      </ol>
      {reader ? (
        <div className="stack">
          <Button working={room.busy === 'reveal_answers'} onClick={() => setConfirming(true)}>
            Reveal Answers
          </Button>
        </div>
      ) : (
        <p className="waiting">{round.reader_name} is revealing the answers…</p>
      )}
      <Confirm
        open={confirming}
        title="Reveal everything?"
        body="Everyone will see every vote, every author and the correct definition, and the points will be awarded."
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

// -------------------------------------------------------------- results --

const EXPLAIN: Record<string, (voters: string[] | null) => string> = {
  CORRECT_GUESS: () => 'You identified the genuine definition.',
  SUCCESSFUL_DECEPTION: (v) => (v && v.length ? `${listNames(v)} voted for your definition.` : 'Your definition drew votes.'),
  CORRECT_WRITTEN_DEFINITION: () => 'You wrote the correct definition yourself.',
  READER_BONUS: () => 'Nobody found the genuine definition.',
  MANUAL_ADJUSTMENT: () => 'Adjusted by the host.',
};

export function Results({ s, round, room }: Props) {
  const defs = round.definitions ?? [];
  const mine = round.my_result;
  const mayAdvance = s.me.is_reader || s.me.is_host;
  const written = round.written_correct ?? [];
  const abstained = round.abstained ?? [];

  return (
    <Page label="Round results">
      <Head round={round} />

      {mine && (
        <section className="card result" aria-label="Your results">
          <p className="card-label">Your Results</p>
          <p className="result-points" data-testid="round-points">
            {signed(mine.round_points)} {Math.abs(mine.round_points) === 1 ? 'Point' : 'Points'}
          </p>
          {mine.items.map((i) => (
            <div key={i.category} className="result-line" data-testid="result-item">
              <p>
                <strong>
                  {CATEGORY_LABEL[i.category]}: {signed(i.points)}
                </strong>
              </p>
              <p className="hint">{EXPLAIN[i.category]?.(i.voters)}</p>
            </div>
          ))}
          {mine.items.length === 0 && <p className="hint">No points this round.</p>}
          <p className="result-totals">
            Previous Score: {mine.previous} · Total Score: <strong data-testid="my-total">{mine.total}</strong>
          </p>
        </section>
      )}

      <ol className="reading-list">
        {defs.map((d) => (
          <RevealedItem key={d.id} d={d} round={round} showPoints />
        ))}
      </ol>

      {(written.length > 0 || round.reader_bonus || abstained.length > 0) && (
        <section className="stack" aria-label="Also this round">
          {written.map((w) => (
            <Notice key={w.name}>
              {w.name} wrote the correct definition and earns three points: “{w.text}”
            </Notice>
          ))}
          {round.reader_bonus && (
            <Notice>Nobody found the genuine definition: {round.reader_name} earns the reader’s bonus of three points.</Notice>
          )}
          {abstained.length > 0 && <p className="hint center">{listNames(abstained)} did not vote.</p>}
        </section>
      )}

      <section aria-label="Standings">
        <h2 className="subheading">Standings after round {s.completed_rounds ?? round.number}</h2>
        <StandingsList s={s} />
      </section>

      <div className="stack">
        {mayAdvance ? (
          <Button working={room.busy === 'next_round'} onClick={() => room.act('next_round', { p_round_id: round.id })}>
            {round.is_final ? 'Finish the Game' : 'Next Round'}
          </Button>
        ) : (
          <p className="waiting">
            {round.is_final
              ? `That was the last round. ${round.reader_name} will bring up the final results.`
              : `${round.reader_name} will begin the next round.`}
          </p>
        )}
      </div>
    </Page>
  );
}
