//! Dependency ordering (Kahn's algorithm) over the action manifest.
//!
//! Two behaviours matter and both are tested:
//!
//! 1. **Stable order.** Ties are broken by manifest `order`, so the same
//!    selection always produces the same script, byte for byte (REQ-F-081).
//! 2. **Fail-fast is a graph property.** When a node fails, every transitive
//!    dependent is marked skipped rather than run against a half-repaired
//!    system (REQ-F-030).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::manifest::{ACTIONS, action_by_id};
use crate::models::ActionId;

/// Topologically sort `selection`, restricted to the subgraph those actions form.
///
/// Dependencies outside the selection are ignored: if the user only picked `sfc`,
/// we do not silently run `dism` for them - the executor refuses with
/// `DEPENDENCY_NOT_MET` instead, which is visible in the UI.
pub fn topological_order(selection: &[ActionId]) -> ZenithResult<Vec<ActionId>> {
    let wanted: BTreeSet<ActionId> = selection.iter().copied().collect();

    let mut indegree: BTreeMap<ActionId, usize> = BTreeMap::new();
    let mut successors: BTreeMap<ActionId, Vec<ActionId>> = BTreeMap::new();

    for id in &wanted {
        indegree.entry(*id).or_insert(0);
        successors.entry(*id).or_default();
    }

    for id in &wanted {
        for dep in action_by_id(*id).depends_on {
            if wanted.contains(dep) {
                *indegree.entry(*id).or_insert(0) += 1;
                successors.entry(*dep).or_default().push(*id);
            }
        }
    }

    // Ready set ordered by manifest position, never by hash order.
    let mut ready: VecDeque<ActionId> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| *id)
        .collect::<Vec<_>>()
        .into_iter()
        .collect();
    sort_by_manifest_order(&mut ready);

    let mut ordered = Vec::with_capacity(wanted.len());
    while let Some(current) = ready.pop_front() {
        ordered.push(current);
        let mut unlocked = Vec::new();
        for next in successors.get(&current).cloned().unwrap_or_default() {
            if let Some(degree) = indegree.get_mut(&next) {
                *degree = degree.saturating_sub(1);
                if *degree == 0 {
                    unlocked.push(next);
                }
            }
        }
        // Insert newly ready nodes in manifest order relative to the queue.
        for node in unlocked {
            let position = ready
                .iter()
                .position(|existing| manifest_order(*existing) > manifest_order(node))
                .unwrap_or(ready.len());
            ready.insert(position, node);
        }
    }

    if ordered.len() != wanted.len() {
        let stuck: Vec<String> = wanted
            .iter()
            .filter(|id| !ordered.contains(id))
            .map(ToString::to_string)
            .collect();
        return Err(ZenithError::new(ErrorCode::DependencyNotMet)
            .with("reason", "cyclic")
            .with("actions", stuck.join(",")));
    }

    Ok(ordered)
}

/// Every action reachable from `failed` through dependency edges, excluding
/// `failed` itself. These become `SkippedDependency`.
pub fn transitive_dependents(failed: ActionId, selection: &[ActionId]) -> Vec<ActionId> {
    let wanted: BTreeSet<ActionId> = selection.iter().copied().collect();
    let mut result = BTreeSet::new();
    let mut frontier = vec![failed];

    while let Some(current) = frontier.pop() {
        for candidate in &wanted {
            if *candidate == failed || result.contains(candidate) {
                continue;
            }
            if action_by_id(*candidate).depends_on.contains(&current) {
                result.insert(*candidate);
                frontier.push(*candidate);
            }
        }
    }

    let mut out: Vec<ActionId> = result.into_iter().collect();
    out.sort_by_key(|id| manifest_order(*id));
    out
}

/// True when every dependency of `id` is satisfied by `completed`.
pub fn dependencies_satisfied(id: ActionId, completed: &BTreeSet<ActionId>) -> bool {
    action_by_id(id)
        .depends_on
        .iter()
        .all(|dep| completed.contains(dep))
}

fn manifest_order(id: ActionId) -> u8 {
    action_by_id(id).order
}

fn sort_by_manifest_order(queue: &mut VecDeque<ActionId>) {
    let mut items: Vec<ActionId> = queue.drain(..).collect();
    items.sort_by_key(|id| manifest_order(*id));
    queue.extend(items);
}

/// The full manifest in dependency-safe order. Used by the health snapshot and
/// by docs generation.
pub fn full_order() -> ZenithResult<Vec<ActionId>> {
    let all: Vec<ActionId> = ACTIONS.iter().map(|def| def.id).collect();
    topological_order(&all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ActionId::*;

    #[test]
    fn full_manifest_sorts_without_cycles() {
        let order = full_order().expect("acyclic");
        assert_eq!(order.len(), 22);
    }

    #[test]
    fn dism_runs_before_sfc() {
        let order = topological_order(&[SfcSystemScan, DismRestoreHealth]).expect("sort");
        let dism = order
            .iter()
            .position(|id| *id == DismRestoreHealth)
            .unwrap();
        let sfc = order.iter().position(|id| *id == SfcSystemScan).unwrap();
        assert!(dism < sfc, "DISM must precede SFC, got {order:?}");
    }

    #[test]
    fn dns_flush_runs_before_winsock_reset() {
        let order = topological_order(&[ResetWinsockStack, FlushDnsCache]).expect("sort");
        let dns = order.iter().position(|id| *id == FlushDnsCache).unwrap();
        let winsock = order
            .iter()
            .position(|id| *id == ResetWinsockStack)
            .unwrap();
        assert!(dns < winsock);
    }

    #[test]
    fn ordering_is_stable_across_input_permutations() {
        let selection = [
            SfcSystemScan,
            CleanTempCache,
            DismRestoreHealth,
            FlushDnsCache,
        ];
        let first = topological_order(&selection).expect("sort");
        let mut reversed = selection;
        reversed.reverse();
        let second = topological_order(&reversed).expect("sort");
        assert_eq!(first, second);
    }

    #[test]
    fn dependencies_outside_the_selection_are_ignored() {
        // SFC alone must not drag DISM in silently.
        let order = topological_order(&[SfcSystemScan]).expect("sort");
        assert_eq!(order, vec![SfcSystemScan]);
    }

    #[test]
    fn transitive_dependents_are_found() {
        let selection = [DismRestoreHealth, SfcSystemScan];
        let skipped = transitive_dependents(DismRestoreHealth, &selection);
        assert_eq!(skipped, vec![SfcSystemScan]);
    }

    #[test]
    fn dependency_satisfaction_is_explicit() {
        let mut completed = BTreeSet::new();
        assert!(!dependencies_satisfied(SfcSystemScan, &completed));
        completed.insert(DismRestoreHealth);
        assert!(dependencies_satisfied(SfcSystemScan, &completed));
    }

    #[test]
    fn an_empty_selection_sorts_to_empty() {
        assert!(topological_order(&[]).expect("sort").is_empty());
    }

    #[test]
    fn duplicate_entries_are_deduplicated() {
        let order = topological_order(&[FlushDnsCache, FlushDnsCache]).expect("sort");
        assert_eq!(order, vec![FlushDnsCache]);
    }
}
