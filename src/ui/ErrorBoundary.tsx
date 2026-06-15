import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}
interface State {
  error: Error | null;
}

/**
 * Catches render errors so a bug shows a recoverable message instead of a blank
 * window. The message also tells us exactly what threw.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: unknown): void {
    // surface to the console for debugging
    // eslint-disable-next-line no-console
    console.error('Render error:', error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel error" style={{ margin: 16 }}>
          <h2 style={{ color: 'var(--bad)' }}>Something broke rendering this view</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{`${this.state.error.message}\n\n${this.state.error.stack ?? ''}`}</pre>
          <div className="controls">
            <button onClick={() => this.setState({ error: null })}>Try again</button>
            <button onClick={() => location.reload()}>Reload</button>
            {this.props.onReset && (
              <button
                onClick={() => {
                  this.props.onReset?.();
                  this.setState({ error: null });
                }}
              >
                Reset workspace
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
