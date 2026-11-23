/**
 * English source catalogue. Every other locale is checked against this key set
 * at build time (`scripts/check-locales.mjs`), so a missing translation is a CI
 * failure rather than a `⟦key⟧` in front of a user.
 *
 * Naming follows the core, not the UI: `diag.*` and `steps.*` and `errors.*` are
 * produced by Rust and must exist here verbatim. `ui.*` keys are owned by the
 * renderer. That split is the reason the two halves never disagree.
 */

export const en = {
  // ---------------------------------------------------------------- app shell
  "app.name": "Zenith",
  "app.tagline": "Diagnose first. Change second.",

  "mode.simulation": "SIMULATION MODE - NO OS CHANGES",
  "mode.simulation.detail":
    "No native host is connected, so nothing here can touch this PC. Data below is generated.",
  "mode.admin": "Administrator",
  "mode.standard": "Standard user",

  // ---------------------------------------------------------------------- nav
  // One key per destination, and one for the landmark. `nav.ts` maps
  // `ScreenId` to these exhaustively, so a screen without a label is a compile
  // error rather than a sidebar entry that silently goes nowhere (DEF-145).
  "nav.title": "Main navigation",
  "nav.actions": "All actions",
  "nav.snapshots": "Undo history",
  "nav.activity": "Activity log",
  "nav.trust": "Trust Center",
  "nav.settings": "Settings",
  "nav.help": "Help",

  // ------------------------------------------------------------------ titlebar
  "titlebar.theme": "Theme",
  "titlebar.theme.offWhite": "Off-white",
  "titlebar.theme.trueBlack": "True black",
  "titlebar.theme.spatialGlass": "Spatial glass",
  "titlebar.reducedMotion": "Reduce motion",
  "settings.behaviour": "Behaviour",
  "titlebar.palette": "Command palette",
  "titlebar.notifications": "Notices",
  "titlebar.notifications.empty": "Nothing to report.",
  "titlebar.notifications.count": "{count, plural, =0 {No notices} one {1 notice} other {# notices}}",

  // --------------------------------------------------------- window controls
  // The window is undecorated, so these three names are the only names the
  // buttons have: the icons carry no text. They must exist in every locale or
  // a screen reader announces "button" three times in a row (DEF-120).
  "win.minimize": "Minimise",
  "win.maximize": "Maximise",
  "win.restore": "Restore",
  "win.close": "Close",

  // -------------------------------------------------------------- health strip
  "health.title": "System health",
  "health.score": "Score {score}/100",
  "health.scoreLabel": "Health score",
  "health.junk": "Junk",
  "health.dns": "DNS",
  "health.memory": "RAM",
  "health.issues": "Issues",
  "health.issues.value": "{count, plural, =0 {None} one {1 item} other {# items}}",
  "health.diagnose": "Diagnose all",
  "health.diagnosing": "Diagnosing {done}/{total}",
  "health.cancel": "Stop",
  "health.never": "Not measured yet",
  "health.measuredAt": "measured {time}",

  // ------------------------------------------------------------ category tabs
  "tabs.all": "All",
"tabs.categories": "Action categories",
  "tabs.cleanup": "Cleanup",
  "tabs.network": "Network",
  "tabs.recovery": "Recovery",
  "tabs.devOffice": "Dev & Office",
  "tabs.search": "Search actions",
  "tabs.search.placeholder": "Search by name or effect…",
  "tabs.search.empty": "No action matches “{query}”.",

  // ------------------------------------------------------------------- actions
  /*
   * The Actions page header. Every other screen opens with an `<h2>` and a
   * sentence saying what it is for; the grid did not, and a user who landed on
   * it saw cards with no frame telling them what the screen was. These two
   * keys are the frame, and they are also what makes the heading order correct:
   * one `<h2>` for the page, then one `<h3>` per card.
   */
  "actions.pageTitle": "All actions",
  "actions.pageSubtitle":
    "Each card reports what Zenith measured. Nothing runs until you confirm it.",

  "actions.cleanTempCache.title": "Clean temporary files",
  "actions.cleanTempCache.desc":
    "Delete files in Temp folders that have not changed for 24 hours. Files in use are skipped.",
  "actions.cleanTempCache.done": "Completed: Clean temporary files",
  "actions.emptyRecycleBin.title": "Empty the Recycle Bin",
  "actions.emptyRecycleBin.desc":
    "Permanently delete everything currently in the Recycle Bin. This cannot be undone.",
  "actions.emptyRecycleBin.done": "Completed: Empty the Recycle Bin",
  "actions.archiveScreenshots.title": "Archive old screenshots",
  "actions.archiveScreenshots.desc":
    "Move screenshots older than 30 days into a dated archive folder instead of deleting them.",
  "actions.archiveScreenshots.done": "Completed: Archive old screenshots",
  "actions.wingetUpgradeAll.title": "Upgrade installed programs",
  "actions.wingetUpgradeAll.desc":
    "Run a WinGet upgrade for every package that has a newer version available.",
  "actions.wingetUpgradeAll.done": "Completed: Upgrade installed programs",
  "actions.windowsUpdateScan.title": "Check for Windows updates",
  "actions.windowsUpdateScan.desc":
    "Ask Windows Update to look for updates now. Nothing is installed without your approval.",
  "actions.windowsUpdateScan.done": "Completed: Check for Windows updates",
  "actions.flushDnsCache.title": "Flush the DNS cache",
  "actions.flushDnsCache.desc":
    "Clear stored host lookups so the next request asks the resolver again.",
  "actions.flushDnsCache.done": "Completed: Flush the DNS cache",
  "actions.resetWinsockStack.title": "Reset the network stack",
  "actions.resetWinsockStack.desc":
    "Restore Winsock and TCP/IP to their default state. Requires a restart to finish.",
  "actions.resetWinsockStack.done": "Completed: Reset the network stack",
  "actions.clearStuckProxyVpn.title": "Clear a stuck proxy",
  "actions.clearStuckProxyVpn.desc":
    "Turn off a proxy switch that is enabled but points at no server - the classic “no internet after VPN” state.",
  "actions.clearStuckProxyVpn.done": "Completed: Clear a stuck proxy",
  "actions.syncNtpTime.title": "Sync the clock",
  "actions.syncNtpTime.desc":
    "Start the Windows time service and force a resync against the configured time server.",
  "actions.syncNtpTime.done": "Completed: Sync the clock",
  "actions.copySysadminInfo.title": "Copy system information",
  "actions.copySysadminInfo.desc":
    "Collect the model, serial, OS build and installed memory into a text block for a ticket.",
  "actions.copySysadminInfo.done": "Completed: Copy system information",
  "actions.dismRestoreHealth.title": "Repair the component store",
  "actions.dismRestoreHealth.desc":
    "Run DISM RestoreHealth, which repairs the image Windows uses to fix its own files. Slow.",
  "actions.dismRestoreHealth.done": "Completed: Repair the component store",
  "actions.sfcSystemScan.title": "Scan system files",
  "actions.sfcSystemScan.desc":
    "Run System File Checker, which replaces damaged Windows files from the repaired store.",
  "actions.sfcSystemScan.done": "Completed: Scan system files",
  "actions.restartExplorer.title": "Restart Explorer",
  "actions.restartExplorer.desc":
    "Restart the shell. Open File Explorer windows close; taskbar icons reload.",
  "actions.restartExplorer.done": "Completed: Restart Explorer",
  "actions.rebuildIconCache.title": "Rebuild the icon cache",
  "actions.rebuildIconCache.desc":
    "Delete the icon database so Windows rebuilds it. Fixes blank or wrong file icons.",
  "actions.rebuildIconCache.done": "Completed: Rebuild the icon cache",
  "actions.restartBluetooth.title": "Restart Bluetooth",
  "actions.restartBluetooth.desc":
    "Restart the Bluetooth support service. Paired devices reconnect on their own.",
  "actions.restartBluetooth.done": "Completed: Restart Bluetooth",
  "actions.resetPrintSpooler.title": "Reset the print queue",
  "actions.resetPrintSpooler.desc":
    "Stop the spooler, clear queued jobs, and start it again. Fixes a stuck print queue.",
  "actions.resetPrintSpooler.done": "Completed: Reset the print queue",
  "actions.resetGpuDriver.title": "Reset the graphics driver",
  "actions.resetGpuDriver.desc":
    "Ask Windows to restart the display driver. The screen flashes black for a moment.",
  "actions.resetGpuDriver.done": "Completed: Reset the graphics driver",
  "actions.controlledReboot.title": "Restart with a countdown",
  "actions.controlledReboot.desc":
    "Restart this PC after a 30-second countdown so you can save your work and cancel.",
  "actions.controlledReboot.done": "Completed: Restart with a countdown",
  "actions.unlockDevPorts.title": "Free a development port",
  "actions.unlockDevPorts.desc":
    "Find which process holds a port and stop that one process after confirming it is the right one.",
  "actions.unlockDevPorts.done": "Completed: Free a development port",
  "actions.closeHungOffice.title": "Close frozen Office windows",
  "actions.closeHungOffice.desc":
    "Find Word, Excel, PowerPoint or Outlook windows that stopped responding and close them.",
  "actions.closeHungOffice.done": "Completed: Close frozen Office windows",
  "actions.clearTeamsOutlookCache.title": "Clear Teams and Outlook caches",
  "actions.clearTeamsOutlookCache.desc":
    "Delete local caches that cause stale avatars, missing mail and sign-in loops. Rebuilt on next launch.",
  "actions.clearTeamsOutlookCache.done": "Completed: Clear Teams and Outlook caches",
  "actions.reclaimWslDockerRam.title": "Reclaim WSL and Docker memory",
  "actions.reclaimWslDockerRam.desc":
    "Shut down the WSL virtual machine, which releases the memory Docker and Linux distros were holding.",
  "actions.reclaimWslDockerRam.done": "Completed: Reclaim WSL and Docker memory",


  // ----------------------------------------------------------------- card body
  "card.unknown": "Not measured",
  "card.readOnly": "Read-only report",
  "card.latency": "{ms} ms",
  "card.run": "Run",
  "card.runAsAdmin": "Run as administrator",
  "card.cancel": "Cancel",
  "card.rollback": "Undo",
  "card.report": "Details",
  "card.requiresAdmin": "Needs admin",
  "card.requiresReboot": "Restart needed",
  "card.abortable": "Can be stopped",
  "card.pin": "Pin to the front",
  "card.unpin": "Unpin",
  "card.hide": "Hide",
  "card.unhide": "Show",
  "card.showHidden": "Show {count, plural, one {# hidden action} other {# hidden actions}}",
  "card.hiddenTitle": "Hidden actions",
  "card.hiddenBody":
    "Hiding removes a card from the default grid. The action still works and stays reachable here.",

  // ---------------------------------------------------------------------- tiers
  "tier.fully_reversible": "Fully reversible",
  "tier.partially_reversible": "Partly reversible",
  "tier.compensating_recovery": "Best-effort recovery",
  "tier.irreversible": "Cannot be undone",
  "tier.fully_reversible.help": "The exact previous state is saved and can be restored.",
  "tier.partially_reversible.help":
    "A snapshot is taken, but some effects rebuild differently when restored.",
  "tier.compensating_recovery.help":
    "An export or restore point is made so a best-effort return is possible - not an exact one.",
  "tier.irreversible.help": "Nothing is kept. Whatever this changes stays changed.",

  "risk.safe": "Safe",
  "risk.moderate": "Moderate",
  "risk.destructive": "Destructive",

  // ------------------------------------------------------------------ diagnosis
  "diag.unavailable": "Could not measure: {reason}",
  "diag.observationalOnly": "Report only - no change is made from this screen.",
  "diag.junkOver": "{mb, number} MB of temporary files older than {minAgeHours} h.",
  "diag.junkUnder": "{mb, number} MB of temporary files - under the threshold.",
  "diag.recycleOver": "{mb, number} MB in the Recycle Bin across {items, plural, one {# item} other {# items}}.",
  "diag.recycleUnder": "{mb, number} MB in the Recycle Bin - nothing unusual.",
  "diag.noFolder": "No Screenshots folder exists yet.",
  "diag.screenshotsMany": "{files, plural, one {# screenshot} other {# screenshots}} older than {days} days ({mb, number} MB).",
  "diag.screenshotsFew": "{files, plural, one {# screenshot} other {# screenshots}} older than {days} days.",
  "diag.cacheOver": "{mb, number} MB of Office and Teams cache.",
  "diag.cacheUnder": "{mb, number} MB of Office and Teams cache - under the threshold.",
  "diag.iconCacheOver": "The icon cache is {mb, number} MB and may be corrupt.",
  "diag.iconCacheUnder": "The icon cache is {mb, number} MB.",
  "diag.dnsFailed": "The resolver did not answer ({detail}).",
  "diag.dnsSlow": "Lookups take {ms} ms (threshold {threshold} ms).",
  "diag.dnsFast": "Lookups take {ms} ms.",
  "diag.winsockLastReset": "Last reset {days, plural, one {# day} other {# days}} ago.",
  "diag.winsockNeverReset": "Never reset on this installation.",
  "diag.proxyStuck": "The proxy switch is on but no server is set - this blocks most traffic.",
  "diag.proxyConfigured": "A proxy is configured and enabled.",
  "diag.proxyDirect": "No proxy is configured; traffic goes direct.",
  "diag.timeServiceRunning": "The time service is {state}.",
  "diag.timeServiceStopped": "The time service is {state}, so the clock can drift.",
  "diag.portsFree": "No process is listening on development ports.",
  "diag.portsBusy": "{count, plural, one {# process holds} other {# processes hold}} a development port: {ports}.",
  "diag.serviceRunning": "Service {service} is {state}.",
  "diag.serviceStopped": "Service {service} is {state}.",
  "diag.explorerMissing": "Explorer is not running.",
  "diag.explorerRunning": "{count, plural, one {# Explorer process} other {# Explorer processes}} running.",
  "diag.uptimeLong": "This PC has been up for {days} days.",
  "diag.uptimeShort": "Uptime is {days} days.",
  "diag.memoryHigh": "Memory is {percent}% used ({usedMb} of {totalMb} MB).",
  "diag.memoryNormal": "Memory is {percent}% used.",
  "diag.wslIdle": "WSL is not holding memory right now.",
  "diag.wslHolding": "WSL and Docker are holding {vmmemMb} MB.",
  "diag.officeHung": "{hung, plural, one {# Office window has} other {# Office windows have}} stopped responding ({running} running).",
  "diag.officeNotRunning": "No Office application is running.",
  "diag.officeHealthy": "{running, plural, one {# Office application} other {# Office applications}} responding.",
  "diag.toolPresent": "{program} found at {path}.",
  "diag.toolMissing": "{program} is not installed, so this action cannot run.",
  "diag.updateNeverScanned": "Windows Update has never completed a check on this PC.",
  "diag.updateLastScan": "Last update check: {lastScan}.",
  "diag.cbsAge": "The component-store log was last written {days, plural, one {# day} other {# days}} ago.",
  "diag.sfc": "System file scan state.",

  // ---------------------------------------------------------------------- steps
  "steps.tempScanned": "Scanned temporary folders",
  "steps.tempDeleted": "Deleted old temporary files",
  "steps.tempSkippedInUse": "Skipped files that were in use",
  "steps.driveEmptied": "Emptied the Recycle Bin",
  "steps.noScreenshotFolder": "No Screenshots folder to archive",
  "steps.noOldScreenshots": "No screenshots older than 30 days",
  "steps.archiveWritten": "Wrote the archive",
  "steps.originalsRemoved": "Removed the archived originals",
  "steps.originalsInUse": "Some originals were locked and kept",
  "steps.dnsFlush": "Flushed the DNS cache",
  "steps.hiveExported": "Exported the network registry hive",
  "steps.winsockReset": "Reset the Winsock catalogue",
  "steps.ipReset": "Reset TCP/IP",
  "steps.proxyDisabled": "Turned the proxy switch off",
  "steps.proxyValuesRemoved": "Removed stale proxy values",
  "steps.infoGathered": "Collected system information",
  "steps.serviceRestarted": "Restarted the service",
  "steps.spoolerStopped": "Stopped the print spooler",
  "steps.jobsCleared": "Cleared queued print jobs",
  "steps.spoolerStarted": "Started the print spooler",
  "steps.explorerNotRunning": "Explorer was not running",
  "steps.explorerStopped": "Stopped Explorer",
  "steps.explorerStarted": "Started Explorer",
  "steps.cacheCleared": "Cleared the icon cache",
  "steps.iconCacheRefreshed": "Asked Windows to rebuild icons",
  "steps.gpuResetSent": "Sent the driver reset request",
  "steps.rebootScheduled": "Scheduled a restart in {seconds} seconds",
  "steps.processTerminated": "Stopped the process",
  "steps.processIdentityMismatch": "Refused: the process was not the same one that was scanned",
  "steps.processAccessDenied": "Refused: access denied",
  "steps.processGone": "The process had already exited",
  "steps.processSelfRefused": "Refused: that is Zenith itself",
  "steps.noHungOffice": "No Office window was frozen",
  "steps.hungClosed": "Closed the frozen window",
  "steps.cacheRootCleared": "Cleared the cache folder",
  "steps.commandTimedOut": "The command ran out of time",
  "steps.commandSucceeded": "The command finished",
  "steps.commandFailed": "The command failed",
  "steps.updateScanStarted": "Asked Windows Update to check now",

  // ------------------------------------------------------------------- outcomes
  "outcomes.none": "Not recorded",
  "outcomes.cancelled": "Cancelled before any change was made.",
  "outcomes.nothingTerminated": "No process was stopped.",
  "outcomes.dnsFlushed": "DNS cache flushed.",
  "outcomes.rollback": "Rollback completed.",

  // ------------------------------------------------------------- before / after
  // `ExecutionOutcome` carries a `beforeKey`/`afterKey` pair plus parameters: the
  // measured state on each side of a change. Until DEF-146 these keys existed
  // only in Rust: nineteen of them were emitted by `adapters/actions.rs` and
  // defined in no catalogue, because `check-step-keys` scanned `steps.*` and
  // `outcomes.*` and had never been taught the two families it also had to
  // cover. A surface that rendered one showed the raw key.
  "before.explorer": "{count, plural, =0 {No Explorer window was open} one {# Explorer window was open} other {# Explorer windows were open}}",
  "after.explorer": "{count, plural, =0 {No Explorer window is open} one {# Explorer window is open} other {# Explorer windows are open}}",
  "before.winsockCatalog": "Winsock catalogue backed up before the reset.",
  "after.winsockAborted": "Winsock reset was aborted; the catalogue was restored.",
  "before.gpuDriver": "Display driver identity recorded before the restart.",
  "after.gpuReset": "Display driver was restarted.",
  "after.dnsFlushed": "DNS cache was flushed.",
  "after.dnsFlushFailed": "Windows refused the DNS cache flush.",
  "after.proxyCleared": "{removed, plural, =0 {No proxy entry was set} one {# proxy entry was cleared} other {# proxy entries were cleared}}",
  "after.infoReady": "{lines, plural, =0 {No system information line was copied} one {# line of system information was copied} other {# lines of system information were copied}}",
  "before.officeCache": "{files, plural, =0 {No Office cache file was found} one {# Office cache file was found} other {# Office cache files were found}}",
  "after.recycleBinEmpty": "{drives, plural, =0 {No drive accepted the request} one {# drive was emptied} other {# drives were emptied}}",
  "after.nothingToArchive": "No screenshot was old enough to archive.",
  "after.rebootScheduled": "Restart scheduled in {seconds} seconds.",
  "after.rebootNotScheduled": "No restart was scheduled.",
  "after.noHungOffice": "No frozen Office window was found.",
  "after.officeCache": "{mb} MB of Office cache cleared{skipped, plural, =0 {} other {, # file skipped}}",
  "before.command": "Command to run: {program}",
  "before.updateScan": "Windows Update had not been asked to check yet.",
  "after.updateScanStarted": "Windows Update was asked to check for updates.",
  "before.tempJunk": "{mb} MB of temporary files in {files, plural, one {# file} other {# files}}",
  "after.tempCleared": "{mb} MB of temporary files removed",
  "before.screenshots": "{files, plural, =0 {No screenshot to archive} one {# screenshot to archive ({mb} MB)} other {# screenshots to archive ({mb} MB)}}",
  "after.archived": "{removed, plural, =0 {Nothing was archived} one {# screenshot moved to {archive}} other {# screenshots moved to {archive}}}",
  "before.uptime": "The machine had been up for {days, plural, one {# day} other {# days}}",
  "before.iconCache": "{files, plural, one {# icon cache file} other {# icon cache files}}",
  "after.iconCache": "{removed, plural, =0 {No icon cache file was removed} one {# icon cache file was removed} other {# icon cache files were removed}}",
  "before.selectedProcesses": "{count, plural, one {# process selected} other {# processes selected}}",
  "after.selectedProcesses": "{terminated, plural, one {# process stopped} other {# processes stopped}}{skipped, plural, =0 {} other {, # skipped}}",
  "before.hungOffice": "{count, plural, one {# frozen Office window} other {# frozen Office windows}}",
  "after.hungClosed": "{terminated, plural, =0 {No frozen window was closed} one {# frozen window was closed} other {# frozen windows were closed}}",
  // `state` arrives from the core as a stable machine id (`services::ServiceState::as_str`),
  // never as prose. Translating it here rather than in Rust keeps the core
  // language-free (ADR-010) and stops a Turkish window printing "running".
  "before.service": "{service} was {state, select, running {running} stopped {stopped} paused {paused} start_pending {starting} stop_pending {stopping} other {in an unknown state}}",
  "after.service": "{service} is {state, select, running {running} stopped {stopped} paused {paused} start_pending {starting} stop_pending {stopping} other {in an unknown state}}",
  "before.proxy": "Proxy {enabled, select, true {was enabled pointing at {server}} other {was not enabled}}",
  "before.recycleBin": "{mb} MB in {items, plural, =0 {no item} one {# item} other {# items}}",
  // Three states, never collapsed into one: a bin that could not be read is not
  // an empty bin, and a partial read must say how much of the picture it has.
  "before.recycleBinUnknown": "The Recycle Bin could not be read on this machine, so its size is unknown.",
  "before.recycleBinPartial": "{mb} MB across {measured} of {total, plural, one {# drive} other {# drives}}; the rest could not be read.",
  "after.winsockReset": "Winsock catalogue reset in {hive}",
  "after.commandTimedOut": "The command did not finish within {seconds} seconds",
  "after.commandFinished": "{program} exited with code {exitCode} after {seconds} seconds",

  // ------------------------------------------------------------------ snapshots
  "snapshots.title": "Undo history",
  "snapshots.empty": "No snapshots yet. Actions that can be undone create one automatically.",
  "snapshots.subtitle": "Every reversible change keeps a copy until you undo it or the retention limit removes it.",
  "snapshots.created": "Saved",
  "snapshots.size": "Size",
  "snapshots.tier": "Undo level",
  "snapshots.column.actions": "Action",
  "snapshots.restored": "Restored {time}",
  "snapshots.broken": "Damaged",
  "snapshots.undo": "Undo this change",
  "snapshots.exportCsv": "Export CSV",
  "snapshots.exportJson": "Export JSON",
  "snapshots.undoing": "Restoring…",
  "snapshots.alreadyRestored": "Already restored.",
  "snapshots.undoSuccess":
    "Restored {items, plural, =0 {no items} one {# item} other {# items}}{skipped, plural, =0 {} other {, # skipped}} in {ms} ms.",
  "snapshots.undoFailed": "The restore could not be completed. Nothing was deleted; the snapshot is still intact.",
  "snapshots.skippedReason.locked": "in use",
  "snapshots.skippedReason.outOfScope": "outside the allowed scope",
  "snapshots.skippedReason.missing": "no longer present",
  "snapshots.skippedReason.other": "skipped",

  // --------------------------------------------------------------------- notice
  "notices.title": "Notices",
  "notices.dismiss": "Dismiss",
  "notices.userFallbackStore":
    "The shared data folder is not writable, so Zenith is keeping its data in your user profile. Undo history works but is not shared with other accounts.",
  "notices.storeRecovered":
    "Recovered from an unclean shutdown: {pending} pending snapshot(s) abandoned, {orphans} orphan archive(s) quarantined.",
  "notices.storeQuarantined":
    "The database was unreadable and has been moved aside. The original file is kept in the quarantine folder for support.",
  "notices.resumeQueue":
    "Resuming {count, plural, one {# action} other {# actions}} requested before elevation: {actions}.",
  "notices.resumeDropped": "Ignored unknown resume items: {items}.",
  "notices.telemetryOff":
    "Telemetry is off. Nothing about this PC leaves it unless you export a support bundle.",
  "notices.retentionConsent":
    "{count, plural, one {# old restore point} other {# old restore points}} exceed the storage cap. They are kept until you remove them.",
  "notices.retentionPruned":
    "Housekeeping removed {snapshots} restored snapshot(s) and {quarantine} expired quarantined file(s).",

  // --------------------------------------------------------------------- errors
  "errors.invalidArgument": "That request was not valid.",
  "errors.alreadyRunning": "Another action is already running.",
  "errors.elevationRequired": "This action needs administrator rights.",
  "errors.handoverInvalid": "The administrator handover could not be verified.",
  "errors.confirmationRequired": "This action needs an explicit confirmation.",
  "errors.accessDenied": "Windows denied access to a file or process.",
  "errors.insufficientDisk": "There is not enough free space to save an undo copy.",
  "errors.dependencyNotMet": "A prerequisite action has not run yet.",
  "errors.scopeViolation": "A restore target fell outside the allowed scope, so it was refused.",
  "errors.integrity": "A saved snapshot failed its integrity check.",
  "errors.zipTraversal": "An archive entry tried to escape its folder and was blocked.",
  "errors.snapshotNotFound": "That snapshot no longer exists.",
  "errors.alreadyRestored": "That snapshot has already been restored.",
  "errors.snapshotFailed": "The undo copy could not be written, so nothing was changed.",
  "errors.pidVerification": "The process changed since it was scanned, so it was not stopped.",
  "errors.processGone": "The process had already exited.",
  "errors.serviceUnavailable": "The Windows service did not respond.",
  "errors.toolMissing": "A required program is not installed.",
  "errors.timeout": "The action took too long and was stopped.",
  "errors.cancelled": "The action was cancelled.",
  "errors.storeQuarantined": "The database was quarantined at startup.",
  "errors.migrationFailed": "The database could not be upgraded to the current version.",
  "errors.databaseBusy": "The database is busy. Try again in a moment.",
  "errors.notImplemented": "This part is not available on this build or platform.",
  "errors.internal": "Something went wrong inside Zenith.",

  "remedy.checkSelection": "Check what you selected and try again.",
  "remedy.waitOrCancel": "Wait for the current action to finish, or stop it first.",
  "remedy.restartAsAdmin": "Restart Zenith as administrator, or use “Run as administrator”.",
  "remedy.restartManually": "Close Zenith and start it again yourself, then retry.",
  "remedy.confirmAction": "Read the warning and confirm the action.",
  "remedy.closeHandlesOrElevate": "Close the program using that file, or run as administrator.",
  "remedy.freeSpace": "Free some disk space and try again.",
  "remedy.runPrerequisite": "Run the prerequisite action first.",
  "remedy.reportBug": "Create a support bundle and report this - it should not happen.",
  "remedy.createSupportBundle": "Create a support bundle so the cause can be found.",
  "remedy.refreshList": "Refresh the list.",
  "remedy.none": "No further step is needed.",
  "remedy.freeSpaceOrRetry": "Free some space, or try again.",
  "remedy.rescan": "Scan again and retry from the fresh list.",
  "remedy.checkService": "Check that the service exists and can start.",
  "remedy.installTool": "Install the missing program, then scan again.",
  "remedy.retryOrCancel": "Try again, or cancel.",
  "remedy.openTrustCenter": "Open the Trust Center to see what was recovered.",
  "remedy.retry": "Try again in a moment.",
  "remedy.updateApp": "Update Zenith to a build that supports this.",

  // ---------------------------------------------------------------- confirmations
  "confirm.title": "Confirm: {title}",
  "confirm.body": "You are about to change this PC. Read what happens first.",
  "confirm.effect": "What will happen",
  "confirm.undo": "Can it be undone?",
  "confirm.undo.yes": "Yes - a snapshot is saved first and can be restored from Undo history.",
  "confirm.undo.no": "No - nothing is saved. This cannot be reversed.",
  "confirm.typed": "Type {word} to continue",
  "confirm.typed.hint": "Type the word exactly as shown.",
  "confirm.typed.mismatch": "The word does not match yet.",
  "confirm.go": "Yes, continue",
  "confirm.goDestructive": "Yes, {verb} - cannot be undone",
  "confirm.cancel": "Cancel",
  "confirm.adminNote": "This will ask for administrator approval (UAC).",

  // -------------------------------------------------------------- action status
  "status.idle": "Idle",
  "status.diagnosing": "Diagnosing",
  "status.healthy": "Healthy",
  "status.needs_attention": "Needs attention",
  "status.running": "Running",
  "status.success": "Done",
  "status.error": "Failed",
  "status.skipped_dependency": "Skipped",
  "status.cancelled": "Cancelled",
  "status.rolled_back": "Restored",
  "status.lastScan": "Last scan {time}",
  "status.actions": "{count, plural, one {# action} other {# actions}}",
  "status.console": "Console",
  "status.snapshots": "Undo history",
  "status.trust": "Trust Center",
  "status.help": "Help",

  // -------------------------------------------------------------------- console
  "console.title": "Console",
  "console.empty": "Nothing has run yet. Output appears here while an action works.",
  "console.subtitle": "Every step Zenith took, with the reason and the result.",
  "console.clear": "Clear",
  "console.copy": "Copy",
  "console.copied": "Copied",
  "console.dropped": "… {count} earlier lines dropped",
  "console.running": "Running {action}",
  "console.cancelHint": "Press Esc to stop the running action.",
  // Lines the *shell* writes into the same list. A plain English string here
  // left a Turkish window half-translated (DEF-094).
  "console.bundleSaved": "Support bundle saved: {path}",
  "console.auditExported": "Audit export saved: {path}",

  // -------------------------------------------------------------------- palette
  "palette.placeholder": "Type a command or an action name…",
  "palette.empty": "No match.",
  "palette.group.navigate": "Go to",
  "palette.group.action": "Actions",
  "palette.group.settings": "Settings",
  "palette.nav.all": "Show all actions",
  "palette.nav.snapshots": "Undo history",
  "palette.nav.activity": "Activity log",
  "palette.nav.settings": "Settings",
  "palette.nav.trust": "Trust Center",
  "palette.nav.help": "Help and shortcuts",
  "palette.nav.diagnose": "Diagnose all",
  "palette.theme": "Switch theme",
  "palette.motion": "Toggle reduced motion",
  "palette.locale": "Switch language",

  // --------------------------------------------------------------------- ports
  "ports.title": "Development ports in use",
  "ports.subtitle": "Only the process you tick is stopped, and only if it is still the same process.",
  "ports.empty": "Nothing is listening on development ports.",
  "ports.port": "Port",
  "ports.process": "Process",
  "ports.memory": "Memory",
  "ports.command": "Command line",
  "ports.stop": "Stop selected",
  "ports.refresh": "Scan again",
  "ports.scanning": "Scanning…",
  "ports.self": "That is Zenith itself - it will not be stopped.",
  "ports.select": "Select port {port} in {process} (PID {pid})",
  "ports.result": "{terminated} of {requested} stopped.",
  "ports.cancelScan": "Stop scanning",
  "ports.scanStopped": "The scan was stopped. Nothing on this PC was changed.",

  // ---------------------------------------------------------------------- hung
  "hung.title": "Frozen Office windows",
  "hung.subtitle": "A window is listed only if it stopped responding to Windows.",
  "hung.empty": "No Office window is frozen.",
  "hung.window": "Window",
  "hung.unresponsiveForLabel": "Unresponsive",
  // The core reports a *floor* - Windows exposes hung-ness as a boolean, not a
  // duration - so the sentence must say "at least". The old `hung.unresponsiveFor`
  // claimed a measured duration nobody took, and is gone (DEF-112).
  "hung.unresponsiveAtLeast": "Unresponsive for at least {ms}",
  "hung.untitled": "Untitled window",
  "hung.close": "Close selected",
  "hung.select": "Select window {title} in {process} (PID {pid})",

  // ------------------------------------------------------------------- spooler
  "spooler.title": "Print queue",
  "spooler.empty": "The queue is empty.",
  "spooler.job": "Document",
  "spooler.owner": "Owner",
  "spooler.pages": "Pages",

  // ----------------------------------------------------------------------- wsl
  "wsl.title": "WSL and Docker",
  "wsl.empty": "No distribution is running.",
  "wsl.distro": "Distribution",
  "wsl.state": "State",

  // --------------------------------------------------------------------- script
  "script.title": "Export a script",
  "script.subtitle":
    "These are the commands this action runs, written out so you can inspect or run them yourself.",
  "script.ps1": "PowerShell",
  "script.bat": "Command Prompt",
  "script.save": "Save…",
  "script.copy": "Copy",
  "script.copied": "Copied",
  "script.warning":
    "Running these by hand skips Zenith's snapshot and verification steps.",

  // ---------------------------------------------------------------- trust center
  "trust.title": "Trust Center",
  "trust.subtitle": "What Zenith is, what it can reach, and where your data is.",
  "trust.version": "Version",
  "trust.build": "Build",
  "trust.signature": "Signature",
  "trust.signature.valid": "Signed and valid",
  "trust.signature.unsigned": "Unsigned build",
  "trust.signature.invalid": "Signature invalid",
  "trust.signature.unknown": "Not verified here",
  "trust.publisher": "Publisher",
  "trust.os": "Windows",
"trust.os.value": "{version} (build {build})",
"trust.notMeasured": "Not measured",
  "trust.arch": "Architecture",
  "trust.privilege": "Running as",
  "trust.webview": "WebView",
  "trust.store": "Data folder",
  "trust.storeMode": "Storage mode",
  "trust.storeMode.machine": "Shared (ProgramData)",
  "trust.storeMode.user": "User profile fallback",
  "trust.retention.value": "{snapshots} snapshots ({bytes}), {rows} audit rows",
  "trust.telemetry": "Telemetry",
  "trust.telemetry.off": "Off - nothing leaves this PC",
  "trust.telemetry.on": "On - diagnostic counts only, never file contents",
  "trust.privacy": "Privacy",
  "trust.privacy.body":
    "Zenith collects nothing in the background. It has no account, no cloud sync and no analytics endpoint. A support bundle is created only when you press the button, shows you its contents first, and is saved locally for you to send wherever you choose.",
  "trust.permissions": "What it can touch",
  "trust.permissions.body":
    "Only the folders and registry keys each action declares, each one resolved against an allowlist at run time. Nothing else on this PC is read or written.",
  "trust.purge": "Delete my data",
  "trust.purge.subtitle": "Removes what Zenith stored. Windows settings you changed stay changed.",
  "trust.purge.scope": "What to remove",
  "trust.purge.support": "Support bundles",
  "trust.purge.logs": "Logs",
  "trust.purge.snapshots": "Undo history",
  "trust.purge.all": "Everything",
  "trust.purge.action": "Delete…",
  "trust.purge.confirmTitle": "Delete stored data",
  "trust.purge.confirmBody":
    "This permanently removes the selected data. Undo history for changes you have not restored will be lost.",
  "trust.purge.token": "Type PURGE to confirm",
  "trust.purge.force": "Delete even unrestored snapshots",
  "trust.purge.done": "Deleted {files} files ({bytes}); {snapshots} snapshots removed.",
  "trust.purge.keptQuarantine": "{count} quarantined file(s) were kept as evidence.",
  "trust.bundle": "Create a support bundle",
  "trust.bundle.subtitle":
    "A zip with the log, the audit trail and your note - credentials and your user name are removed first.",
  "trust.bundle.note": "What went wrong? (optional)",
  "trust.bundle.note.placeholder": "The printer queue got stuck after I installed…",
  "trust.bundle.action": "Create bundle",
  "trust.bundle.done": "Saved {bytes} to {path}",
  "trust.bundle.contents": "Included files",
  "trust.bundle.redaction": "Redaction",
  "trust.bundle.redaction.value": "{masked} values masked, {paths} paths scrubbed",
  "trust.session": "Session",
  "trust.session.uptime": "Up for {time}",
  "trust.boot": "Cold start",
  "trust.boot.value": "{ms} ms to interactive",
  "trust.boot.unknown": "Unknown (timing API unavailable)",
  "trust.licenses": "Third-party notices",
  "trust.licenses.body": "Zenith bundles {count} open-source components. Each is listed with its version and licence, and every licence text is reproduced in full.",
  "trust.licenses.show": "Show notices",
  "trust.licenses.source": "Generated from Cargo.lock and package-lock.json; ships offline.",

  // ------------------------------------------------------------------------- help
  "help.title": "Keyboard and help",
  "help.subtitle": "Every control has a key, and nothing runs without your confirmation.",
  "help.shortcuts": "Shortcuts",
  "help.k.palette": "Command palette",
  "help.k.diagnose": "Diagnose all",
  "help.k.search": "Focus search",
  "help.k.console": "Toggle console",
  "help.k.escape": "Close overlay or stop the running action",
  "help.k.cards": "Move between actions",
  "help.k.run": "Run the focused action",
  "help.about": "About",
  "help.about.body":
    "Zenith diagnoses before it changes anything, saves an undo copy when it can, and tells you when it cannot. If a number cannot be measured, it says so instead of showing zero.",

  // ------------------------------------------------------------------------ misc
  "misc.close": "Close",
  "misc.selectRow": "Select",
  "misc.back": "Back",
  "misc.retry": "Retry",
  "misc.loading": "Loading…",
  "misc.error.title": "That did not work",
  "misc.error.detail": "Technical detail (for support)",
  "misc.error.correlation": "Reference {id}",
  "misc.error.dismiss": "OK",
  "misc.fatal.title": "Zenith could not start",
  "misc.fatal.body":
    "The native host is not reachable. This build can still show the interface in simulation mode, but it cannot change anything.",
  "misc.render.title":
    "This screen could not be shown",
  "misc.render.body":
    "Zenith hit an unexpected error while drawing this screen. Nothing on your PC was changed, and the rest of the window still works - pick another tab, or try this screen again.",
  "misc.render.hint":
    "If it keeps happening, create a support bundle: zenith --support-bundle",
  "misc.render.detail":
    "Technical detail (for support)",
  "misc.offline": "Working offline",
} as const;

export type MessageKey = keyof typeof en;
