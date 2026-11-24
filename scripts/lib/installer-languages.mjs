/**
 * The installer's language contract, as a pure function.
 *
 * Extracted from `check-installer` so the negative self-test can drive the same
 * code with synthetic rows. The defect this exists for is DEF-168: the shipped
 * installer declared 71 translations, 19 of which were absent from the pinned
 * NSIS 3.11 archive. They were present in one developer's `%LOCALAPPDATA%`
 * cache, because those files had been added by hand, so the gate passed on that
 * machine and skipped on a fresh CI runner; the release build then failed with
 * `Can't open language file - "...\Bengali.nlf"`.
 *
 * The rule that follows: the declaration is validated against the archive's own
 * inventory, never against whatever the machine happens to have.
 */

/**
 * @param {object} input
 * @param {Array<{code: string, nsis: string|null, fallback?: string}>} input.rows
 *   One row per UI locale, from `src-tauri/installer/languages.json`.
 * @param {string[]} input.registryCodes
 *   Every locale code the product exposes, in registry order.
 * @param {string[]} input.declared
 *   `bundle.windows.nsis.languages` from `tauri.conf.json`.
 * @param {string[]|null} input.archiveLanguages
 *   The language names inside the pinned NSIS archive, or null when the
 *   inventory could not be read.
 * @param {number|null} [input.archiveCount]
 * @returns {string[]} problems; empty means the contract holds.
 */
export function validateInstallerLanguages({ rows, registryCodes, declared, archiveLanguages, archiveCount = null }) {
  const problems = [];
  const archive = Array.isArray(archiveLanguages) ? new Set(archiveLanguages) : null;
  const archiveSize = archiveCount ?? (archive ? archive.size : 0);

  if (rows.length !== registryCodes.length) {
    problems.push(`installer/languages.json has ${rows.length} rows but the product registry has ${registryCodes.length}`);
  }

  const codes = new Set(rows.map((row) => row.code));
  for (const code of registryCodes) {
    if (!codes.has(code)) problems.push(`installer/languages.json has no row for ${code}`);
  }
  for (const row of rows) {
    if (!registryCodes.includes(row.code)) {
      problems.push(`installer/languages.json has a row for ${row.code}, which the registry does not expose`);
    }
  }

  for (const row of rows) {
    if (row.nsis === null) {
      // A locale with no NSIS translation runs the installer in English. That is
      // allowed, but it must be a declared fallback, not a silent gap.
      if (row.fallback !== "en") problems.push(`${row.code}: nsis is null and no English fallback is declared`);
      continue;
    }
    if (!archive) {
      problems.push(`${row.code}: "${row.nsis}" cannot be checked, the pinned archive inventory is unreadable`);
    } else if (!archive.has(row.nsis)) {
      problems.push(
        `${row.code}: "${row.nsis}" is not one of the ${archiveSize} languages in the pinned NSIS 3.11 archive`,
      );
    }
  }

  const expected = [...new Set(rows.filter((row) => row.nsis).map((row) => row.nsis))];
  if (JSON.stringify(expected) !== JSON.stringify(declared)) {
    problems.push(
      `tauri.conf.json nsis.languages does not match installer/languages.json (${declared.length} declared, ${expected.length} mapped)`,
    );
  }
  if (new Set(declared).size !== declared.length) problems.push("installer language list has duplicates");

  return problems;
}
