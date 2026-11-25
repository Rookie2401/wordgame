import { useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend/types';
import { messageFor, screenFor } from '../game/logic';
import { useRoom } from '../sync/useRoom';
import { Button, Flourish, Notice, Page } from './common';
import { Lobby } from './Lobby';
import { GameMenu } from './Menu';
import { FinalResults, StandingsDialog } from './Scores';
import {
  AdjudicateReader,
  AdjudicateWaiting,
  Results,
  RevealStaged,
  VoteBallot,
  VoteReader,
  VoteWaiting,
} from './Voting';
import {
  CardReader,
  CardWaiting,
  PlayerSubmit,
  ReaderSubmit,
  ReadingReader,
  ReadingWaiting,
  Reveal,
  SittingOut,
} from './Round';

interface Props {
  backend: Backend;
  roomId: string;
  /** Leave this room on this device and go back to the home screen. */
  onExit(): void;
}

export function Game({ backend, roomId, onExit }: Props) {
  const room = useRoom(backend, roomId);
  const [menu, setMenu] = useState(false);
  const [scores, setScores] = useState(false);
  const s = room.snapshot;

  // Tell a player who was handed the reader's role mid-round what changed.
  const wasReader = useRef<{ round: string; reader: boolean } | null>(null);
  const [tookOver, setTookOver] = useState(false);
  useEffect(() => {
    if (!s?.round) return;
    const prev = wasReader.current;
    if (prev && prev.round === s.round.id && !prev.reader && s.me.is_reader) setTookOver(true);
    if (prev && prev.round !== s.round.id) setTookOver(false);
    wasReader.current = { round: s.round.id, reader: s.me.is_reader };
  }, [s]);

  if (room.fatal) {
    return (
      <Page label="Game unavailable">
        <h1 className="heading">This game is closed to you</h1>
        <Flourish />
        <p className="lede" data-testid="fatal">
          {messageFor(room.fatal)}
        </p>
        <div className="stack">
          <Button onClick={onExit}>Return Home</Button>
        </div>
      </Page>
    );
  }

  if (!s) {
    return (
      <Page label="Loading">
        <p className="waiting">{room.online ? 'Finding your place at the table…' : 'Trying to reconnect…'}</p>
        {!room.online && (
          <div className="stack">
            <Button variant="quiet" onClick={onExit}>
              Return Home
            </Button>
          </div>
        )}
      </Page>
    );
  }

  const screen = screenFor(s);
  const round = s.round;
  const props = round ? { s, round, room } : null;

  let view;
  if (screen === 'lobby') view = <Lobby s={s} room={room} />;
  else if (screen === 'ended' || !props) {
    view = s.room.scoring === 'digital' ? (
      <FinalResults s={s} room={room} onExit={onExit} />
    ) : (
      <Page label="Game over">
        <h1 className="heading">The game is ended</h1>
        <Flourish />
        <p className="lede" data-testid="status">
          Thank you for playing. Tally the scores and crown your champion.
        </p>
        <div className="stack">
          {s.me.is_host && (
            <Button working={room.busy === 'play_again'} onClick={() => room.act('play_again', { p_room_id: s.room.id })}>
              Play Again
            </Button>
          )}
          <Button variant={s.me.is_host ? 'secondary' : 'primary'} onClick={onExit}>
            Return Home
          </Button>
        </div>
      </Page>
    );
  } else if (screen === 'card-reader') view = <CardReader key={round!.id} {...props} />;
  else if (screen === 'card-waiting') view = <CardWaiting {...props} />;
  else if (screen === 'submit-reader') view = <ReaderSubmit key={round!.id} {...props} />;
  else if (screen === 'submit-player' || screen === 'submitted') view = <PlayerSubmit key={round!.id} {...props} />;
  else if (screen === 'sitting-out') view = <SittingOut {...props} />;
  else if (screen === 'reading-reader') view = <ReadingReader key={round!.id} {...props} />;
  else if (screen === 'reading-waiting') view = <ReadingWaiting {...props} />;
  else if (screen === 'adjudicate-reader') view = <AdjudicateReader key={round!.id} {...props} />;
  else if (screen === 'adjudicate-waiting') view = <AdjudicateWaiting {...props} />;
  else if (screen === 'vote-reader') view = <VoteReader key={round!.id} {...props} />;
  else if (screen === 'vote-ballot') view = <VoteBallot key={round!.id} {...props} />;
  else if (screen === 'vote-waiting') view = <VoteWaiting {...props} />;
  else if (screen === 'reveal-staged')
    view =
      round!.state === 'voting_closed' && round!.can_vote && !s.me.is_reader ? (
        <VoteBallot key={round!.id} {...props} />
      ) : (
        <RevealStaged key={round!.id} {...props} />
      );
  else if (screen === 'results') view = <Results key={round!.id} {...props} />;
  else view = <Reveal {...props} />;

  return (
    <>
      <div className="banners" aria-live="polite">
        {!room.online && <Notice tone="warn">Connection lost. Trying to reconnect…</Notice>}
        {room.error && (
          <Notice tone="warn">
            {room.error === 'network'
              ? 'That did not reach the server. Please try again.'
              : messageFor(room.error)}{' '}
            <button className="link" onClick={room.clearError}>
              Dismiss
            </button>
          </Notice>
        )}
        {s.final_rotation && round && (
          <Notice>
            The target of {s.room.target_score} points has been reached. This is the final rotation: the game ends once
            everyone has had their turn as reader.
          </Notice>
        )}
        {tookOver && s.me.is_reader && round && round.state !== 'reveal' && round.state !== 'results' && (
          <Notice>
            You are now the Reader for this round, and can see the correct definition.{' '}
            <button className="link" onClick={() => setTookOver(false)}>
              Understood
            </button>
          </Notice>
        )}
      </div>
      {view}
      {s.room.status !== 'ended' && (
        <footer className="foot">
          <button className="link" onClick={() => setMenu(true)} data-testid="menu">
            {s.me.is_host ? 'Host menu' : 'Menu'}
          </button>
          {s.standings && s.room.status === 'playing' && (
            <button className="link" onClick={() => setScores(true)} data-testid="scores">
              Scores
            </button>
          )}
          <span className="meta">
            {s.me.name} · {s.room.code}
          </span>
        </footer>
      )}
      <GameMenu s={s} room={room} open={menu} onClose={() => setMenu(false)} onLeft={onExit} />
      {s.standings && <StandingsDialog s={s} open={scores} onClose={() => setScores(false)} />}
    </>
  );
}
