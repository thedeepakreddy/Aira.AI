import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/aira/error-boundary';
import './styles/globals.css';
import './styles/workspace.css';
import './styles/light-rays.css';
import { installGlobalHandlers } from '@/lib/applog';

// Before anything else runs: the failures worth catching are the ones no
// try block wrapped, and some of those happen during the first render.
installGlobalHandlers();

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root not found');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);
