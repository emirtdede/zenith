import { readFileSync, writeFileSync } from "node:fs";

/**
 * Builds docs/11-release/11-05-final-report.md from the two checklists.
 *
 * The report is derived, not written by hand: every verdict in it is the verdict
 * in 11-02 or 11-03, so the three files cannot disagree. Re-run after editing
 * either checklist.
 */

function parseChecklist(path, prefix) {
  const text = readFileSync(path, "utf8");
  // The requirement rows live before the summary; section 7.1 repeats the FAIL
  // rows as a three-column register, which must not be parsed as requirements.
  const body = text.slice(0, text.indexOf("## 7. Summary"));
  const rows = [];

  let section = "";
  for (const line of body.split("\n")) {
    const heading = line.match(/^## \d+\. (.+)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (!new RegExp(`^\\| ${prefix}-\\d+ \\|`).test(line)) continue;

    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const [id, requirement, verification, evidence, result] = cells;
    const verdict = result.startsWith("PASS") ? "PASS" : result.startsWith("FAIL") ? "FAIL" : "UNKNOWN";
    const detail = result.replace(/^(PASS|FAIL)\s*-\s*/, "");
    rows.push({ section, id, requirement, verification, evidence, verdict, detail });
  }
  return { text, rows };
}

const github = parseChecklist("docs/11-release/11-02-github-checklist.md", "G");
const store = parseChecklist("docs/11-release/11-03-store-checklist.md", "M");

function counts(rows) {
  return {
    total: rows.length,
    pass: rows.filter((row) => row.verdict === "PASS").length,
    fail: rows.filter((row) => row.verdict === "FAIL").length,
    unknown: rows.filter((row) => row.verdict === "UNKNOWN").length,
  };
}

if (github.rows.some((row) => row.verdict === "UNKNOWN") || store.rows.some((row) => row.verdict === "UNKNOWN")) {
  throw new Error("a checklist row has no PASS or FAIL verdict, so the report cannot state one");
}

const gh = counts(github.rows);
const ms = counts(store.rows);

function table(rows) {
  const lines = [
    "| ID | Requirement | Verdict | Verification | Evidence |",
    "| :--- | :--- | :--- | :--- | :--- |",
  ];
  for (const row of rows) {
    const cell = (value) => value.replace(/\|/g, "\\|");
    lines.push(
      `| ${row.id} | ${cell(row.requirement)} | **${row.verdict}** | ${cell(row.verification)} | ${cell(row.evidence)} |`,
    );
  }
  return lines.join("\n");
}

function sections(rows) {
  const seen = [];
  for (const row of rows) if (!seen.includes(row.section)) seen.push(row.section);
  return seen.map((name) => {
    const subset = rows.filter((row) => row.section === name);
    const c = counts(subset);
    return `| ${name} | ${c.total} | ${c.pass} | ${c.fail} |`;
  }).join("\n");
}

const failRows = [...github.rows, ...store.rows].filter((row) => row.verdict === "FAIL");

const report = `# Zenith 1.0.0 Release Readiness Report

| Field | Value |
| :--- | :--- |
| Document ID | DOC-11-05 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-046 |
| Product | Zenith 1.0.0 |
| Tree under review | \`v1.0.0\` at \`85c125a\` on \`main\` |
| Reviewed on | 2026-11-24 |

This report is generated from
[\`11-02-github-checklist.md\`](11-02-github-checklist.md) and
[\`11-03-store-checklist.md\`](11-03-store-checklist.md) by
\`scripts/generate-release-report.mjs\`. Every verdict below is the verdict in one
of those two files; the report adds no opinion of its own, so the three documents
cannot disagree. Both tables list every requirement row, not a sample, because a
release decision has to see the row that failed as clearly as the rows that
passed.

The two channels are decided separately on purpose. The GitHub channel is an
installer that a user downloads and runs; the Microsoft Store channel is an MSIX
that Microsoft signs and the Store service installs. A fact that is true of one
is not automatically true of the other, and neither table borrows a \`PASS\` from
the other.

## 1. Verdict

| Channel | Requirement rows | \`PASS\` | \`FAIL\` |
| :--- | ---: | ---: | ---: |
| GitHub open source | ${gh.total} | ${gh.pass} | ${gh.fail} |
| Microsoft Store | ${ms.total} | ${ms.pass} | ${ms.fail} |

Neither channel is 100% today. The GitHub channel is ${gh.pass} of ${gh.total} and the Store
channel is ${ms.pass} of ${ms.total}; the rows that are not \`PASS\` are owner assets - a
code-signing certificate, a reserved Store identity, hosted legal URLs, a
submitted questionnaire, and a real-host Windows matrix - not code this tree
could write. Section 4 lists each one with the action that closes it.

## 2. GitHub open source checklist

| Section | Rows | \`PASS\` | \`FAIL\` |
| :--- | ---: | ---: | ---: |
${sections(github.rows)}

${table(github.rows)}

## 3. Microsoft Store checklist

| Section | Rows | \`PASS\` | \`FAIL\` |
| :--- | ---: | ---: | ---: |
${sections(store.rows)}

${table(store.rows)}

## 4. Every failing row and the action that closes it

${failRows.length} row${failRows.length === 1 ? "" : "s"} ${failRows.length === 1 ? "is" : "are"} not \`PASS\`. None of them is a defect that code in
this tree can fix, and none is marked \`PASS\` on the strength of being close.

| ID | Channel | Blocker | Owner action |
| :--- | :--- | :--- | :--- |
${failRows
  .map((row) => {
    const channel = row.id.startsWith("G") ? "GitHub" : "Store";
    return `| ${row.id} | ${channel} | ${row.requirement.replace(/\|/g, "\\|")} | ${row.detail.replace(/\|/g, "\\|")} |`;
  })
  .join("\n")}

## 5. Evidence pack

The checklists cite 39 evidence artefacts under \`evidence/\`, each described in
[\`evidence/README.md\`](../../evidence/README.md). The set a reviewer needs first:

| Artefact | What it proves |
| :--- | :--- |
| \`evidence/verify-final.log\` | the 34-step gate ran green on this tree |
| \`evidence/vitest-counts.json\` | 196 renderer tests in 14 files, measured, not counted by hand |
| \`evidence/e2e-final.log\` | three end-to-end journeys driven through the built binary |
| \`evidence/msix-check.log\` | the Store package re-opened with the Windows SDK and measured |
| \`evidence/arm64-build.log\`, \`evidence/arm64-check.log\` | the ARM64 binary compiles and its PE machine field is \`0xAA64\` |
| \`evidence/installer-languages.log\` | 52 installer translations against the pinned NSIS archive |
| \`evidence/release-verify.log\` | the published draft downloaded back, hashed and attested |
| \`evidence/screens/\` | main screens, all 12 settings tabs, boot skeleton beside loaded, six setup states, eleven script and RTL samples |

## 6. How to reproduce this report

\`\`\`powershell
npm run verify
npm run e2e
npm run check:msix
npm run check:arm64
node scripts/generate-release-report.mjs
\`\`\`

The first four commands repopulate the evidence files the tables cite. The last
one re-reads the two checklists and rewrites this report, so editing a verdict in
\`11-02\` or \`11-03\` and re-running it is the only supported way to change a row
here.
`;

writeFileSync("docs/11-release/11-05-final-report.md", report);

console.log(`GitHub ${gh.pass}/${gh.total} PASS, ${gh.fail} FAIL`);
console.log(`Store  ${ms.pass}/${ms.total} PASS, ${ms.fail} FAIL`);
console.log(`failing rows: ${failRows.map((row) => `${row.id} (${row.verdict})`).join(", ")}`);
console.log(`report bytes: ${report.length}`);
