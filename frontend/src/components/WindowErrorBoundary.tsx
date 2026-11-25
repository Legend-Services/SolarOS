import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { GlassButton } from "./ui/GlassKit";

/** Keeps a crashing app inside its own window: the rest of the desktop keeps running. */
export default class WindowErrorBoundary extends Component<{ app: string; children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.app} crashed`, error, info.componentStack);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
        <TriangleAlert size={32} className="text-amber-300" />
        <h2 className="text-sm font-semibold text-white">{this.props.app} ran into a problem</h2>
        <p className="max-w-md text-xs text-slate-400">The rest of SolarDeck is unaffected. Reload this window to try again; if it keeps happening, report it from the top bar's Help menu.</p>
        <code className="max-w-md truncate rounded bg-black/40 px-2 py-1 text-[11px] text-rose-300" title={error.stack}>
          {error.message || String(error)}
        </code>
        {/* A new key remounts the app with fresh state. */}
        <GlassButton variant="primary" onClick={() => this.setState({ error: null, attempt: attempt + 1 })}>
          Reload window
        </GlassButton>
      </div>
    );
  }
}
