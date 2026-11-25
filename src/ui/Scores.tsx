// Standings, the scoreboard dialog and the end-of-game screen.
import type { Award, Snapshot } from '../backend/types';
import { describeEnding, listNames, signed } from '../game/logic';
import type { RoomHandle } from '../sync/useRoom';
import { Button, Dialog, Flourish, Page } from './common';

function Crown() {
  return (
    <svg className="crown" viewBox="0 0 24 16" role="img" aria-label="Leader">
      <path d="M2 14h20l1.5-10-5.5 4.5L12 1 6 8.5.5 4z" fill="currentColor" />
    </svg>
  );
}

/** Ranked list. Equal scores share a rank; nobody is placed above an equal. */
export function StandingsList({ s, final = false }: { s: Snapshot; final?: boolean }) {
  const rows = s.standings ?? [];
  const anyPoints = rows.some((r) => r.total !== 0);
  return (
    <ol className="standings" data-testid="standings">
      {rows.map((r) => (
        <li
          key={r.player_id}
          className={`standing ${r.rank === 1 && anyPoints ? 'standing-lead' : ''}`}
          data-testid="standing"
        >
          <span className="standing-rank" aria-label={`Rank ${r.rank}`}>
            {r.rank}
          </span>
          <span className="standing-name">
            {r.name}
            {r.player_id === s.me.id && <em className="tag">you</em>}
            {r.rank === 1 && anyPoints && <Crown />}
          </span>
          {!final && (
            <span className="standing-last" aria-label={`${r.last} this round`}>
              {signed(r.last)}
            </span>
          )}
          <span className="standing-total" data-testid="standing-total">
            {r.total}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StandingsDialog({ s, open, onClose }: { s: Snapshot; open: boolean; onClose(): void }) {
  const adjustments = s.adjustments ?? [];
  return (
    <Dialog open={open} onClose={onClose} title="Scores">
      <p className="meta">
        {s.completed_rounds ? `After ${s.completed_rounds} ${s.completed_rounds === 1 ? 'round' : 'rounds'}` : 'No rounds scored yet'} ·{' '}
        {describeEnding(s.room)}
      </p>
      <StandingsList s={s} />
      {adjustments.length > 0 && (
        <section aria-label="Score adjustments">
          <p className="card-label">Adjustments by the host</p>
          <ul className="adjustments">
            {adjustments.map((a, i) => (
              <li key={i}>
                {a.name} {signed(a.points)} — {a.note}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Button onClick={onClose}>Back to the game</Button>
    </Dialog>
  );
}

const AWARD_TITLE: Record<Award['key'], string> = {
  great_deceiver: 'The Great Deceiver',
  lexicographer: 'The Lexicographer',
  master_reader: 'The Master Reader',
  scholar: 'The Scholar',
  convincing_bluff: 'The Most Convincing Bluff',
};

function awardLine(a: Award): string {
  const n = a.count;
  switch (a.key) {
    case 'great_deceiver':
      return `${n} ${n === 1 ? 'vote' : 'votes'} drawn to false definitions`;
    case 'lexicographer':
      return `${n} genuine ${n === 1 ? 'definition' : 'definitions'} identified`;
    case 'master_reader':
      return `fooled the whole table ${n === 1 ? 'once' : `${n} times`} as reader`;
    case 'scholar':
      return `wrote the correct definition ${n === 1 ? 'once' : `${n} times`}`;
    default:
      return `${n} ${n === 1 ? 'vote' : 'votes'} for a single bluff`;
  }
}

interface FinalProps {
  s: Snapshot;
  room: RoomHandle;
  onExit(): void;
}

export function FinalResults({ s, room, onExit }: FinalProps) {
  const f = s.final;
  const winners = f?.winners ?? [];
  const stats = f?.my_stats;
  return (
    <Page label="Final results">
      <header className="masthead final-head">
        <p className="eyebrow">The game is ended</p>
        {winners.length > 0 ? (
          <>
            <h1 className="title winner" data-testid="winners">
              {listNames(winners)}
            </h1>
            <p className="lede">
              {winners.length > 1 ? 'share the victory as Masters of Deception' : 'is the Master of Deception'}
            </p>
          </>
        ) : (
          <h1 className="heading" data-testid="status">
            No rounds were scored
          </h1>
        )}
        <Flourish />
      </header>

      <section aria-label="Final standings">
        <h2 className="subheading">
          Final standings · {s.completed_rounds ?? 0} {s.completed_rounds === 1 ? 'round' : 'rounds'}
        </h2>
        <StandingsList s={s} final />
      </section>

      {f && f.awards.length > 0 && (
        <section aria-label="Distinctions">
          <h2 className="subheading">Distinctions</h2>
          <ul className="awards">
            {f.awards.map((a) => (
              <li key={a.key} className="award" data-testid="award" data-award={a.key}>
                <p className="award-title">{AWARD_TITLE[a.key]}</p>
                {a.key === 'convincing_bluff' ? (
                  (a.bluffs ?? []).map((b, i) => (
                    <p key={i}>
                      {b.name}: <em>“{b.text}”</em>
                    </p>
                  ))
                ) : (
                  <p>{listNames(a.names ?? [])}</p>
                )}
                <p className="hint">{awardLine(a)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats && (s.completed_rounds ?? 0) > 0 && (
        <section aria-label="Your game">
          <h2 className="subheading">Your game</h2>
          <dl className="stats">
            <div>
              <dt>Genuine definitions found</dt>
              <dd>{stats.correct_guesses}</dd>
            </div>
            <div>
              <dt>Times fooled</dt>
              <dd>{stats.incorrect_guesses}</dd>
            </div>
            <div>
              <dt>Votes drawn by your bluffs</dt>
              <dd>{stats.votes_received}</dd>
            </div>
            <div>
              <dt>Best single bluff</dt>
              <dd>{stats.best_bluff_votes}</dd>
            </div>
            {stats.correct_written > 0 && (
              <div>
                <dt>Correct definitions written</dt>
                <dd>{stats.correct_written}</dd>
              </div>
            )}
            {stats.reader_bonuses > 0 && (
              <div>
                <dt>Reader bonuses</dt>
                <dd>{stats.reader_bonuses}</dd>
              </div>
            )}
            {stats.abstentions > 0 && (
              <div>
                <dt>Votes missed</dt>
                <dd>{stats.abstentions}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <div className="stack">
        {s.me.is_host ? (
          <Button working={room.busy === 'play_again'} onClick={() => room.act('play_again', { p_room_id: s.room.id })}>
            Play Again
          </Button>
        ) : (
          <p className="hint center">The host can start another game with the same players.</p>
        )}
        <Button variant="secondary" onClick={onExit}>
          Return Home
        </Button>
      </div>
    </Page>
  );
}
