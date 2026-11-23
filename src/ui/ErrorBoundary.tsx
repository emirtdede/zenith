/**
 * Render-failure boundary (DEF-085).
 *
 * `main.tsx` rendered `<App />` straight into the root, and `App`'s own failure
 * states only cover *boot* (`boot === "failed"`) - a throw during render or a
 * lifecycle method is a different path. React unmounts the whole tree when that
 * happens, so one bad card left a blank window with no text, no retry and no
 * reference number: the classic enterprise reject, and impossible to diagnose
 * from a support ticket that says "it's white".
 *
 * Two placements matter and they are not the same job:
 *
 *   * Around each screen, so a throw costs the user *that screen* - the title
 *     bar, health strip, console and status bar keep working, and switching tabs
 *     clears the fault via `resetKey`. This is the placement that makes the
 *     failure survivable.
 *   * Around `<App />` itself, so a throw above the screen layer (provider,
 *     reducer wiring) still produces words instead of nothing.
 *
 * A class component is required: `getDerivedStateFromError` and
 * `componentDidCatch` have no hook equivalent. It is the only class in `src/`,
 * which is why it carries this much comment.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export interface BoundaryCopy {
  title: string;
  body: string;
  retry: string;
  detailLabel: string;
  /** Optional next step (the support-bundle command). Omitted at the root. */
  hint?: string;
}

interface Props {
  children: ReactNode;
  copy: BoundaryCopy;
  /**
   * Changing this clears a caught error. Screens pass their id, so navigating
   * away and back is a genuine recovery path rather than a dead end. The root
   * boundary passes nothing and relies on the retry button.
   */
  resetKey?: string;
  /**
   * Heading level for the recovery title.
   *
   * The two placements are not at the same depth in the document. The root
   * boundary replaces everything, so its title is the page's one `<h1>`. A
   * screen boundary renders *inside* `<main>`, where the shell's brand is
   * already the `<h1>` (DEF-145) - so a screen failure must use `<h2>` or a
   * failed screen ends up with two top-level headings, which is a WCAG 1.3.1
   * structure defect that only appears on the error path (i.e. never in a
   * screenshot of a working build).
   */
  headingLevel?: 1 | 2;
}

interface State {
  error: Error | null;
  /** The last `resetKey` we rendered, so a change can be detected in render. */
  seenKey: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, seenKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // React calls this on every render, including the one after a caught error.
    // Clearing here - rather than in a `componentDidUpdate` that would run a
    // frame late - means the recovery screen never persists across navigation.
    if (props.resetKey !== state.seenKey) {
      return { error: null, seenKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The boundary's job is to survive, not to swallow. A fault with no trace is
    // unreportable, so it goes to the renderer console (captured by the packaged
    // WebView2 log) with the component stack React provides.
    console.error("[zenith] render failure", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const { copy, headingLevel = 1 } = this.props;
    const Heading = headingLevel === 2 ? "h2" : "h1";
    return (
      <div className="boot boot-failed" role="alert" data-render-failure="">
        <Heading>{copy.title}</Heading>
        <p>{copy.body}</p>
        <p className="mono small" aria-label={copy.detailLabel}>
          {error.name}: {error.message}
        </p>
        {copy.hint ? <p className="muted small">{copy.hint}</p> : null}
        <button className="btn" type="button" data-boundary-retry onClick={this.retry}>
          {copy.retry}
        </button>
      </div>
    );
  }
}
