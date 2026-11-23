import type { Dispatch } from "react";

import type { IpcError } from "../bridge/types";
import { useT } from "../i18n";
import type { Action } from "../state/store";

/**
 * The error toast.
 *
 * Extracted from `App.tsx` so it can be rendered in a test. That is not
 * cosmetic: DEF-083 and DEF-085 both came from a surface that existed inside a
 * larger component and was therefore never exercised on its own, and DEF-089
 * found this exact panel dropping `detail` - the one field a helpdesk asks for.
 *
 * The visible shape is deliberate:
 *
 * * the catalogue string and its remedy, never the raw code;
 * * `detail` only when the core attached one, inside `<details>` so it does not
 *   push the human-readable lines off screen;
 * * the correlation id always, because it is the only way to find the audit row.
 */
export function ErrorToast({
  error,
  dispatch,
}: {
  error: IpcError;
  dispatch: Dispatch<Action>;
}) {
  const t = useT();

  return (
    <div className="error-toast" role="alert">
      <div>
        <strong>{t("misc.error.title")}</strong>
        <p>{t.tKey(error.messageKey, error.params)}</p>
        <p className="muted">{t.tKey(error.remedyKey)}</p>
        {error.detail ? (
          <details className="error-detail">
            <summary>{t("misc.error.detail")}</summary>
            <p className="mono small">{error.detail}</p>
          </details>
        ) : null}
        <p className="mono small">
          {t("misc.error.correlation", { id: error.correlationId })}
        </p>
      </div>
      <button
        className="btn"
        type="button"
        onClick={() => dispatch({ type: "error/cleared" })}
      >
        {t("misc.error.dismiss")}
      </button>
    </div>
  );
}
