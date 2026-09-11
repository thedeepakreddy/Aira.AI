export type Screen = 'home' | 'voice' | 'chat' | 'cli' | 'tasks' | 'browse' | 'connections' | 'login';
export type View = 'auto' | 'mobile' | 'desktop';

const screens = new Set<Screen>(['home', 'voice', 'chat', 'cli', 'tasks', 'browse', 'connections', 'login']);

export function parseRoute(pathname: string): { view: View; screen: Screen } {
  const segments = pathname.split('/').filter(Boolean);
  const view: View = segments[0] === 'desktop' || segments[0] === 'mobile' ? segments.shift() as View : 'auto';
  const candidate = segments[0] as Screen;
  return { view, screen: screens.has(candidate) ? candidate : 'home' };
}

export function screenPath(view: View, screen: Screen): string {
  return `${view === 'auto' ? '' : `/${view}`}${screen === 'home' ? '' : `/${screen}`}` || '/';
}
