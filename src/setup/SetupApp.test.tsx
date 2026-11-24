/**
 * The six installer states, rendered and asserted one by one.
 *
 * These are DOM tests, not snapshots: a snapshot of a 640x420 card mostly
 * records whitespace, while the brand rules worth enforcing are exact strings
 * and exact absences (no version pill, no second close button, the checkbox
 * unchecked by default, Arabic mirrored).
 */

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_VERSION, SetupApp, readLaunch, type SetupAppProps } from "./SetupApp";
import { SETUP_LANGUAGES, interpolate, setupDirection, setupStringsFor } from "./setupCopy";

afterEach(cleanup);

function renderState(props: SetupAppProps) {
  return render(<SetupApp autoplay={false} language="en" {...props} />);
}

describe("welcome", () => {
  it("shows the name alone, with the version only inside the sentence", () => {
    renderState({ screen: "welcome" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Zenith");
    const body = screen.getByText(/Setup installs Zenith 1\.0\.0 on this computer\./);
    expect(body.textContent).toContain(APP_VERSION);
    // No pill, badge or second occurrence anywhere in the card.
    const occurrences = (document.body.textContent ?? "").split(APP_VERSION).length - 1;
    expect(occurrences).toBe(1);
  });

  it("offers Install, Options and the footer caption", () => {
    renderState({ screen: "welcome" });
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Options/ })).toBeTruthy();
    expect(screen.getByText("Local-first - no telemetry, no account, no cloud.")).toBeTruthy();
  });

  it("switches the sentence and the verb for an update", () => {
    renderState({ screen: "welcome", oldVersion: "0.9.4" });
    expect(screen.getByText(/updates Zenith from 0\.9\.4 to 1\.0\.0/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });
});

describe("options", () => {
  it("is closed by default and opens on the options link", () => {
    renderState({ screen: "welcome" });
    const sheet = document.querySelector(".setup-options");
    expect(sheet?.className).not.toContain("is-open");
    fireEvent.click(screen.getByRole("button", { name: /Options/ }));
    expect(document.querySelector(".setup-options")?.className).toContain("is-open");
  });

  it("carries all 73 languages", () => {
    renderState({ screen: "welcome", sheetOpen: true });
    const selects = screen.getAllByRole("combobox");
    expect(SETUP_LANGUAGES).toHaveLength(73);
    for (const select of selects) {
      expect(select.querySelectorAll("option")).toHaveLength(73);
    }
  });

  it("shows the install directory, the four checkboxes and the size line", () => {
    renderState({ screen: "welcome", sheetOpen: true });
    expect(screen.getByLabelText("Install location")).toBeTruthy();
    // The wizard's folder must be the one the shipped installer writes to. It
    // said %LOCALAPPDATA%\Programs\Zenith while tauri.conf.json installs
    // perMachine into C:\Program Files\Zenith, so the first screen a user saw
    // named a directory the product never used.
    expect((screen.getByLabelText("Install location") as HTMLInputElement).value).toBe("C:\\Program Files\\Zenith");
    const checks = document.querySelectorAll(".setup-check input[type=checkbox]");
    expect(checks).toHaveLength(4);
    expect((checks[0] as HTMLInputElement).checked).toBe(true);
    expect((checks[2] as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Zenith needs about 18 MB of disk space.")).toBeTruthy();
  });
});

describe("progress", () => {
  it("renders a deterministic percentage and hides Close", () => {
    renderState({ screen: "progress", progress: 42 });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("says Removing in uninstall mode", () => {
    renderState({ mode: "uninstall", screen: "progress", progress: 10 });
    expect(screen.getByText("Removing Zenith...")).toBeTruthy();
  });
});

describe("done", () => {
  it("shows the check burst and both actions", () => {
    const onWindowAction = vi.fn();
    renderState({ screen: "done", onWindowAction });
    expect(screen.getByText("Zenith is ready")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Launch Zenith" }));
    expect(onWindowAction).toHaveBeenCalledWith("launch");
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(onWindowAction).toHaveBeenCalledWith("close");
  });
});

describe("uninstall", () => {
  it("leaves the delete-data box unchecked and shows the data directory", () => {
    renderState({ mode: "uninstall", screen: "uninstall" });
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.body.textContent).toContain("%LOCALAPPDATA%\\Vellium\\Zenith");
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("has the compact language selector in the title bar", () => {
    renderState({ mode: "uninstall", screen: "uninstall" });
    expect(document.querySelectorAll(".setup-lang-compact")).toHaveLength(1);
  });
});

describe("uninstalled", () => {
  it("reports kept data, and deleted data when the box was checked", () => {
    const { unmount } = renderState({ mode: "uninstall", screen: "uninstalled" });
    expect(screen.getByText(/was kept in %LOCALAPPDATA%\\Vellium\\Zenith/)).toBeTruthy();
    unmount();
    renderState({ mode: "uninstall", screen: "uninstalled", deleteData: true });
    expect(screen.getByText("Your saved data was deleted from this computer.")).toBeTruthy();
  });
});

describe("failed", () => {
  it("shows the detail as selectable text plus the two actions", () => {
    renderState({ screen: "failed", errorDetail: "ACCESS_DENIED" });
    expect(screen.getByText("ACCESS_DENIED")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Close/ })).toHaveLength(2);
  });
});

describe("RTL", () => {
  it("marks Arabic rtl and translates the window title", () => {
    renderState({ mode: "uninstall", screen: "uninstall", language: "ar" });
    const card = document.querySelector(".setup-card");
    expect(card?.getAttribute("dir")).toBe("rtl");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("إزالة Zenith");
    expect(setupDirection("ar")).toBe("rtl");
  });
});

describe("copy", () => {
  it("fills placeholders and leaves unknown names visible", () => {
    const strings = setupStringsFor("tr");
    expect(interpolate(strings.footer, { app: "Zenith" } as never)).toBe(
      "Yerel öncelikli - telemetri yok, hesap yok, bulut yok.",
    );
    expect(interpolate("{missing}", {} as never)).toBe("{missing}");
  });

  it("falls back to English for a locale without a wizard copy", () => {
    expect(setupStringsFor("ja").install).toBe("Install");
  });
});

describe("launch contract", () => {
  it("reads setup and uninstall from the query string", () => {
    expect(readLaunch("?setup=1").mode).toBe("setup");
    expect(readLaunch("?uninstall=1").mode).toBe("uninstall");
    expect(readLaunch("?uninstall=1&state=uninstall").screen).toBe("uninstall");
    expect(readLaunch("?state=options").sheetOpen).toBe(true);
    expect(readLaunch("?state=progress&progress=60").progress).toBe(60);
    expect(readLaunch("?state=progress").autoplay).toBe(false);
    expect(readLaunch("?state=progress&progress=999").progress).toBe(100);
  });
});
