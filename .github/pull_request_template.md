npm run verify

<!--
The line above is not a formality. Paste the last 20 lines of that command's
output under it, before anything else in this description. If it is red, the
change is not ready for review and the failure tells a reviewer more than a
summary would.

Checklist:

- [ ] The first line of this description is the `npm run verify` result.
- [ ] The change is one subject. A functional change and a documentation
      rewrite are two pull requests, even when they touch the same file.
- [ ] New behaviour has a test that fails without the change. A test that
      passes on the old code is a comment with a green tick.
- [ ] A new string exists in `src/i18n/en.ts` and `src/i18n/tr.ts`, and
      `npm run check:locales` passes.
- [ ] A new gate script is listed in `package.json`, in the test plan
      (`docs/07-quality/07-01-test-plan.md`), and (if it is a release gate,
      not part of `verify`) in the checklist that runs it.
- [ ] No emoji, no em dash, no en dash in any authored text.
- [ ] No secret, token, or personal path in the diff.
- [ ] If a counted number in a document moved, `npm run check:doc-counts`
      passes.
- [ ] If an artefact under `evidence/` was added or replaced, it has a ledger
      row in `evidence/README.md`.
-->
