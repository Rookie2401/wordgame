import { useState } from 'react';
import type { PlayerInfo, Snapshot } from '../backend/types';
import type { RoomHandle } from '../sync/useRoom';
import { Button, Confirm, Dialog, Notice } from './common';
import { Invite } from './Lobby';
import { messageFor } from '../game/logic';

interface Props {
  s: Snapshot;
  room: RoomHandle;
  open: boolean;
  onClose(): void;
  onLeft(): void;
}

type Pending =
  | { kind: 'remove' | 'reader' | 'host'; player: PlayerInfo }
  | { kind: 'end' | 'leave' | 'skip' | 'take-reader' };

export function GameMenu({ s, room, open, onClose, onLeft }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [rejoin, setRejoin] = useState<{ name: string; code: string } | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [adjusting, setAdjusting] = useState<PlayerInfo | null>(null);
  const [adjPoints, setAdjPoints] = useState('');
  const [adjNote, setAdjNote] = useState('');
  const canAdjust = s.room.scoring === 'digital' && s.room.status !== 'lobby';

  async function adjust() {
    if (!adjusting) return;
    const ok = await room.act('adjust_score', {
      p_room_id: s.room.id,
      p_player_id: adjusting.id,
      p_points: Number.parseInt(adjPoints, 10) || 0,
      p_note: adjNote,
    });
    if (ok) {
      setAdjusting(null);
      setAdjPoints('');
      setAdjNote('');
    }
  }

  const host = s.me.is_host;
  const round = s.round;
  const playing = s.room.status === 'playing' && !!round;
  const hostPlayer = s.players.find((p) => p.id === s.room.host_player_id);
  const hostAway = !hostPlayer || !hostPlayer.connected;
  const roomId = s.room.id;

  async function run(p: Pending) {
    setPending(null);
    switch (p.kind) {
      case 'remove':
        await room.act('remove_player', { p_room_id: roomId, p_player_id: p.player.id });
        break;
      case 'reader':
        await room.act('set_reader', { p_room_id: roomId, p_player_id: p.player.id });
        break;
      case 'take-reader':
        await room.act('set_reader', { p_room_id: roomId, p_player_id: s.me.id });
        onClose();
        break;
      case 'host':
        await room.act('transfer_host', { p_room_id: roomId, p_player_id: p.player.id });
        break;
      case 'skip':
        await room.act('skip_reader', { p_room_id: roomId, p_round_id: round?.id });
        break;
      case 'end':
        await room.act('end_game', { p_room_id: roomId });
        onClose();
        break;
      case 'leave':
        if ((await room.call('leave_room', { p_room_id: roomId })) !== null) onLeft();
        break;
    }
    setSelected(null);
  }

  async function issue(p: PlayerInfo) {
    const r = await room.call<{ rejoin_code: string }>('issue_rejoin_code', {
      p_room_id: roomId,
      p_player_id: p.id,
    });
    if (r) setRejoin({ name: p.name, code: r.rejoin_code });
  }

  const confirmText: Record<Pending['kind'], { title: string; body: string; label: string }> = {
    remove: {
      title: 'Remove player',
      body: `Remove ${pending && 'player' in pending ? pending.player.name : ''} from the game? They will not be able to return.`,
      label: 'Remove',
    },
    reader: {
      title: 'Change the reader',
      body: `${pending && 'player' in pending ? pending.player.name : ''} will become the reader for this round and will be shown the correct definition. The word and everything already submitted are kept.`,
      label: 'Make reader',
    },
    'take-reader': {
      title: 'Take over as reader',
      body: 'You will become the reader for this round. Taking the role shows you the correct definition, so you should not also guess at it.',
      label: 'Become the reader',
    },
    host: {
      title: 'Hand over hosting',
      body: `${pending && 'player' in pending ? pending.player.name : ''} will become the host, and you will be an ordinary player.`,
      label: 'Hand over',
    },
    skip: {
      title: 'Skip this reader',
      body: `${round?.reader_name ?? 'The reader'} will miss this turn and the next player will read.`,
      label: 'Skip reader',
    },
    end: {
      title: 'End the game',
      body: 'The game will end for everyone. Its data is deleted shortly afterwards.',
      label: 'End Game',
    },
    leave: { title: 'Leave the game', body: 'You will leave this game. You can rejoin with the room code.', label: 'Leave' },
  };

  return (
    <>
      <Dialog open={open && !pending && !adjusting} onClose={onClose} title="Game menu">
        <p className="meta">
          Room <span className="code-inline">{s.room.code}</span>
        </p>
        {showInvite ? (
          <Invite code={s.room.code} />
        ) : (
          <Button variant="quiet" onClick={() => setShowInvite(true)}>
            Show invitation code
          </Button>
        )}

        {rejoin && (
          <Notice>
            Rejoin code for {rejoin.name}: <strong className="code-inline">{rejoin.code}</strong>. They should open the
            invitation, choose “Lost your place?”, and enter it within ten minutes.
          </Notice>
        )}

        <ul className="players menu-players" aria-label="Players">
          {s.players.map((p) => (
            <li key={p.id} className="player player-block">
              <button
                className="player-row"
                aria-expanded={selected === p.id}
                disabled={!host || (p.id === s.me.id && !canAdjust)}
                onClick={() => setSelected(selected === p.id ? null : p.id)}
              >
                <span className={`dot ${p.connected ? 'dot-on' : 'dot-off'}`} aria-hidden="true" />
                <span className="player-name">
                  {p.name}
                  {p.id === s.room.host_player_id && <em className="tag">host</em>}
                  {playing && p.id === round?.reader_id && <em className="tag">reader</em>}
                  {p.id === s.me.id && <em className="tag">you</em>}
                  {!p.connected && <em className="tag">away</em>}
                </span>
              </button>
              {host && selected === p.id && p.id === s.me.id && canAdjust && (
                <div className="player-actions">
                  <Button variant="secondary" onClick={() => setAdjusting(p)}>
                    Correct score
                  </Button>
                </div>
              )}
              {host && selected === p.id && p.id !== s.me.id && (
                <div className="player-actions">
                  {canAdjust && (
                    <Button variant="secondary" onClick={() => setAdjusting(p)}>
                      Correct score
                    </Button>
                  )}
                  {playing && p.id !== round?.reader_id && round?.state !== 'done' && (
                    <Button variant="secondary" onClick={() => setPending({ kind: 'reader', player: p })}>
                      Make reader
                    </Button>
                  )}
                  <Button variant="secondary" working={room.busy === 'issue_rejoin_code'} onClick={() => issue(p)}>
                    Rejoin code
                  </Button>
                  <Button variant="secondary" onClick={() => setPending({ kind: 'host', player: p })}>
                    Make host
                  </Button>
                  <Button variant="secondary" onClick={() => setPending({ kind: 'remove', player: p })}>
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {host && <p className="hint">Tap a player for options.</p>}

        <div className="stack">
          {host && playing && !s.me.is_reader && (
            <Button variant="secondary" onClick={() => setPending({ kind: 'take-reader' })}>
              Take over as reader
            </Button>
          )}
          {host && playing && round?.state === 'card_selection' && s.players.length > 1 && (
            <Button variant="secondary" onClick={() => setPending({ kind: 'skip' })}>
              Skip this reader
            </Button>
          )}
          {host && s.room.status !== 'ended' && (
            <Button variant="secondary" onClick={() => setPending({ kind: 'end' })}>
              End Game
            </Button>
          )}
          {!host && hostAway && s.room.status !== 'ended' && (
            <Button
              variant="secondary"
              working={room.busy === 'claim_host'}
              onClick={() => room.act('claim_host', { p_room_id: roomId })}
            >
              The host is away — become host
            </Button>
          )}
          <Button variant="quiet" onClick={() => setPending({ kind: 'leave' })}>
            Leave game
          </Button>
          <Button onClick={onClose}>Back to the game</Button>
        </div>
      </Dialog>
      <Dialog open={!!adjusting} onClose={() => setAdjusting(null)} title="Correct a score">
        {adjusting && (
          <div className="form">
            <p className="dialog-text">
              Add or take away points for {adjusting.name}. The correction is recorded with your reason and everyone can
              see it.
            </p>
            <label className="field">
              <span className="label">Points (use a minus sign to take away)</span>
              <input
                className="input"
                inputMode="text"
                value={adjPoints}
                onChange={(e) => setAdjPoints(e.target.value.replace(/[^0-9-]/g, ''))}
              />
            </label>
            <label className="field">
              <span className="label">Reason</span>
              <input className="input" maxLength={120} value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
            </label>
            {room.error && <Notice tone="warn">{messageFor(room.error)}</Notice>}
            <div className="stack">
              <Button working={room.busy === 'adjust_score'} onClick={adjust}>
                Record correction
              </Button>
              <Button variant="quiet" onClick={() => setAdjusting(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      {pending && (
        <Confirm
          open
          title={confirmText[pending.kind].title}
          body={confirmText[pending.kind].body}
          confirmLabel={confirmText[pending.kind].label}
          onCancel={() => setPending(null)}
          onConfirm={() => void run(pending)}
        />
      )}
    </>
  );
}
