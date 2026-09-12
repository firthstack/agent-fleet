import { Component, type ReactNode } from "react";

/**
 * Catches a lazily-loaded route that fails to arrive.
 *
 * This is the failure mode code splitting introduces: a deploy replaces the
 * built assets, and a browser still holding the previous page then asks for a
 * chunk name that no longer exists. The gateway answers 404 rather than the
 * SPA shell (deliberately — see `staticFiles.ts`), `import()` rejects, and
 * without a boundary the whole tree unmounts to a blank page.
 *
 * A reload fetches the current `index.html` and with it the current chunk
 * names, so that is the entire remedy — it just has to be said rather than
 * guessed at.
 */
export class ChunkBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-note">
        <p>This page changed since the tab was opened.</p>
        <p>
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      </div>
    );
  }
}
