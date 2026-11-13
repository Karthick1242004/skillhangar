import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Router, Switch } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { startSession } from './api';
import { Shell } from './components/Shell';
import { Logo } from './components/Logo';
import { ToastProvider } from './components/ui';
import { useServerEvents } from './lib/data';
import { Overview } from './screens/Overview';
import './styles.css';

// The overview loads with the shell; every other screen is its own chunk, fetched on first visit.
const Library = lazy(() => import('./screens/Library').then((m) => ({ default: m.Library })));
const SkillPage = lazy(() => import('./screens/SkillPage').then((m) => ({ default: m.SkillPage })));
const McpScreen = lazy(() => import('./screens/Mcp').then((m) => ({ default: m.McpScreen })));
const Plugins = lazy(() => import('./screens/Plugins').then((m) => ({ default: m.Plugins })));
const Audits = lazy(() => import('./screens/Audits').then((m) => ({ default: m.Audits })));
const Updates = lazy(() => import('./screens/Updates').then((m) => ({ default: m.Updates })));
const AddSkill = lazy(() => import('./screens/AddSkill').then((m) => ({ default: m.AddSkill })));
const Activity = lazy(() => import('./screens/Activity').then((m) => ({ default: m.Activity })));
const SettingsScreen = lazy(() => import('./screens/Settings').then((m) => ({ default: m.SettingsScreen })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => count < 2 && !(error as { status?: number }).status, refetchOnWindowFocus: false },
  },
});

function Routes() {
  useServerEvents();
  return (
    <Shell>
      <Suspense fallback={<div className="page" aria-busy="true" />}>
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/library" component={Library} />
          <Route path="/skills/:id">{(params) => <SkillPage id={params.id} />}</Route>
          <Route path="/mcp" component={McpScreen} />
          <Route path="/plugins" component={Plugins} />
          <Route path="/audits" component={Audits} />
          <Route path="/updates" component={Updates} />
          <Route path="/add" component={AddSkill} />
          <Route path="/activity" component={Activity} />
          <Route path="/settings" component={SettingsScreen} />
          <Route>
            <div className="page">
              <h1>Not found</h1>
              <p className="muted" style={{ marginTop: 8 }}>
                <a className="link" href="#/">
                  Back to the overview
                </a>
              </p>
            </div>
          </Route>
        </Switch>
      </Suspense>
    </Shell>
  );
}

function Boot() {
  const [state, setState] = useState<'starting' | 'ready' | Error>('starting');
  useEffect(() => {
    startSession().then(
      () => setState('ready'),
      (error: Error) => setState(error),
    );
  }, []);
  if (state === 'ready') {
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Router hook={useHashLocation}>
            <Routes />
          </Router>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100svh', padding: 24 }}>
      <div style={{ display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', maxWidth: 420 }}>
        <Logo size={40} state={state === 'starting' ? 'scanning' : 'idle'} label="Skillhangar" />
        {state === 'starting' ? (
          <p className="muted">Opening your hangar…</p>
        ) : (
          <>
            <h1 style={{ fontFamily: 'var(--font-title)', fontWeight: 500, fontSize: 24 }}>This link has expired</h1>
            <p className="muted">{state.message}</p>
            <code className="mono">npx skillhangar</code>
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
