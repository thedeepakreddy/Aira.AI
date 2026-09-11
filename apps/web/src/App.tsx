import Workspace from '@/components/aira/workspace';
import { parseRoute } from '@/lib/routes';
export { parseRoute } from '@/lib/routes';

export default function App() {
  const { view, screen } = parseRoute(window.location.pathname);
  return <Workspace view={view} initialScreen={screen} />;
}
