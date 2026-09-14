import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logError } from '@/lib/applog';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Aira UI error', error.message, info.componentStack);
    // A render that threw took a panel down; the component stack says which,
    // and it is gone from the console the moment the window reloads.
    logError('ui', error, `render failed${info.componentStack ? ` |${info.componentStack}` : ''}`);
  }
  render() {
    if (this.state.failed) return <main className="app-recovery" role="alert"><span className="brand-wordmark">Aira</span><h1>Let’s get you back.</h1><p>A panel could not open. Your saved conversations are still on this device.</p><button className="warm-button" onClick={() => { window.location.href = '/'; }}>Return to workspace</button></main>;
    return this.props.children;
  }
}
