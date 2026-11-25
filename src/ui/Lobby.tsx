import { useState } from 'react';
import type { Snapshot } from '../backend/types';
import { MIN_PLAYERS, inviteUrl } from '../game/logic';
import type { RoomHandle } from '../sync/useRoom';
import { Button, Confirm, Flourish, Page, QrCode } from './common';

export function Invite({ code }: { code: string }) {
  const url = inviteUrl(code);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Copy this invitation link', url);
    }
  }

  return (
    <section className="invite" aria-label="Invitation">
      <QrCode url={url} />
      <p className="code" aria-label={`Room code ${code.split('').join(' ')}`}>
        {code}
      </p>
      <Button variant="secondary" onClick={copy}>
        {copied ? 'Link copied' : 'Copy invitation link'}
      </Button>
    </section>
  );
}

export function Lobby({ s, room }: { s: Snapshot; room: RoomHandle }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const host = s.me.is_host;
  const count = s.players.length;
  const ids = s.players.map((p) => p.id);

  function move(index: number, by: number) {
    const next = [...ids];
    const j = index + by;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    void room.act('reorder_players', { p_room_id: s.room.id, p_player_ids: next });
  }

  const target = s.players.find((p) => p.id === removing);

  return (
    <Page label="Lobby">
      <h1 className="heading">The company assembles</h1>
      <Flourish />
      <Invite code={s.room.code} />
      <p className="meta">
        {s.room.mode === 'digital' ? 'Digital cards' : 'Physical cards'} ·{' '}
        <span data-testid="player-count">
          {count} {count === 1 ? 'player' : 'players'}
        </span>
      </p>
      <ol className="players" aria-label="Players, in reading order">
        {s.players.map((p, i) => (
          <li key={p.id} className="player">
            <span className={`dot ${p.connected ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
            <span className="player-name">
              {p.name}
              {p.id === s.room.host_player_id && <em className="tag">host</em>}
              {p.id === s.me.id && <em className="tag">you</em>}
              <span className="sr-only">{p.connected ? ', connected' : ', away'}</span>
            </span>
            {host && (
              <span className="player-tools">
                <button className="icon" aria-label={`Move ${p.name} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  className="icon"
                  aria-label={`Move ${p.name} later`}
                  disabled={i === count - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                {p.id !== s.me.id && (
                  <button className="icon" aria-label={`Remove ${p.name}`} onClick={() => setRemoving(p.id)}>
                    ×
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ol>
      {host && <p className="hint center">Readers take turns in this order.</p>}
      <div className="stack">
        {host ? (
          <>
            <Button
              disabled={count < MIN_PLAYERS}
              working={room.busy === 'start_game'}
              onClick={() => room.act('start_game', { p_room_id: s.room.id })}
            >
              Start Game
            </Button>
            {count < MIN_PLAYERS && <p className="hint center">At least three players are needed to begin.</p>}
          </>
        ) : (
          <p className="waiting">Waiting for the host to begin…</p>
        )}
      </div>
      <Confirm
        open={!!target}
        title="Remove player"
        body={`Remove ${target?.name ?? 'this player'} from the game? They will not be able to return.`}
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          void room.act('remove_player', { p_room_id: s.room.id, p_player_id: removing });
          setRemoving(null);
        }}
      />
    </Page>
  );
}
