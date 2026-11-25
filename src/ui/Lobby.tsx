import { useState } from 'react';
import type { Snapshot } from '../backend/types';
import { MIN_PLAYERS, describeEnding, inviteUrl } from '../game/logic';
import type { RoomHandle } from '../sync/useRoom';
import { Button, Confirm, Dialog, Flourish, Notice, Page, QrCode } from './common';
import { RulesFields, rulesArgs, rulesFromRoom, validateRules, type Rules } from './Settings';

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
  const [editing, setEditing] = useState<Rules | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);

  async function saveRules() {
    if (!editing) return;
    const bad = validateRules(editing);
    setRulesError(bad);
    if (bad) return;
    if (await room.act('update_settings', { p_room_id: s.room.id, ...rulesArgs(editing) })) setEditing(null);
  }
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
      <p className="meta" data-testid="rules">
        {s.room.scoring === 'digital' ? 'Votes and scores in the app' : 'Vote aloud, score on paper'} ·{' '}
        {describeEnding(s.room)}
        {host && (
          <>
            {' '}
            <button className="link" onClick={() => setEditing(rulesFromRoom(s.room))}>
              Change
            </button>
          </>
        )}
      </p>
      {s.room.game_number > 1 && (
        <p className="hint center">A new game with the same company. Scores begin again at nought.</p>
      )}
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
      <Dialog open={!!editing} onClose={() => setEditing(null)} title="Game options">
        {editing && (
          <div className="form">
            <RulesFields value={editing} onChange={setEditing} />
            {rulesError && <Notice tone="warn">{rulesError}</Notice>}
            <div className="stack">
              <Button working={room.busy === 'update_settings'} onClick={saveRules}>
                Save options
              </Button>
              <Button variant="quiet" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
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
