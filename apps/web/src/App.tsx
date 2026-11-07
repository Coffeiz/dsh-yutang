import { lazy, Suspense } from 'react';
import LobbyPage from './pages/LobbyPage';

const DevelopmentDesignPage = import.meta.env.DEV ? lazy(() => import('./pages/DesignPage')) : null;

function App() {
  if (DevelopmentDesignPage && window.location.pathname === '/design') {
    return <Suspense fallback={<div className="route-loading">正在加载设计令牌…</div>}><DevelopmentDesignPage /></Suspense>;
  }

  return <LobbyPage />;
}

export default App;
