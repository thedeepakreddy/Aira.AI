import Workspace, { type Screen } from '@/components/aira/workspace';

type View = 'auto' | 'mobile' | 'desktop';

/**
 * Maps the reference project's file-based routes onto a single SPA entry.
 *
 * The route table is unchanged from the reference:
 *   /                /cli                /login
 *   /desktop         /desktop/cli        /desktop/login
 *   /mobile          /mobile/cli         /mobile/login
 *
 * Workspace drives its own history via pushState/popstate, so the only job
 * here is to derive the initial view and screen from the current path.
 */
export function parseRoute(pathname: string): { view: View; screen: Screen } {
  const segments = pathname.split('/').filter(Boolean);
  const view: View = segments[0] === 'desktop' || segments[0] === 'mobile' ? segments[0] : 'auto';
  const rest = view === 'auto' ? segments : segments.slice(1);
  const screen: Screen =
    rest[0] === 'cli' ? 'cli' : rest[0] === 'tasks' ? 'tasks' : rest[0] === 'login' ? 'login' : 'home';
  return { view, screen };
}

export default function App() {
  const { view, screen } = parseRoute(window.location.pathname);
  return <Workspace view={view} initialScreen={screen} />;
}
