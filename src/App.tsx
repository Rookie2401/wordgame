import { useEffect, useState } from 'react';
import { backend } from './backend';
import type { JoinResult } from './backend/types';
import { APP_NAME, codeFromUrl } from './game/logic';
import { session, type StoredSession } from './storage';
import { Flourish, Page } from './ui/common';
import { CreateGame, Home, JoinGame } from './ui/Entry';
import { Game } from './ui/Game';

type View = { name: 'home' } | { name: 'create' } | { name: 'join'; code: string | null };

function setUrl(code: string | null) {
  const url = code ? `${location.pathname}?room=${code}` : location.pathname;
  history.replaceState(null, '', url);
}

export function App() {
  const invited = codeFromUrl(location.search);
  const [current, setCurrent] = useState<StoredSession | null>(() => {
    const stored = session.get();
    // An invitation to a different room takes precedence over a remembered one.
    return stored && (!invited || invited === stored.code) ? stored : null;
  });
  const [view, setView] = useState<View>(() => (invited ? { name: 'join', code: invited } : { name: 'home' }));

  useEffect(() => {
    document.title = APP_NAME;
    if (current) setUrl(current.code);
    void backend?.ready().catch(() => undefined);
  }, [current]);

  if (!backend) {
    return (
      <Page label="Not configured">
        <h1 className="title">{APP_NAME}</h1>
        <Flourish />
        <p className="lede">
          This copy of the app has not been connected to a game server yet. See the setup guide in the project’s
          README.
        </p>
      </Page>
    );
  }

  function entered(r: JoinResult) {
    const next = { roomId: r.room_id, code: r.code };
    session.set(next);
    setCurrent(next);
  }

  function exit() {
    session.set(null);
    setCurrent(null);
    setUrl(null);
    setView({ name: 'home' });
  }

  if (current) return <Game key={current.roomId} backend={backend} roomId={current.roomId} onExit={exit} />;

  switch (view.name) {
    case 'create':
      return <CreateGame backend={backend} onDone={entered} onBack={() => setView({ name: 'home' })} />;
    case 'join':
      return (
        <JoinGame
          backend={backend}
          invitedCode={view.code}
          onDone={entered}
          onBack={() => {
            setUrl(null);
            setView({ name: 'home' });
          }}
        />
      );
    default:
      return <Home onCreate={() => setView({ name: 'create' })} onJoin={() => setView({ name: 'join', code: null })} />;
  }
}
