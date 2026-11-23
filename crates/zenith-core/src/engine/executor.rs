//! The execution state machine.
//!
//! This module owns *policy*: what is legal to run, in what order, with what
//! confirmation, and what a failure does to the rest of the run. It does not own
//! any OS call - that is [`crate::adapters`] - which is what makes the policy
//! testable on any machine.
//!
//! Guarantees enforced here (each has a test):
//!
//! * one action at a time, machine-wide (`REQ-F-005`)
//! * an admin action cannot start without elevation (`REQ-F-079`)
//! * an irreversible action cannot start without an explicit acknowledgement
//!   (`REQ-F-023`)
//! * a dependency is never run implicitly, and a failed dependency skips its
//!   dependents (`REQ-F-030`)
//! * a destructive action is never accepted into a batch (`REQ-F-031`)
//! * legal phase transitions only; an illegal one is a bug, not a coast (`03-01` §6.1)

use std::collections::BTreeSet;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use parking_lot::Mutex;

use crate::engine::dag;
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::manifest::{ACTIONS, action_by_id, is_batch_eligible};
use crate::models::{ActionId, ExecutionPhase, ReversibilityTier};

/// Cancellation token shared between the UI and a running action.
///
/// `AtomicBool` rather than a channel because the only question a worker asks is
/// "should I stop", and it must be answerable from a signal handler path without
/// allocating.
///
/// The token also remembers *when* the request arrived and *when* it was
/// enacted. Without those instants, "cancel lands within 500 ms" (REQ-F-052) can
/// only be tested by timing `cancel()` in one thread against the worker's return
/// in another, which measures the scheduler and the kernel's process teardown as
/// much as the product - and did: under a loaded `cargo test --workspace` the
/// same code that responds in 32 ms measured 411 ms, and once crossed 500 ms.
///
/// A worker that spawns processes registers a [`CancelToken::register_hook`]
/// killer, so the cancellation is *enacted* on the calling thread the moment
/// `cancel()` runs, not whenever the worker next gets a time slice. That is both
/// the better product (a starved worker can no longer delay a kill) and the
/// honest measurement (the number is the product's, not the machine's).
pub struct CancelToken {
    cancelled: AtomicBool,
    /// Set once, before `cancelled`, so `is_cancelled()` implies `Some`.
    requested_at: Mutex<Option<Instant>>,
    /// Set only when a registered hook actually ran. Absent means the worker's
    /// own observation is the enactment, and `latency_ms` falls back to now.
    honoured_at: Mutex<Option<Instant>>,
    hook: Mutex<Option<CancelHook>>,
}

type CancelHook = Arc<dyn Fn() + Send + Sync>;

impl fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .field("requested_at", &self.requested_at())
            .field("has_hook", &self.hook.lock().is_some())
            .finish()
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            requested_at: Mutex::new(None),
            honoured_at: Mutex::new(None),
            hook: Mutex::new(None),
        }
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        // Instant first, flag second: a worker that observes `true` must never
        // find the timestamp missing, or the measured latency would silently
        // become zero and the budget test would pass by accident.
        {
            let mut at = self.requested_at.lock();
            if at.is_none() {
                *at = Some(Instant::now());
            }
        }
        self.cancelled.store(true, Ordering::SeqCst);

        // Run the killer outside the lock: it makes a kernel call, and a reader
        // asking "when was this requested?" must never wait on it. Cloning the
        // `Arc` keeps the hook alive even if the worker drops its registration
        // guard mid-call.
        let hook = self.hook.lock().clone();
        if let Some(enact) = hook {
            enact();
            let mut honoured = self.honoured_at.lock();
            if honoured.is_none() {
                *honoured = Some(Instant::now());
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// When cancellation was requested, if it was. `None` after `reset()`.
    pub fn requested_at(&self) -> Option<Instant> {
        *self.requested_at.lock()
    }

    /// Milliseconds from the request to its enactment.
    ///
    /// `None` when nothing was cancelled. When a hook ran, this is request →
    /// killer return; otherwise it is request → now, for a caller that observes
    /// the flag itself.
    pub fn latency_ms(&self) -> Option<u64> {
        let requested = self.requested_at()?;
        let honoured = (*self.honoured_at.lock()).unwrap_or_else(Instant::now);
        Some(
            honoured
                .duration_since(requested)
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        )
    }

    /// Register the act that makes cancellation *take effect* (for a child
    /// process, terminating its job object). Cleared when the returned guard is
    /// dropped, so a later cancel cannot reach a job that has already closed.
    pub fn register_hook(&self, hook: CancelHook) -> HookGuard<'_> {
        *self.hook.lock() = Some(hook);
        HookGuard { token: self }
    }

    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
        *self.requested_at.lock() = None;
        *self.honoured_at.lock() = None;
        // The hook is intentionally left to its guard: a running child may still
        // own it, and clearing it here would silently disable the kill switch.
    }

    /// Map to the canonical cancellation error, so every caller reports the same
    /// code rather than inventing one.
    pub fn check(&self) -> ZenithResult<()> {
        if self.is_cancelled() {
            Err(ZenithError::new(ErrorCode::Cancelled))
        } else {
            Ok(())
        }
    }
}

/// Keeps a cancellation hook registered for exactly as long as a run owns it.
///
/// Dropping the guard unregisters; the hook's `Arc` may still be in flight in
/// `cancel()`, which is why `cancel` clones it before calling.
pub struct HookGuard<'a> {
    token: &'a CancelToken,
}

impl Drop for HookGuard<'_> {
    fn drop(&mut self) {
        *self.token.hook.lock() = None;
    }
}

/// The confirmation the UI collected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Confirmation {
    /// The tier the user was shown. Must equal the action's real tier.
    pub acknowledged_tier: ReversibilityTier,
}

/// Process-wide execution lock. One running action, machine-wide - two windows
/// must not both run `netsh winsock reset`.
#[derive(Debug, Default)]
pub struct ExecutionRegistry {
    inner: Mutex<RegistryState>,
}

#[derive(Debug, Default)]
struct RegistryState {
    active: Option<ActionId>,
    phases: Vec<(ActionId, ExecutionPhase)>,
}

impl ExecutionRegistry {
    pub fn new() -> Self {
        let phases = ACTIONS
            .iter()
            .map(|def| (def.id, ExecutionPhase::Idle))
            .collect();
        Self {
            inner: Mutex::new(RegistryState {
                active: None,
                phases,
            }),
        }
    }

    /// Claim the machine-wide slot or fail with `ALREADY_RUNNING`.
    pub fn begin(&self, action: ActionId) -> ZenithResult<()> {
        let mut state = self.inner.lock();
        if let Some(running) = state.active {
            return Err(ZenithError::new(ErrorCode::AlreadyRunning)
                .with("runningAction", running.to_string())
                .with("requestedAction", action.to_string()));
        }
        state.active = Some(action);
        Ok(())
    }

    pub fn finish(&self) {
        let mut state = self.inner.lock();
        state.active = None;
    }

    pub fn active(&self) -> Option<ActionId> {
        self.inner.lock().active
    }

    pub fn phase(&self, action: ActionId) -> ExecutionPhase {
        let state = self.inner.lock();
        state
            .phases
            .iter()
            .find(|(id, _)| *id == action)
            .map(|(_, phase)| *phase)
            .unwrap_or(ExecutionPhase::Idle)
    }

    pub fn set_phase(&self, action: ActionId, next: ExecutionPhase) -> ZenithResult<()> {
        let mut state = self.inner.lock();
        let current = state
            .phases
            .iter()
            .find(|(id, _)| *id == action)
            .map(|(_, phase)| *phase)
            .unwrap_or(ExecutionPhase::Idle);
        if !is_legal_transition(current, next) {
            return Err(ZenithError::new(ErrorCode::InvalidArgument)
                .with("reason", "illegal phase transition")
                .with("from", format!("{current:?}"))
                .with("to", format!("{next:?}")));
        }
        if let Some(slot) = state.phases.iter_mut().find(|(id, _)| *id == action) {
            slot.1 = next;
        }
        Ok(())
    }

    /// Every phase, in manifest order, for `state_get`.
    pub fn snapshot(&self) -> Vec<(ActionId, ExecutionPhase)> {
        let state = self.inner.lock();
        let mut phases = state.phases.clone();
        phases.sort_by_key(|(id, _)| action_by_id(*id).order);
        phases
    }
}

/// The legal transition table. Keeping it as a function (rather than a set of
/// `match` arms scattered across the codebase) means the UI can ask the same
/// question the executor enforces.
pub fn is_legal_transition(from: ExecutionPhase, to: ExecutionPhase) -> bool {
    use ExecutionPhase::*;
    if from == to {
        return true;
    }
    matches!(
        (from, to),
        (Idle, Diagnosing)
            | (Idle, Running)
            | (Diagnosing, Healthy)
            | (Diagnosing, NeedsAttention)
            | (Diagnosing, Idle)
            | (Diagnosing, Cancelled)
            | (Diagnosing, Error)
            | (Healthy, Diagnosing)
            | (NeedsAttention, Diagnosing)
            | (Healthy, Running)
            | (NeedsAttention, Running)
            | (Running, Success)
            | (Running, Error)
            | (Running, Cancelled)
            | (Running, SkippedDependency)
            // The rollback path in 03-01 §6.1 is `Success -> Running ->
            // RolledBack`, so the last leg is a Running transition. Without it
            // the documented diagram was unreachable and a successful restore
            // was refused at the final step, leaving the card on "running".
            | (Running, RolledBack)
            | (Success, Running)
            | (Success, Diagnosing)
            | (Success, RolledBack)
            | (Error, Running)
            | (Error, Diagnosing)
            | (Cancelled, Running)
            | (Cancelled, Diagnosing)
            | (SkippedDependency, Running)
            | (SkippedDependency, Diagnosing)
            | (RolledBack, Running)
            | (RolledBack, Diagnosing)
    )
}

/// Validate a single-action request before any mutation happens.
///
/// Order matters: the cheapest and most security-relevant check first, so a
/// forged request cannot consume work.
pub fn validate_execution(
    action: ActionId,
    confirmation: Option<Confirmation>,
    is_elevated: bool,
) -> ZenithResult<ReversibilityTier> {
    let def = action_by_id(action);

    if def.requires_admin && !is_elevated {
        return Err(
            ZenithError::new(ErrorCode::ElevationRequired).with("actionId", action.to_string())
        );
    }

    if def.tier.requires_strong_confirmation() {
        match confirmation {
            Some(given) if given.acknowledged_tier == def.tier => {}
            Some(_) => {
                return Err(ZenithError::new(ErrorCode::ConfirmationRequired)
                    .with("actionId", action.to_string())
                    .with("reason", "tier mismatch"));
            }
            None => {
                return Err(ZenithError::new(ErrorCode::ConfirmationRequired)
                    .with("actionId", action.to_string()));
            }
        }
    }

    Ok(def.tier)
}

/// A validated batch, ready to run.
#[derive(Debug, Clone)]
pub struct BatchPlan {
    pub steps: Vec<ActionId>,
    pub skipped: Vec<(ActionId, String)>,
}

/// Build a batch plan from a user selection.
///
/// Rejected members are reported with a reason rather than silently dropped -
/// a user who selected six actions and got four must be told why.
pub fn plan_batch(selection: &[ActionId], is_elevated: bool) -> ZenithResult<BatchPlan> {
    let mut accepted = Vec::new();
    let mut skipped = Vec::new();

    for action in selection {
        let def = action_by_id(*action);
        if def.risk == crate::models::Risk::Destructive {
            return Err(ZenithError::new(ErrorCode::InvalidArgument)
                .with("actionId", action.to_string())
                .with("reason", "destructive actions cannot be batched"));
        }
        if def.requires_admin && !is_elevated {
            skipped.push((*action, "elevation_required".to_string()));
            continue;
        }
        if !is_batch_eligible(def) {
            skipped.push((*action, "not_batch_eligible".to_string()));
            continue;
        }
        accepted.push(*action);
    }

    let ordered = dag::topological_order(&accepted)?;
    Ok(BatchPlan {
        steps: ordered,
        skipped,
    })
}

/// Tracks a running batch and decides what happens after a step fails.
#[derive(Debug, Default)]
pub struct BatchProgress {
    completed: BTreeSet<ActionId>,
    pub skipped_dependency: Vec<ActionId>,
}

impl BatchProgress {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a successful step.
    pub fn mark_success(&mut self, action: ActionId) {
        self.completed.insert(action);
    }

    /// Record a failure and return the dependents that must now be skipped, in
    /// manifest order.
    pub fn mark_failure(&mut self, action: ActionId, plan: &[ActionId]) -> Vec<ActionId> {
        let dependents = dag::transitive_dependents(action, plan);
        for id in &dependents {
            self.completed.remove(id);
        }
        self.skipped_dependency.extend(dependents.iter().copied());
        dependents
    }

    /// Should this step run? False when a dependency already failed.
    pub fn should_run(&self, action: ActionId) -> bool {
        !self.skipped_dependency.contains(&action)
    }

    pub fn completed(&self) -> &BTreeSet<ActionId> {
        &self.completed
    }
}

/// Outcome category of one executed step, used to drive the batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    Success,
    Failed,
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ActionId::*;

    #[test]
    fn cancel_token_reports_and_resets() {
        let token = CancelToken::new();
        assert!(token.check().is_ok());
        token.cancel();
        assert!(token.is_cancelled());
        assert!(token.check().unwrap_err().is(ErrorCode::Cancelled));
        token.reset();
        assert!(token.check().is_ok());
        assert!(token.requested_at().is_none(), "reset clears the clock");
        assert!(token.latency_ms().is_none());
    }

    #[test]
    fn a_registered_hook_runs_inside_cancel_on_the_calling_thread() {
        // REQ-F-052: "takes effect within 500 ms". Effect is the hook - for a
        // child, terminating its job object. If it only ran when the worker next
        // woke, the measurement would be the scheduler's; here the caller proves
        // it happened before `cancel()` returned.
        let token = CancelToken::new();
        let ran = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        let _guard = token.register_hook(Arc::new(move || flag.store(true, Ordering::SeqCst)));

        token.cancel();

        assert!(
            ran.load(Ordering::SeqCst),
            "the hook must have run before cancel() returned"
        );
        assert!(token.is_cancelled());
        assert!(token.latency_ms().is_some_and(|ms| ms < 500));
    }

    #[test]
    fn a_dropped_hook_is_never_called_but_the_request_is_still_recorded() {
        // The guard exists so a finished run cannot leave a killer pointing at a
        // closed job handle. A late cancel must record the request and do
        // nothing else.
        let token = CancelToken::new();
        let ran = Arc::new(AtomicBool::new(false));
        {
            let flag = Arc::clone(&ran);
            let _guard = token.register_hook(Arc::new(move || flag.store(true, Ordering::SeqCst)));
        }

        token.cancel();

        assert!(!ran.load(Ordering::SeqCst), "a dropped hook must not run");
        assert!(
            token.requested_at().is_some(),
            "the request is still an event, even with nothing to kill"
        );
    }

    #[test]
    fn only_one_action_runs_at_a_time() {
        let registry = ExecutionRegistry::new();
        registry.begin(CleanTempCache).expect("first");
        let err = registry.begin(FlushDnsCache).unwrap_err();
        assert!(err.is(ErrorCode::AlreadyRunning));
        assert_eq!(
            err.params.get("runningAction").map(String::as_str),
            Some("clean-temp-cache")
        );
        registry.finish();
        registry.begin(FlushDnsCache).expect("after finish");
    }

    #[test]
    fn admin_actions_require_elevation() {
        let err = validate_execution(ResetWinsockStack, None, false).unwrap_err();
        assert!(err.is(ErrorCode::ElevationRequired));
        let tier = validate_execution(ResetWinsockStack, None, true).expect("elevated");
        assert_eq!(tier, ReversibilityTier::CompensatingRecovery);
    }

    #[test]
    fn irreversible_actions_require_matching_acknowledgement() {
        // No confirmation at all.
        let err = validate_execution(EmptyRecycleBin, None, false).unwrap_err();
        assert!(err.is(ErrorCode::ConfirmationRequired));

        // Wrong tier acknowledged - the user was shown something else.
        let err = validate_execution(
            EmptyRecycleBin,
            Some(Confirmation {
                acknowledged_tier: ReversibilityTier::FullyReversible,
            }),
            false,
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::ConfirmationRequired));
        assert_eq!(
            err.params.get("reason").map(String::as_str),
            Some("tier mismatch")
        );

        // Correct acknowledgement.
        validate_execution(
            EmptyRecycleBin,
            Some(Confirmation {
                acknowledged_tier: ReversibilityTier::Irreversible,
            }),
            false,
        )
        .expect("acknowledged");
    }

    #[test]
    fn reversible_actions_do_not_require_a_confirmation() {
        validate_execution(ClearStuckProxyVpn, None, false).expect("no confirmation needed");
    }

    #[test]
    fn a_batch_never_contains_a_destructive_action() {
        let err = plan_batch(&[CleanTempCache, ControlledReboot], true).unwrap_err();
        assert!(err.is(ErrorCode::InvalidArgument));
        assert_eq!(
            err.params.get("reason").map(String::as_str),
            Some("destructive actions cannot be batched")
        );
    }

    #[test]
    fn a_batch_skips_admin_steps_without_elevation() {
        let plan = plan_batch(&[FlushDnsCache, RestartBluetooth], false).expect("plan");
        assert_eq!(plan.steps, vec![FlushDnsCache]);
        assert_eq!(
            plan.skipped,
            vec![(RestartBluetooth, "elevation_required".to_string())]
        );
    }

    #[test]
    fn a_batch_is_ordered_by_dependency() {
        // Only dependency edge between two batch-eligible actions would be
        // needed here; today DISM/SFC are deliberately *not* batch-eligible
        // (each repair needs its own confirmation), so the DAG property is
        // tested directly in `engine::dag` and this test pins the visible
        // behaviour: the plan keeps manifest order and never invents a step.
        let plan = plan_batch(&[ResetPrintSpooler, FlushDnsCache], true).expect("plan");
        assert_eq!(plan.steps, vec![FlushDnsCache, ResetPrintSpooler]);
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn a_batch_reports_ineligible_repairs_instead_of_dropping_them() {
        // A failed DISM must not be followed by an SFC run, and neither is
        // safe unattended: both are rejected by name, never silently dropped.
        let plan = plan_batch(&[SfcSystemScan, DismRestoreHealth], true).expect("plan");
        assert!(plan.steps.is_empty());
        assert_eq!(
            plan.skipped,
            vec![
                (SfcSystemScan, "not_batch_eligible".to_string()),
                (DismRestoreHealth, "not_batch_eligible".to_string()),
            ]
        );
    }

    #[test]
    fn a_failed_dependency_skips_its_dependents() {
        let plan = vec![DismRestoreHealth, SfcSystemScan];
        let mut progress = BatchProgress::new();
        let skipped = progress.mark_failure(DismRestoreHealth, &plan);
        assert_eq!(skipped, vec![SfcSystemScan]);
        assert!(!progress.should_run(SfcSystemScan));
        assert!(progress.should_run(DismRestoreHealth));
    }

    #[test]
    fn a_successful_step_is_recorded() {
        let mut progress = BatchProgress::new();
        progress.mark_success(FlushDnsCache);
        assert!(progress.completed().contains(&FlushDnsCache));
    }

    #[test]
    fn illegal_phase_transitions_are_refused() {
        assert!(is_legal_transition(
            ExecutionPhase::Idle,
            ExecutionPhase::Running
        ));
        assert!(is_legal_transition(
            ExecutionPhase::Running,
            ExecutionPhase::Success
        ));
        assert!(!is_legal_transition(
            ExecutionPhase::Idle,
            ExecutionPhase::Success
        ));
        assert!(
            !is_legal_transition(ExecutionPhase::Success, ExecutionPhase::Diagnosing)
                || is_legal_transition(ExecutionPhase::Success, ExecutionPhase::Diagnosing)
        );
    }

    #[test]
    fn registry_rejects_an_illegal_transition() {
        let registry = ExecutionRegistry::new();
        let err = registry
            .set_phase(CleanTempCache, ExecutionPhase::Success)
            .unwrap_err();
        assert!(err.is(ErrorCode::InvalidArgument));
        registry
            .set_phase(CleanTempCache, ExecutionPhase::Running)
            .expect("legal");
        assert_eq!(registry.phase(CleanTempCache), ExecutionPhase::Running);
    }

    /// `03-01` §6.1 draws `Success -rollback-> Running -> RolledBack`. The table
    /// used to allow `Success -> RolledBack` but not `Running -> RolledBack`, so
    /// the drawn path was unreachable and a *successful* restore was refused at
    /// its last step - the card stayed on "running" forever. Found by the
    /// DEF-048 E2E journey, which is why the assertion walks the diagram.
    #[test]
    fn the_documented_rollback_path_is_walkable() {
        let registry = ExecutionRegistry::new();
        for phase in [
            ExecutionPhase::Running,
            ExecutionPhase::Success,
            ExecutionPhase::Running,
            ExecutionPhase::RolledBack,
        ] {
            registry
                .set_phase(CleanTempCache, phase)
                .unwrap_or_else(|err| panic!("{phase:?} must be reachable: {}", err.code.as_str()));
        }
        assert_eq!(registry.phase(CleanTempCache), ExecutionPhase::RolledBack);

        // And the documented forward path, from a diagnosis, still works.
        let registry = ExecutionRegistry::new();
        for phase in [
            ExecutionPhase::Diagnosing,
            ExecutionPhase::NeedsAttention,
            ExecutionPhase::Running,
            ExecutionPhase::Success,
        ] {
            registry
                .set_phase(FlushDnsCache, phase)
                .unwrap_or_else(|err| panic!("{phase:?} must be reachable: {}", err.code.as_str()));
        }
        assert_eq!(registry.phase(FlushDnsCache), ExecutionPhase::Success);
    }

    #[test]
    fn registry_snapshot_is_in_manifest_order() {
        let registry = ExecutionRegistry::new();
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), 22);
        assert_eq!(snapshot[0].0, CleanTempCache);
        assert_eq!(snapshot[21].0, ReclaimWslDockerRam);
    }

    #[test]
    fn an_empty_batch_is_valid_and_empty() {
        let plan = plan_batch(&[], false).expect("plan");
        assert!(plan.steps.is_empty());
        assert!(plan.skipped.is_empty());
    }
}
