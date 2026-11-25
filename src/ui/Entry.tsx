import { useEffect, useState, type FormEvent } from 'react';
import { GameError, type Backend, type JoinResult } from '../backend/types';
import { APP_NAME, CODE_LENGTH, MAX_NAME, messageFor, normalizeCode, validateName } from '../game/logic';
import { load, save } from '../storage';
import { Button, Flourish, Notice, Page } from './common';
import { DEFAULT_RULES, RulesFields, rulesArgs, validateRules, type Rules } from './Settings';

function describe(e: unknown): string {
  if (e instanceof GameError) return messageFor(e.code);
  return 'Could not reach the game server. Check your connection and try again.';
}

export function Home({ onCreate, onJoin }: { onCreate(): void; onJoin(): void }) {
  return (
    <Page label="Home">
      <header className="masthead">
        <p className="eyebrow">A parlour companion for</p>
        <h1 className="title">{APP_NAME}</h1>
        <Flourish />
        <p className="lede">
          The slips of paper, done for you. Read aloud, vote aloud, and keep score on paper.
        </p>
      </header>
      <div className="stack">
        <Button onClick={onCreate}>Create Game</Button>
        <Button variant="secondary" onClick={onJoin}>
          Join Game
        </Button>
      </div>
      <p className="hint center smallprint">
        An unofficial helper for playing in person. Not affiliated with or endorsed by the publishers of any board
        game.
      </p>
    </Page>
  );
}

interface CreateProps {
  backend: Backend;
  onDone(r: JoinResult): void;
  onBack(): void;
}

export function CreateGame({ backend, onDone, onBack }: CreateProps) {
  const [name, setName] = useState(() => load<string>('name') ?? '');
  const [rules, setRules] = useState<Rules>(() => ({ ...DEFAULT_RULES, ...(load<Partial<Rules>>('rules') ?? {}) }));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = validateName(name) ?? validateRules(rules);
    if (bad) return setError(bad);
    setWorking(true);
    setError(null);
    try {
      const r = await backend.rpc<JoinResult>('create_room', { p_name: name, ...rulesArgs(rules) });
      save('name', name.trim());
      save('rules', rules);
      onDone(r);
    } catch (err) {
      setError(describe(err));
      setWorking(false);
    }
  }

  return (
    <Page label="Create game">
      <h1 className="heading">Create a game</h1>
      <Flourish />
      <form className="form" onSubmit={submit} noValidate>
        <label className="field">
          <span className="label">Your name</span>
          <input
            className="input"
            value={name}
            maxLength={MAX_NAME}
            autoComplete="given-name"
            autoCapitalize="words"
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <RulesFields value={rules} onChange={setRules} />
        {error && <Notice tone="warn">{error}</Notice>}
        <div className="stack">
          <Button type="submit" working={working}>
            Create
          </Button>
          <Button variant="quiet" onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    </Page>
  );
}

interface JoinProps {
  backend: Backend;
  /** Code from an invitation link or QR code, if any. */
  invitedCode: string | null;
  onDone(r: JoinResult): void;
  onBack(): void;
}

export function JoinGame({ backend, invitedCode, onDone, onBack }: JoinProps) {
  const [code, setCode] = useState(invitedCode ?? '');
  const [name, setName] = useState(() => load<string>('name') ?? '');
  const [rejoin, setRejoin] = useState('');
  const [showRejoin, setShowRejoin] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // An invitation link is checked straight away, so an expired one says so
  // before anyone types a name.
  useEffect(() => {
    if (!invitedCode) return;
    let alive = true;
    backend
      .rpc<boolean>('room_exists', { p_code: invitedCode })
      .then((ok) => alive && setExpired(!ok))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, invitedCode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = invitedCode ?? normalizeCode(code);
    if (!c) return setError('Please enter the room code.');
    setWorking(true);
    setError(null);
    try {
      let r: JoinResult;
      if (showRejoin && rejoin.trim()) {
        r = await backend.rpc<JoinResult>('claim_player', { p_code: c, p_rejoin_code: rejoin });
      } else {
        const bad = validateName(name);
        if (bad) {
          setError(bad);
          setWorking(false);
          return;
        }
        r = await backend.rpc<JoinResult>('join_room', { p_code: c, p_name: name });
        save('name', name.trim());
      }
      onDone(r);
    } catch (err) {
      if (err instanceof GameError && err.code === 'room_not_found' && invitedCode) setExpired(true);
      setError(describe(err));
      setWorking(false);
    }
  }

  if (expired) {
    return (
      <Page label="Invitation expired">
        <h1 className="heading">This invitation has expired</h1>
        <Flourish />
        <p className="lede">The game has ended, or the link is no longer valid. Ask the host for a new one.</p>
        <div className="stack">
          <Button onClick={onBack}>Return Home</Button>
        </div>
      </Page>
    );
  }

  return (
    <Page label="Join game">
      <h1 className="heading">Join the game</h1>
      <Flourish />
      <form className="form" onSubmit={submit} noValidate>
        {invitedCode ? (
          <p className="lede">
            Room <span className="code-inline">{invitedCode}</span>
          </p>
        ) : (
          <label className="field">
            <span className="label">Room code</span>
            <input
              className="input input-code"
              value={code}
              maxLength={CODE_LENGTH}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              onChange={(e) => setCode(normalizeCode(e.target.value))}
            />
          </label>
        )}
        {!showRejoin && (
          <label className="field">
            <span className="label">Your name</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_NAME}
              autoComplete="given-name"
              autoCapitalize="words"
              enterKeyHint="go"
              autoFocus={!!invitedCode}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {showRejoin && (
          <label className="field">
            <span className="label">Rejoin code from the host</span>
            <input
              className="input input-code"
              value={rejoin}
              maxLength={6}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRejoin(e.target.value.toUpperCase())}
            />
            <small className="hint">
              Use this if you were already playing and lost your place. The host can find a code for you in
              the game menu.
            </small>
          </label>
        )}
        {error && <Notice tone="warn">{error}</Notice>}
        <div className="stack">
          <Button type="submit" working={working}>
            {showRejoin ? 'Rejoin' : 'Join'}
          </Button>
          <Button variant="quiet" onClick={() => setShowRejoin((v) => !v)}>
            {showRejoin ? 'Join as a new player instead' : 'Lost your place? Use a rejoin code'}
          </Button>
          <Button variant="quiet" onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    </Page>
  );
}
