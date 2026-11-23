// @vitest-environment jsdom
/**
 * The fast-diagnose threshold has one source (T-FE-25, DEF-093).
 *
 * `actions.ts` used to carry a bare `3000` while the core filtered on its own
 * `FAST_DIAGNOSE_BUDGET_MS`. Both happened to be 3000, so every test passed and
 * every gate was green; the two only disagree the day a manifest budget moves.
 *
 * A test that asserts "18 probes" cannot catch that, because the literal also
 * yields 18. This file mocks the generated catalogue with a *different*
 * threshold and requires the announced total to follow it. A hard-coded number
 * cannot pass: it would announce 18 while the mocked constant selects fewer.
 */

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReducer } from "react";

// A threshold no manifest row uses allows a clean count: only probes at or
// under 900 ms. The real manifest has several, so the set is non-empty.
//
// `vi.mock` is hoisted above the imports, so the value has to be hoisted with
// it - a plain `const` here is not initialised when the factory runs.
const { MOCK_BUDGET } = vi.hoisted(() => ({ MOCK_BUDGET: 900 }));

vi.mock("./catalog.generated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog.generated")>();
  return { ...actual, FAST_DIAGNOSE_BUDGET_MS: MOCK_BUDGET };
});

import { useActions } from "./actions";
import { BridgeContext } from "./bridge";
import type { Bridge } from "./bridge/adapter";
import { ACTIONS } from "./catalog.generated";
import { initialState, reducer } from "./state/store";
import type { Action } from "./state/store";

function fakeBridge(): Bridge {
  return {
    diagnose: vi.fn(() => Promise.resolve([])),
    state: vi.fn(() =>
      Promise.resolve({ telemetry: null } as unknown as never),
    ),
  } as unknown as Bridge;
}

describe("fast-diagnose budget (T-FE-25, DEF-093)", () => {
  it("announces the count selected by the generated constant, not a literal", async () => {
    const dispatched: Action[] = [];

    function Probe() {
      const [state, dispatch] = useReducer(
        (current: ReturnType<typeof reducer>, action: Action) => {
          dispatched.push(action);
          return reducer(current, action);
        },
        initialState,
      );
      const api = useActions(state, dispatch);
      // Run once on mount: the hook's identity is stable per state.
      if (!dispatched.some((a) => a.type === "diagnose/started")) {
        void api.diagnose(false);
      }
      return null;
    }

    render(
      <BridgeContext.Provider value={fakeBridge()}>
        <Probe />
      </BridgeContext.Provider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const started = dispatched.find((action) => action.type === "diagnose/started") as
      | { total: number }
      | undefined;
    expect(started).toBeTruthy();

    const expected = ACTIONS.filter((def) => def.diagnoseBudgetMs <= MOCK_BUDGET).length;
    // Sanity: the mocked threshold must actually narrow the set, or the test
    // would pass against any implementation.
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(ACTIONS.length);

    expect(started!.total).toBe(expected);
  });
});
