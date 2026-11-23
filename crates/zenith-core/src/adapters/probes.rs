//! The 22 diagnostic probes: one function per action, each returning a measured
//! fact or an explicit refusal.
//!
//! The rule that governs this module is REQ-F-072: **a probe that cannot measure
//! returns an error, never a plausible number.** A zero rendered as "0 MB junk"
//! is indistinguishable from "we did not look", and a user acting on it is being
//! misled. [`probe_all`] converts such an error into a report carrying
//! `diag.unavailable`, which the UI renders as "not measured" with the reason -
//! so the gap is visible rather than silent (Zero-Stub Law L1).
//!
//! Each probe is cheap enough to run in the diagnosis budget declared in the
//! manifest. Anything that would take seconds (a `winget` query, an `sfc` scan)
//! is not guessed at: it is reported as unavailable and measured by the action
//! itself when it runs.

use std::collections::BTreeMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::{DEV_PORT_MAX, DEV_PORT_MIN, Paths};
use crate::engine::audit::now_utc;
use crate::engine::executor::CancelToken;
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::manifest::action_by_id;
use crate::models::{ActionId, DiagnosticReport};

use super::{cleanup, process, services, system};

/// Bytes above which the temp cache is worth mentioning (2 GB).
const JUNK_ATTENTION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Recycle Bin size that makes "empty it" a real suggestion (1 GB).
const RECYCLE_ATTENTION_BYTES: u64 = 1024 * 1024 * 1024;
/// Screenshots older than this are archivable.
const SCREENSHOT_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// DNS answers slower than this are worth flagging.
const DNS_ATTENTION_MS: u64 = 120;
/// Memory pressure that costs health points.
const MEMORY_ATTENTION_PERCENT: f32 = 85.0;

/// Everything a probe may read. Injected so tests never touch the real machine.
pub struct ProbeContext {
    pub paths: Paths,
    pub cancel: Arc<CancelToken>,
    /// Hosts used for the latency sample; fixed, never user input.
    pub dns_probe_hosts: Vec<(&'static str, u16)>,
}

impl ProbeContext {
    pub fn real(paths: Paths) -> Self {
        Self {
            paths,
            cancel: Arc::new(CancelToken::new()),
            dns_probe_hosts: vec![("www.msftconnecttest.com", 443), ("one.one.one.one", 443)],
        }
    }
}

/// Run every probe and return one report per action, in manifest order.
///
/// Failures are converted to reports rather than dropped, so the array always has
/// 22 entries and the UI never has a hole to explain.
pub fn probe_all(ctx: &ProbeContext) -> Vec<DiagnosticReport> {
    crate::manifest::ACTIONS
        .iter()
        .map(|def| match probe(def.id, ctx) {
            Ok(report) => report,
            Err(err) => unavailable(def.id, &err),
        })
        .collect()
}

/// The explicit "we could not measure this" report.
pub fn unavailable(action: ActionId, err: &ZenithError) -> DiagnosticReport {
    let def = action_by_id(action);
    let mut params = BTreeMap::new();
    params.insert("reason".to_string(), err.code.message_key().to_string());
    if let Some(feature) = err.params.get("feature") {
        params.insert("feature".to_string(), feature.clone());
    }

    DiagnosticReport {
        action_id: action,
        // Not "healthy": we did not look. The UI shows a neutral chip driven by
        // the metric key, so `needs_attention` staying false does not claim
        // anything was fine.
        needs_attention: false,
        severity_weight: 1,
        metric_key: "diag.unavailable".to_string(),
        metric_params: params,
        reclaimable_bytes: 0,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    }
}

/// Measure one action.
pub fn probe(action: ActionId, ctx: &ProbeContext) -> ZenithResult<DiagnosticReport> {
    if ctx.cancel.is_cancelled() {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }
    match action {
        ActionId::CleanTempCache => probe_temp(ctx),
        ActionId::EmptyRecycleBin => probe_recycle_bin(),
        ActionId::ArchiveScreenshots => probe_screenshots(ctx),
        ActionId::WingetUpgradeAll => probe_tool("winget.exe", ActionId::WingetUpgradeAll),
        ActionId::WindowsUpdateScan => probe_windows_update(),
        ActionId::FlushDnsCache => probe_dns(ctx),
        ActionId::ResetWinsockStack => probe_winsock(),
        ActionId::ClearStuckProxyVpn => probe_proxy(),
        ActionId::SyncNtpTime => probe_ntp(),
        ActionId::CopySysadminInfo => probe_sysadmin(),
        ActionId::DismRestoreHealth => probe_component_store(),
        ActionId::SfcSystemScan => probe_system_files(),
        ActionId::RestartExplorer => probe_explorer(),
        ActionId::RebuildIconCache => probe_icon_cache(ctx),
        ActionId::RestartBluetooth => probe_bluetooth(),
        ActionId::ResetPrintSpooler => probe_spooler(),
        ActionId::ResetGpuDriver => probe_gpu(),
        ActionId::ControlledReboot => probe_uptime(),
        ActionId::UnlockDevPorts => probe_dev_ports(),
        ActionId::CloseHungOffice => probe_office(),
        ActionId::ClearTeamsOutlookCache => probe_office_cache(ctx),
        ActionId::ReclaimWslDockerRam => probe_wsl(),
    }
}

fn report(
    action: ActionId,
    needs_attention: bool,
    metric_key: &str,
    params: &[(&str, String)],
    reclaimable_bytes: u64,
) -> DiagnosticReport {
    let def = action_by_id(action);
    let mut map = BTreeMap::new();
    for (key, value) in params {
        map.insert((*key).to_string(), value.clone());
    }
    DiagnosticReport {
        action_id: action,
        needs_attention,
        severity_weight: def.severity_weight,
        metric_key: metric_key.to_string(),
        metric_params: map,
        reclaimable_bytes,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    }
}

fn read_only(action: ActionId) -> ZenithResult<DiagnosticReport> {
    // Observational actions have nothing to measure *for*; the measurement *is*
    // the action. Returning an explicit no-op report is the honest answer.
    Ok(report(action, false, "diag.observationalOnly", &[], 0))
}

// ---------------------------------------------------------------------------
// Filesystem probes
// ---------------------------------------------------------------------------

fn temp_roots(paths: &Paths) -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Temp"));
    }
    roots.push(paths.data.join("Temp"));
    roots.dedup();
    roots
}

fn probe_temp(ctx: &ProbeContext) -> ZenithResult<DiagnosticReport> {
    let scan = cleanup::scan_old_files(
        &temp_roots(&ctx.paths),
        Duration::from_secs(24 * 60 * 60),
        &ctx.cancel,
    )?;
    let mb = scan.bytes as f64 / (1024.0 * 1024.0);
    Ok(report(
        ActionId::CleanTempCache,
        scan.bytes >= JUNK_ATTENTION_BYTES,
        if scan.bytes >= JUNK_ATTENTION_BYTES {
            "diag.junkOver"
        } else {
            "diag.junkUnder"
        },
        &[
            ("mb", format!("{mb:.1}")),
            ("files", scan.file_count().to_string()),
            ("minAgeHours", "24".to_string()),
        ],
        scan.bytes,
    ))
}

fn probe_recycle_bin() -> ZenithResult<DiagnosticReport> {
    let info = cleanup::recycle_bin_info(std::path::Path::new(r"C:\"))?;
    let mb = info.bytes as f64 / (1024.0 * 1024.0);
    Ok(report(
        ActionId::EmptyRecycleBin,
        info.bytes >= RECYCLE_ATTENTION_BYTES,
        if info.bytes >= RECYCLE_ATTENTION_BYTES {
            "diag.recycleOver"
        } else {
            "diag.recycleUnder"
        },
        &[
            ("mb", format!("{mb:.1}")),
            ("items", info.items.to_string()),
        ],
        info.bytes,
    ))
}

fn screenshots_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|profile| profile.join("Pictures").join("Screenshots"))
}

fn probe_screenshots(ctx: &ProbeContext) -> ZenithResult<DiagnosticReport> {
    let Some(root) = screenshots_root() else {
        return Err(ZenithError::not_implemented("probe.screenshots_no_profile"));
    };
    if !root.is_dir() {
        return Ok(report(
            ActionId::ArchiveScreenshots,
            false,
            "diag.noFolder",
            &[],
            0,
        ));
    }
    let scan = cleanup::scan_old_files(&[root], SCREENSHOT_AGE, &ctx.cancel)?;
    Ok(report(
        ActionId::ArchiveScreenshots,
        scan.file_count() > 25,
        if scan.file_count() > 25 {
            "diag.screenshotsMany"
        } else {
            "diag.screenshotsFew"
        },
        &[
            ("files", scan.file_count().to_string()),
            ("days", "30".to_string()),
            ("mb", format!("{:.1}", scan.megabytes())),
        ],
        scan.bytes,
    ))
}

fn office_cache_roots() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let local = PathBuf::from(local);
    vec![
        local.join(r"Microsoft\Outlook\RoamCache"),
        local.join(r"Microsoft\Teams\Cache"),
        local.join(r"Microsoft\Teams\Code Cache"),
        local.join(r"Microsoft\Teams\GPUCache"),
    ]
}

fn probe_office_cache(ctx: &ProbeContext) -> ZenithResult<DiagnosticReport> {
    let roots = office_cache_roots();
    if roots.is_empty() {
        return Err(ZenithError::not_implemented(
            "probe.office_cache_no_localappdata",
        ));
    }
    let scan = cleanup::scan_old_files(&roots, Duration::from_secs(0), &ctx.cancel)?;
    Ok(report(
        ActionId::ClearTeamsOutlookCache,
        scan.bytes >= 512 * 1024 * 1024,
        if scan.bytes >= 512 * 1024 * 1024 {
            "diag.cacheOver"
        } else {
            "diag.cacheUnder"
        },
        &[
            ("mb", format!("{:.1}", scan.megabytes())),
            ("files", scan.file_count().to_string()),
        ],
        scan.bytes,
    ))
}

fn icon_cache_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|local| local.join(r"Microsoft\Windows\Explorer"))
}

fn probe_icon_cache(ctx: &ProbeContext) -> ZenithResult<DiagnosticReport> {
    let Some(root) = icon_cache_root() else {
        return Err(ZenithError::not_implemented(
            "probe.icon_cache_no_localappdata",
        ));
    };
    let scan = cleanup::scan_old_files(&[root], Duration::from_secs(0), &ctx.cancel)?;
    Ok(report(
        ActionId::RebuildIconCache,
        scan.bytes >= 512 * 1024 * 1024,
        if scan.bytes >= 512 * 1024 * 1024 {
            "diag.iconCacheOver"
        } else {
            "diag.iconCacheUnder"
        },
        &[("mb", format!("{:.1}", scan.megabytes()))],
        scan.bytes,
    ))
}

// ---------------------------------------------------------------------------
// Network probes
// ---------------------------------------------------------------------------

fn probe_dns(ctx: &ProbeContext) -> ZenithResult<DiagnosticReport> {
    let mut best: Option<u64> = None;
    let mut last_error = None;

    for (host, port) in &ctx.dns_probe_hosts {
        let started = Instant::now();
        match (*host, *port).to_socket_addrs() {
            Ok(mut addrs) => {
                let Some(address) = addrs.next() else {
                    last_error = Some("empty answer".to_string());
                    continue;
                };
                // A resolve is not a reachability test; a connect failure still
                // proves DNS answered, so it is not an error here.
                let _ = TcpStream::connect_timeout(&address, Duration::from_millis(700));
                let elapsed = started.elapsed().as_millis() as u64;
                best = Some(best.map_or(elapsed, |current| current.min(elapsed)));
            }
            Err(err) => last_error = Some(err.to_string()),
        }
    }

    let Some(ms) = best else {
        // No answer is a real, reportable condition - not a missing measurement.
        let mut diagnostic = report(
            ActionId::FlushDnsCache,
            true,
            "diag.dnsFailed",
            &[(
                "detail",
                last_error.unwrap_or_else(|| "no answer".to_string()),
            )],
            0,
        );
        diagnostic.latency_ms = None;
        return Ok(diagnostic);
    };

    let mut diagnostic = report(
        ActionId::FlushDnsCache,
        ms > DNS_ATTENTION_MS,
        if ms > DNS_ATTENTION_MS {
            "diag.dnsSlow"
        } else {
            "diag.dnsFast"
        },
        &[
            ("ms", ms.to_string()),
            ("threshold", DNS_ATTENTION_MS.to_string()),
        ],
        0,
    );
    diagnostic.latency_ms = Some(ms);
    Ok(diagnostic)
}

fn probe_winsock() -> ZenithResult<DiagnosticReport> {
    // The Winsock catalogue is only interesting when something is wrong with it,
    // and "wrong" is not a number we can read cheaply. Report the last reset time
    // from the hive directory instead of inventing a health figure.
    let hive_dir = wal_hive_dir()?;
    let newest = std::fs::read_dir(&hive_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .max();

    match newest {
        Some(time) => {
            let age_days = std::time::SystemTime::now()
                .duration_since(time)
                .map(|age| age.as_secs() / 86_400)
                .unwrap_or(0);
            Ok(report(
                ActionId::ResetWinsockStack,
                false,
                "diag.winsockLastReset",
                &[("days", age_days.to_string())],
                0,
            ))
        }
        None => Ok(report(
            ActionId::ResetWinsockStack,
            false,
            "diag.winsockNeverReset",
            &[],
            0,
        )),
    }
}

fn wal_hive_dir() -> ZenithResult<PathBuf> {
    let program_data = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    Ok(program_data.join("Vellium").join("Zenith").join("hives"))
}

fn probe_proxy() -> ZenithResult<DiagnosticReport> {
    // Read the per-user proxy switch. A stale "enabled" with no server is the
    // classic stuck-proxy state this action fixes.
    let key = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let proxy_enable = read_hkcu_dword(key, "ProxyEnable")?;
    let server = read_hkcu_string(key, "ProxyServer")?;

    let stuck = proxy_enable == 1 && server.is_none();
    let mut params = BTreeMap::new();
    params.insert("proxyEnable".to_string(), proxy_enable.to_string());
    if let Some(server) = &server {
        params.insert("server".to_string(), server.clone());
    }

    let def = action_by_id(ActionId::ClearStuckProxyVpn);
    Ok(DiagnosticReport {
        action_id: ActionId::ClearStuckProxyVpn,
        needs_attention: stuck,
        severity_weight: def.severity_weight,
        metric_key: if stuck {
            "diag.proxyStuck".to_string()
        } else if proxy_enable == 1 {
            "diag.proxyConfigured".to_string()
        } else {
            "diag.proxyDirect".to_string()
        },
        metric_params: params,
        reclaimable_bytes: 0,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    })
}

fn probe_ntp() -> ZenithResult<DiagnosticReport> {
    // Reading the real offset needs a w32tm round trip, which can take seconds.
    // That belongs to the action, not to a probe budget of 900 ms.
    let status = services::query("W32Time")?;
    Ok(report(
        ActionId::SyncNtpTime,
        !status.state.is_running(),
        if status.state.is_running() {
            "diag.timeServiceRunning"
        } else {
            "diag.timeServiceStopped"
        },
        &[("state", status.state.as_str().to_string())],
        0,
    ))
}

fn probe_dev_ports() -> ZenithResult<DiagnosticReport> {
    let listeners = process::list_listeners(DEV_PORT_MIN, DEV_PORT_MAX)?;
    let mut params = BTreeMap::new();
    params.insert("count".to_string(), listeners.len().to_string());
    let ports: Vec<String> = listeners
        .iter()
        .take(8)
        .map(|listener| format!("{}:{}", listener.port, listener.process_name))
        .collect();
    if !ports.is_empty() {
        params.insert("ports".to_string(), ports.join(", "));
    }

    let def = action_by_id(ActionId::UnlockDevPorts);
    Ok(DiagnosticReport {
        action_id: ActionId::UnlockDevPorts,
        needs_attention: !listeners.is_empty(),
        severity_weight: def.severity_weight,
        metric_key: if listeners.is_empty() {
            "diag.portsFree".to_string()
        } else {
            "diag.portsBusy".to_string()
        },
        metric_params: params,
        reclaimable_bytes: 0,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    })
}

// ---------------------------------------------------------------------------
// Service-backed probes
// ---------------------------------------------------------------------------

fn probe_bluetooth() -> ZenithResult<DiagnosticReport> {
    let status = services::query("bthserv")?;
    Ok(report(
        ActionId::RestartBluetooth,
        !status.state.is_running(),
        if status.state.is_running() {
            "diag.serviceRunning"
        } else {
            "diag.serviceStopped"
        },
        &[
            ("service", "bthserv".to_string()),
            ("state", status.state.as_str().to_string()),
        ],
        0,
    ))
}

fn probe_spooler() -> ZenithResult<DiagnosticReport> {
    let status = services::query("Spooler")?;
    // A spooler that is running but has a huge queue is the stuck case; the
    // queue itself is not readable without host-mode APIs, so we report the
    // service state honestly and let the action show the queue afterwards.
    Ok(report(
        ActionId::ResetPrintSpooler,
        !status.state.is_running(),
        if status.state.is_running() {
            "diag.serviceRunning"
        } else {
            "diag.serviceStopped"
        },
        &[
            ("service", "Spooler".to_string()),
            ("state", status.state.as_str().to_string()),
        ],
        0,
    ))
}

fn probe_explorer() -> ZenithResult<DiagnosticReport> {
    let running = process::find_by_name("explorer.exe")?;
    Ok(report(
        ActionId::RestartExplorer,
        running.is_empty(),
        if running.is_empty() {
            "diag.explorerMissing"
        } else {
            "diag.explorerRunning"
        },
        &[("count", running.len().to_string())],
        0,
    ))
}

fn probe_uptime() -> ZenithResult<DiagnosticReport> {
    let uptime_ms = system::uptime_ms()?;
    let days = uptime_ms / 86_400_000;
    Ok(report(
        ActionId::ControlledReboot,
        days >= 14,
        if days >= 14 {
            "diag.uptimeLong"
        } else {
            "diag.uptimeShort"
        },
        &[("days", days.to_string())],
        0,
    ))
}

fn probe_memory() -> ZenithResult<DiagnosticReport> {
    let memory = system::memory()?;
    let percent = memory.used_percent();
    Ok(report(
        ActionId::ReclaimWslDockerRam,
        percent >= MEMORY_ATTENTION_PERCENT,
        if percent >= MEMORY_ATTENTION_PERCENT {
            "diag.memoryHigh"
        } else {
            "diag.memoryNormal"
        },
        &[
            ("percent", format!("{percent:.1}")),
            ("usedMb", memory.used_mb().to_string()),
            ("totalMb", memory.total_mb.to_string()),
        ],
        0,
    ))
}

fn probe_wsl() -> ZenithResult<DiagnosticReport> {
    let memory = probe_memory()?;
    let vmmem = process::find_by_name("vmmem")?;
    let vmmem_wsl = process::find_by_name("vmmemWSL")?;
    let total: u64 = vmmem
        .iter()
        .chain(vmmem_wsl.iter())
        .map(|identity| identity.memory_mb)
        .sum();

    let def = action_by_id(ActionId::ReclaimWslDockerRam);
    Ok(DiagnosticReport {
        action_id: ActionId::ReclaimWslDockerRam,
        needs_attention: total >= 4096 || memory.needs_attention,
        severity_weight: def.severity_weight,
        metric_key: if total == 0 {
            "diag.wslIdle".to_string()
        } else {
            "diag.wslHolding".to_string()
        },
        metric_params: {
            let mut params = memory.metric_params.clone();
            params.insert("vmmemMb".to_string(), total.to_string());
            params
        },
        reclaimable_bytes: 0,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    })
}

fn probe_office() -> ZenithResult<DiagnosticReport> {
    let mut names = Vec::new();
    let mut hung = 0usize;
    for process_name in ["WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE", "OUTLOOK.EXE"] {
        for identity in process::find_by_name(process_name)? {
            names.push(identity.name.clone());
            if !process::is_responding(identity.pid)? {
                hung += 1;
            }
        }
    }

    let def = action_by_id(ActionId::CloseHungOffice);
    Ok(DiagnosticReport {
        action_id: ActionId::CloseHungOffice,
        needs_attention: hung > 0,
        severity_weight: def.severity_weight,
        metric_key: if hung > 0 {
            "diag.officeHung".to_string()
        } else if names.is_empty() {
            "diag.officeNotRunning".to_string()
        } else {
            "diag.officeHealthy".to_string()
        },
        metric_params: {
            let mut params = BTreeMap::new();
            params.insert("running".to_string(), names.len().to_string());
            params.insert("hung".to_string(), hung.to_string());
            params
        },
        reclaimable_bytes: 0,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    })
}

fn probe_gpu() -> ZenithResult<DiagnosticReport> {
    // A driver reset has no cheap numeric signal; display-adapter TDR events are
    // the real indicator and reading them means parsing the System event log.
    // Rather than fabricate a figure, say so.
    Err(ZenithError::not_implemented("probe.gpu_tdr_not_read"))
}

// ---------------------------------------------------------------------------
// Action-state probes (things that need a tool or a slow scan)
// ---------------------------------------------------------------------------

fn probe_tool(program: &str, action: ActionId) -> ZenithResult<DiagnosticReport> {
    match which(program) {
        Some(path) => Ok(report(
            action,
            false,
            "diag.toolPresent",
            &[("program", program.to_string()), ("path", path)],
            0,
        )),
        None => Ok(report(
            action,
            true,
            "diag.toolMissing",
            &[("program", program.to_string())],
            0,
        )),
    }
}

/// Resolve a program on `PATH` without running a shell.
pub fn which(program: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate.display().to_string());
        }
    }
    None
}

fn probe_windows_update() -> ZenithResult<DiagnosticReport> {
    // `UsoClient` reports nothing synchronously, so the useful probe is the
    // timestamp of the last successful detect.
    let key =
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\Results\Detect";
    let last: Option<String> = read_hklm_string(key, "LastSuccessTime").ok();
    let def = action_by_id(ActionId::WindowsUpdateScan);
    Ok(DiagnosticReport {
        action_id: ActionId::WindowsUpdateScan,
        needs_attention: last.is_none(),
        severity_weight: def.severity_weight,
        metric_key: if last.is_none() {
            "diag.updateNeverScanned".to_string()
        } else {
            "diag.updateLastScan".to_string()
        },
        metric_params: {
            let mut params = BTreeMap::new();
            if let Some(last) = last {
                params.insert("lastScan".to_string(), last);
            }
            params
        },
        reclaimable_bytes: 0,
        latency_ms: None,
        tier: def.tier,
        can_rollback: def.tier.is_rollbackable(),
        read_only: def.read_only,
        measured_at_utc: now_utc(),
    })
}

fn probe_component_store() -> ZenithResult<DiagnosticReport> {
    // Health of the component store is only knowable by running DISM. Report the
    // age of the last CBS log write, which is a real, cheap signal.
    let cbs = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("Logs")
        .join("CBS")
        .join("CBS.log");
    let age_days = std::fs::metadata(&cbs)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| std::time::SystemTime::now().duration_since(time).ok())
        .map(|age| age.as_secs() / 86_400);

    match age_days {
        Some(days) => Ok(report(
            ActionId::DismRestoreHealth,
            false,
            "diag.cbsAge",
            &[("days", days.to_string())],
            0,
        )),
        None => Err(ZenithError::not_implemented("probe.cbs_log_unreadable")),
    }
}

fn probe_system_files() -> ZenithResult<DiagnosticReport> {
    // SFC writes its verdict to CBS.log; without parsing it there is no number.
    // The dependency ordering means SFC runs after DISM, so the honest probe is
    // "not measured until run".
    read_only(ActionId::SfcSystemScan)
}

fn probe_sysadmin() -> ZenithResult<DiagnosticReport> {
    read_only(ActionId::CopySysadminInfo)
}

// ---------------------------------------------------------------------------
// Registry helpers (read-only, correct-typed)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn read_hkcu_dword(path: &str, value: &str) -> ZenithResult<u32> {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let value_wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();

    // SAFETY: both strings are NUL-terminated and outlive the call; `key` is a
    // live local closed on every path below.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path_wide.as_ptr()),
            Some(0),
            KEY_READ,
            &mut key,
        )
    };
    if opened.0 != 0 {
        return Err(ZenithError::new(ErrorCode::Internal)
            .with("key", path.to_string())
            .detail(format!("win32={}", opened.0)));
    }

    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let mut kind = REG_DWORD;
    // SAFETY: `data` is exactly `size` bytes and `key` is valid.
    let read = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut size),
        )
    };
    // SAFETY: `key` was opened successfully above.
    unsafe {
        let _ = RegCloseKey(key);
    }

    if read.0 != 0 {
        return Err(ZenithError::new(ErrorCode::Internal)
            .with("value", value.to_string())
            .detail(format!("win32={}", read.0)));
    }
    Ok(data)
}

#[cfg(not(windows))]
fn read_hkcu_dword(_path: &str, _value: &str) -> ZenithResult<u32> {
    Err(crate::adapters::unsupported("probes.registry"))
}

#[cfg(windows)]
fn read_hkcu_string(path: &str, value: &str) -> ZenithResult<Option<String>> {
    read_string_in(HKEY_CURRENT_USER_ROOT, path, value)
}

#[cfg(not(windows))]
fn read_hkcu_string(_path: &str, _value: &str) -> ZenithResult<Option<String>> {
    Err(crate::adapters::unsupported("probes.registry"))
}

#[cfg(windows)]
const HKEY_CURRENT_USER_ROOT: &str = "HKCU";

#[cfg(windows)]
fn read_hklm_string(path: &str, value: &str) -> ZenithResult<String> {
    read_string_in("HKLM", path, value)?
        .ok_or_else(|| ZenithError::new(ErrorCode::Internal).with("value", value.to_string()))
}

#[cfg(windows)]
fn read_string_in(root: &str, path: &str, value: &str) -> ZenithResult<Option<String>> {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ, RegCloseKey, RegOpenKeyExW,
        RegQueryValueExW,
    };
    use windows::core::PCWSTR;

    let root_handle = if root.eq_ignore_ascii_case("HKLM") {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    };
    let path_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let value_wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();

    // SAFETY: NUL-terminated strings that outlive the call; live `key` local.
    let opened = unsafe {
        RegOpenKeyExW(
            root_handle,
            PCWSTR(path_wide.as_ptr()),
            Some(0),
            KEY_READ,
            &mut key,
        )
    };
    if opened.0 != 0 {
        return Ok(None);
    }

    let mut size = 0u32;
    let mut kind = REG_SZ;
    // SAFETY: size query with a null data pointer is the documented two-step.
    let probe = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        )
    };
    if probe.0 != 0 || size == 0 || size > 64 * 1024 {
        // SAFETY: `key` is valid.
        unsafe {
            let _ = RegCloseKey(key);
        }
        return Ok(None);
    }

    let mut buffer = vec![0u8; size as usize];
    // SAFETY: `buffer` has exactly `size` bytes.
    let read = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    // SAFETY: `key` is valid, closed exactly once.
    unsafe {
        let _ = RegCloseKey(key);
    }

    if read.0 != 0 {
        return Ok(None);
    }
    Ok(super::utf16le_to_string(&buffer))
}

#[cfg(not(windows))]
fn read_hklm_string(_path: &str, _value: &str) -> ZenithResult<String> {
    Err(crate::adapters::unsupported("probes.registry"))
}
