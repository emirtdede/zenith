import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode } from "react";

import { type ActionsApi, confirmationWord } from "../actions";
import { useBridge } from "../bridge";
import { asIpcError } from "../bridge/adapter";
import type {
  Candidates,
  CandidateItem,
  IpcError,
  TerminateSummary,
  VerifiedPidTarget,
} from "../bridge/types";
import { COMMANDS } from "../catalog.generated";
import { useT } from "../i18n";
import { NOT_MEASURED } from "../shared/placeholder";
import type { Action, State } from "../state/store";
import { useFocusTrap } from "./useFocusTrap";

function Overlay({
  children,
  label,
  onClose,
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
}) {
  // DEF-086: `aria-modal` promises the rest of the page is inert, so Tab must
  // not leave the dialog and focus must return to the trigger on close. The
  // palette uses the same hook - one implementation, because DEF-083 was the
  // cost of fixing one renderer and leaving its twin.
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog);

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const confirm = state.confirm;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  if (!confirm) {
    return null;
  }
  const def = confirm.definition;
  const word = confirmationWord(def);
  const needsTyping = def.tier === "irreversible";
  const typedOk = !needsTyping || typed.trim().toLocaleUpperCase(state.locale) === word;

  return (
    <Overlay label={t("confirm.title", { title: t.tKey(`${def.i18nPrefix}.title`) })} onClose={() => dispatch({ type: "overlay/close" })}>
      <h2>{t("confirm.title", { title: t.tKey(`${def.i18nPrefix}.title`) })}</h2>
      <p>{t("confirm.body")}</p>

      <h3>{t("confirm.effect")}</h3>
      <p>{t.tKey(`${def.i18nPrefix}.desc`)}</p>

      <h3>{t("confirm.undo")}</h3>
      <p className={def.tier === "irreversible" ? "danger" : ""}>
        {def.tier === "irreversible" ? t("confirm.undo.no") : t("confirm.undo.yes")}
      </p>
      <p className="muted small">{t(`tier.${def.tier}.help`)}</p>

      {def.requiresAdmin && !state.info?.isElevated ? (
        <p className="warn-box">{t("confirm.adminNote")}</p>
      ) : null}

      {needsTyping ? (
        <label className="field">
          <span>{t("confirm.typed", { word })}</span>
          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-invalid={typed.length > 0 && !typedOk}
            aria-describedby="confirm-typed-hint"
          />
          {/* The hint is the instruction, the mismatch is the verdict. Showing
              only the verdict after a wrong attempt withholds the rule. */}
          <span id="confirm-typed-hint" className="muted small">
            {t("confirm.typed.hint")}
          </span>
          {typed.length > 0 && !typedOk ? (
            <span className="muted small">{t("confirm.typed.mismatch")}</span>
          ) : null}
        </label>
      ) : null}

      <footer className="dialog-actions">
        <button className="btn btn-quiet" type="button" onClick={() => dispatch({ type: "overlay/close" })}>
          {t("confirm.cancel")}
        </button>
        <button
          className={`btn ${needsTyping ? "btn-danger" : "btn-primary"}`}
          type="button"
          disabled={!typedOk || busy}
          onClick={async () => {
            setBusy(true);
            await actions.execute(def.id, typed);
            setBusy(false);
            dispatch({ type: "overlay/close" });
          }}
        >
          {needsTyping ? t("confirm.goDestructive", { verb: word.toLocaleLowerCase() }) : t("confirm.go")}
        </button>
      </footer>
    </Overlay>
  );
}

export function ScriptDialog({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const script = state.script;
  const [format, setFormat] = useState<"ps1" | "bat">("ps1");
  const [copied, setCopied] = useState(false);
  if (!script) {
    return null;
  }
  const def = state.reports[script.actionId];
  const commands = COMMANDS[script.actionId] ?? [];
  const body =
    commands.length === 0
      ? "# This action has no external command; the core performs it directly."
      : format === "ps1"
        ? commands.map((command, index) => `# step ${index + 1}\n${command}`).join("\n")
        : commands.join("\r\n");

  return (
    <Overlay label={t("script.title")} onClose={() => dispatch({ type: "overlay/close" })}>
      <h2>{t("script.title")}</h2>
      <p>{t("script.subtitle")}</p>
      {def ? <p className="muted">{t.tKey(def.metricKey, def.metricParams)}</p> : null}
      <div className="segmented">
        <button type="button" aria-pressed={format === "ps1"} onClick={() => setFormat("ps1")}>
          {t("script.ps1")}
        </button>
        <button type="button" aria-pressed={format === "bat"} onClick={() => setFormat("bat")}>
          {t("script.bat")}
        </button>
      </div>
      <pre className="script mono" aria-label={t("script.title")}>
        {body}
      </pre>
      <p className="warn-box">{t("script.warning")}</p>
      <footer className="dialog-actions">
        <button
          className="btn btn-quiet"
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(body)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? t("script.copied") : t("script.copy")}
        </button>
        <button
          className="btn"
          type="button"
          onClick={() =>
            void actions.saveScript(`zenith-${script.actionId}.${format}`, body, format)
          }
        >
          {t("script.save")}
        </button>
        <button className="btn btn-quiet" type="button" onClick={() => dispatch({ type: "overlay/close" })}>
          {t("misc.close")}
        </button>
      </footer>
    </Overlay>
  );
}

export function PurgeDialog({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const [scope, setScope] = useState<"support" | "logs" | "snapshots" | "all">("support");
  const [token, setToken] = useState("");
  const [force, setForce] = useState(false);

  return (
    <Overlay label={t("trust.purge.confirmTitle")} onClose={() => dispatch({ type: "overlay/close" })}>
      <h2>{t("trust.purge.confirmTitle")}</h2>
      <p>{t("trust.purge.confirmBody")}</p>

      <fieldset className="field">
        <legend>{t("trust.purge.scope")}</legend>
        {(["support", "logs", "snapshots", "all"] as const).map((value) => (
          <label key={value} className="radio">
            <input
              type="radio"
              name="purge-scope"
              value={value}
              checked={scope === value}
              onChange={() => setScope(value)}
            />
            <span>{t(`trust.purge.${value}`)}</span>
          </label>
        ))}
      </fieldset>

      {scope === "snapshots" || scope === "all" ? (
        <label className="toggle">
          <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
          <span>{t("trust.purge.force")}</span>
        </label>
      ) : null}

      <label className="field">
        <span>{t("trust.purge.token")}</span>
        <input
          autoFocus
          type="text"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>

      <footer className="dialog-actions">
        <button className="btn btn-quiet" type="button" onClick={() => dispatch({ type: "overlay/close" })}>
          {t("confirm.cancel")}
        </button>
        <button
          className="btn btn-danger"
          type="button"
          disabled={token !== "PURGE" || !state.info}
          onClick={async () => {
            await actions.purge(scope, token, force);
            dispatch({ type: "overlay/close" });
          }}
        >
          {t("trust.purge.action")}
        </button>
      </footer>
    </Overlay>
  );
}

function candidateKey(kind: NonNullable<State["candidateKind"]>, item: CandidateItem): string {
  if (kind === "dev_ports" && "port" in item) {
    return `${item.port}:${item.pid}`;
  }
  if (kind === "hung_office" && "hungForMs" in item) {
    return `${item.pid}:${item.startTimeUnixMs}`;
  }
  if (kind === "print_jobs" && "jobId" in item) {
    return `job:${item.jobId}`;
  }
  if ("distro" in item) {
    return `distro:${item.distro}`;
  }
  return JSON.stringify(item);
}

export function CandidatesDialog({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const bridge = useBridge();
  const kind = state.candidateKind;
  const [data, setData] = useState<Candidates | null>(null);
  // The rejection is an `IpcError` *object*, not an `Error`: `native.ts` and the
  // simulator both reject with the wire shape. Storing it as a string meant the
  // fallback `String(reason)` ran and the dialog printed `[object Object]` - the
  // one place in the UI where a user saw a JavaScript internal instead of a
  // catalogue sentence (DEF-107).
  const [error, setError] = useState<IpcError | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<TerminateSummary | null>(null);
  const [scanNonce, setScanNonce] = useState(0);
  const [scanning, setScanning] = useState(false);
  // A stop the user asked for is not a failure. Without this flag the cancelled
  // scan's `CANCELLED` rejection would surface as an error toast for an outcome
  // the user chose, so the flag routes it to the quiet "stopped" line instead.
  const [stopped, setStopped] = useState(false);
  const cancelledByUser = useRef(false);

  useEffect(() => {
    if (!kind) {
      return;
    }
    let live = true;
    setData(null);
    setError(null);
    setStopped(false);
    setScanning(true);
    cancelledByUser.current = false;
    bridge
      .candidates(kind)
      .then((next) => {
        if (live) {
          setData(next);
        }
      })
      .catch((reason: unknown) => {
        if (!live) {
          return;
        }
        if (cancelledByUser.current) {
          cancelledByUser.current = false;
          setStopped(true);
          return;
        }
        setError(asIpcError(reason));
      })
      .finally(() => {
        if (live) {
          setScanning(false);
        }
      });
    return () => {
      live = false;
    };
  }, [bridge, kind, scanNonce]);

  if (!kind) {
    return null;
  }

  const terminable = kind === "dev_ports" || kind === "hung_office";
  const items = data?.items ?? [];

  // A hung window's caption can be empty: `hung_office` returns the caption of
  // the window `IsHungAppWindow` actually flagged, and a document window that
  // has not finished loading yet has no title. Rendering "" would leave the row
  // blank and make `hung.select` say "Select window  in WINWORD.EXE"; both now
  // fall back to a named placeholder (DEF-112).
  const windowName = (title: string): string =>
    title.trim().length > 0 ? title : t("hung.untitled");

  const targets: VerifiedPidTarget[] = items
    .filter((item) => selected.includes(candidateKey(kind, item)))
    .map((item) => {
      if ("startTimeUnixMs" in item && "processName" in item) {
        return {
          pid: item.pid,
          expectedName: item.processName,
          expectedStartTimeUnixMs: item.startTimeUnixMs,
        };
      }
      return null;
    })
    .filter((item): item is VerifiedPidTarget => item !== null);

  return (
    <Overlay
      label={t(kind === "dev_ports" ? "ports.title" : kind === "hung_office" ? "hung.title" : kind === "print_jobs" ? "spooler.title" : "wsl.title")}
      onClose={() => dispatch({ type: "overlay/close" })}
    >
      <h2>
        {t(kind === "dev_ports" ? "ports.title" : kind === "hung_office" ? "hung.title" : kind === "print_jobs" ? "spooler.title" : "wsl.title")}
      </h2>
      <p>{t(kind === "dev_ports" ? "ports.subtitle" : kind === "hung_office" ? "hung.subtitle" : "ports.subtitle")}</p>

      {error ? (
        <div className="danger" role="alert">
          <p>{t.tKey(error.messageKey, error.params)}</p>
          <p className="muted">{t.tKey(error.remedyKey)}</p>
        </div>
      ) : null}
      {stopped ? <p className="muted" role="status">{t("ports.scanStopped")}</p> : null}
      {!data && !error && !stopped ? <p className="muted">{t("ports.scanning")}</p> : null}
      {scanning && data ? <p className="muted">{t("ports.scanning")}</p> : null}
      {data && items.length === 0 ? (
        <p className="muted">
          {t(kind === "dev_ports" ? "ports.empty" : kind === "hung_office" ? "hung.empty" : kind === "print_jobs" ? "spooler.empty" : "wsl.empty")}
        </p>
      ) : null}

      {/*
       * One table, four columns, and the third column is the *measurement* the
       * catalogue promises for that family. Before this the third column was
       * always the process pair, so `ports.memory`, `ports.command`,
       * `hung.unresponsiveFor`, `spooler.owner`, `spooler.pages` and
       * `wsl.state` were shipped strings no user could ever read (DEF-089).
       * The fourth column exists only when a row can be ticked: a header named
       * "Select" over a column of empty cells (the print queue and WSL tables,
       * which are read-only) labels nothing (DEF-114).
       */}
      {items.length > 0 ? (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">
                {t(
                  kind === "dev_ports"
                    ? "ports.port"
                    : kind === "hung_office"
                      ? "hung.window"
                      : kind === "print_jobs"
                        ? "spooler.job"
                        : "wsl.distro",
                )}
              </th>
              <th scope="col">
                {t(
                  kind === "print_jobs"
                    ? "spooler.owner"
                    : kind === "wsl"
                      ? "wsl.state"
                      : "ports.process",
                )}
              </th>
              <th scope="col">
                {t(
                  kind === "dev_ports"
                    ? "ports.memory"
                    : kind === "hung_office"
                      ? "hung.unresponsiveForLabel"
                      : kind === "print_jobs"
                        ? "spooler.pages"
                        : "ports.memory",
                )}
              </th>
              {/* The selection column. It used to be a bare `<th scope="col" />`,
                  which a screen reader announces as "column 4" - a header with no
                  name over a column of checkboxes (DEF-112); and it was drawn even
                  for the read-only families, where every cell is empty (DEF-114). */}
              {terminable ? <th scope="col">{t("misc.selectRow")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const key = candidateKey(kind, item);
              const self = "isSelf" in item && item.isSelf;
              return (
                <tr key={key}>
                  <td>
                    {"port" in item ? `${item.port}` : null}
                    {"hungForMs" in item ? windowName(item.windowTitleRaw) : null}
                    {"jobId" in item ? item.document : null}
                    {"distro" in item ? `${item.distro}` : null}
                    {/*
                      * The command line is what tells a developer *which* of
                      * three `node.exe` listeners is the one to stop.
                      */}
                    {"commandLineRedacted" in item && item.commandLineRedacted ? (
                      <div className="mono small muted">{item.commandLineRedacted}</div>
                    ) : null}
                  </td>
                  <td>
                    {"processName" in item ? `${item.processName} · ${item.pid}` : null}
                    {"owner" in item ? item.owner : null}
                    {"distro" in item ? item.state : null}
                  </td>
                  <td>
                    {"memoryMb" in item && item.memoryMb > 0
                      ? t.formatBytes(item.memoryMb * 1024 * 1024)
                      : null}
                    {"hungForMs" in item
                      ? t("hung.unresponsiveAtLeast", {
                          ms: t.formatDuration(item.hungForMs),
                        })
                      : null}
                    {"pages" in item ? `${item.pages}` : null}
                    {"distro" in item
                      ? item.vmMemoryMb == null
                        ? NOT_MEASURED
                        : t.formatBytes(item.vmMemoryMb * 1024 * 1024)
                      : null}
                  </td>
                  {terminable ? (
                    <td>
                      {self ? (
                        // Says *before* the tick what the core enforces anyway.
                        <span className="badge is-warn">{t("ports.self")}</span>
                      ) : (
                        <input
                          type="checkbox"
                          // The accessible name is a sentence, not the row key.
                          // It used to be `aria-label={key}` - literal "3000:14208"
                          // - which a screen reader announces as a string of digits
                          // with a colon in it. That is a label a sighted user never
                          // needs (the row is right there) and a blind user cannot
                          // use (it names neither the port nor the process). The
                          // test for DEF-090 pinned the raw key, so the defect was
                          // certified by its own test.
                          aria-label={
                            kind === "dev_ports" && "port" in item
                              ? t("ports.select", {
                                  port: item.port,
                                  process: item.processName,
                                  pid: item.pid,
                                })
                              : kind === "hung_office" && "hungForMs" in item
                                ? t("hung.select", {
                                    title: windowName(item.windowTitleRaw),
                                    process: item.processName,
                                    pid: item.pid,
                                  })
                                : key
                          }
                          checked={selected.includes(key)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, key]
                                : current.filter((entry) => entry !== key),
                            )
                          }
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {result ? (
        <p className="muted small" role="status">
          {t("ports.result", {
            terminated: result.terminated,
            requested: result.requested,
          })}
        </p>
      ) : null}

      <footer className="dialog-actions">
        {scanning ? (
          // The scan honours its token between printers and between jobs, which
          // is the promise `candidates.rs` makes in its own doc comment. Until
          // this button existed nothing ever cancelled one: a spooler with two
          // hundred queued jobs held the dialog until every queue was read
          // (DEF-108).
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => {
              cancelledByUser.current = true;
              void actions.cancel("scan");
            }}
          >
            {t("ports.cancelScan")}
          </button>
        ) : (
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => {
              setSelected([]);
              setResult(null);
              setScanNonce((n) => n + 1);
            }}
          >
            {t("ports.refresh")}
          </button>
        )}
        <button className="btn btn-quiet" type="button" onClick={() => dispatch({ type: "overlay/close" })}>
          {t("misc.close")}
        </button>
        {terminable ? (
          <button
            className="btn btn-primary"
            type="button"
            disabled={targets.length === 0}
            onClick={async () => {
              const summary = await actions.terminate(
                kind === "dev_ports" ? "unlock-dev-ports" : "close-hung-office",
                targets,
              );
              if (summary) {
                setResult(summary);
                setSelected([]);
                setScanNonce((n) => n + 1);
              }
            }}
          >
            {t(kind === "dev_ports" ? "ports.stop" : "hung.close")}
          </button>
        ) : null}
      </footer>
    </Overlay>
  );
}
