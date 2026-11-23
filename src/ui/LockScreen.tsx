/**
 * The lock screen.
 *
 * It is not a security boundary against someone with the disk - they can replace
 * the executable. It stops the person who walks up to an unlocked laptop, which
 * is the threat the setting names. Verification happens against a slow KDF
 * record; the attempt counter lives in the persisted record, so reloading the
 * window does not clear a lockout.
 */

import { useEffect, useState } from "react";

import { useT } from "../i18n";
import {
  MAX_ATTEMPTS,
  lockedRemainingMs,
  verifyPin,
  type PinRecord,
} from "../settings/pin";

export function LockScreen({
  record,
  onUnlock,
  onUpdate,
}: {
  record: PinRecord | null;
  onUnlock: () => void;
  onUpdate: (record: PinRecord | null) => void;
}) {
  const t = useT();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(() => lockedRemainingMs(record));

  useEffect(() => {
    if (remaining <= 0) {
      return;
    }
    const timer = setInterval(() => setRemaining(lockedRemainingMs(record)), 1000);
    return () => clearInterval(timer);
  }, [remaining, record]);

  useEffect(() => {
    if (!record) {
      onUnlock();
    }
  }, [record, onUnlock]);

  if (!record) {
    return null;
  }

  const locked = remaining > 0;

  async function submit() {
    if (!record || busy || locked) {
      return;
    }
    setBusy(true);
    const result = await verifyPin(secret, record);
    setBusy(false);
    setSecret("");
    if (result.ok) {
      onUpdate(result.record);
      onUnlock();
      return;
    }
    onUpdate(result.record);
    if (result.lockedUntilUtc) {
      setRemaining(lockedRemainingMs(result.record));
      setError(
        t("pin.locked", { minutes: Math.ceil(lockedRemainingMs(result.record) / 60000) }),
      );
    } else {
      setError(t("pin.attempts", { count: result.remainingAttempts }));
    }
  }

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label={t("pin.title")}>
      <form
        className="lock-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <span className="brand-mark" aria-hidden="true">
          Z
        </span>
        <h2>{t("pin.title")}</h2>
        <p className="muted">{t("pin.subtitle")}</p>
        <label className="set-field">
          <span className="set-label">
            {record.kind === "pin" ? t("pin.enter") : t("pin.enterPassword")}
          </span>
          <input
            autoFocus
            className="set-input"
            type="password"
            inputMode={record.kind === "pin" ? "numeric" : undefined}
            autoComplete="off"
            value={secret}
            disabled={locked}
            onChange={(event) => {
              setSecret(event.target.value);
              setError(null);
            }}
          />
        </label>
        {error ? (
          <p className="set-hint set-hint-warn" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn" disabled={busy || locked || secret.length === 0}>
          {t("pin.unlock")}
        </button>
        <p className="set-hint">{t("pin.forgot")}</p>
        <p className="set-hint" aria-live="polite">
          {t("pin.attempts", { count: MAX_ATTEMPTS })}
        </p>
      </form>
    </div>
  );
}
