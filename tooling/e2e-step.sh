#!/bin/sh
# One CI e2e step: `pnpm e2e "$@"`, then keeps its notices. Playwright empties test-results/ at the
# start of every run, so each step's test-results/ci-notices.txt is appended to one file that the
# notices step reads ($RUNNER_TEMP/ci-notices.txt, or ./ci-notices-all.txt outside Actions).
# Each step's HTML report (with the screenshots and traces of failed and flaky tests) goes to its
# own folder, playwright-report/<STEP> (STEP set per CI step; default main): one report folder
# would keep only the last step's.
out="${RUNNER_TEMP:-.}/ci-notices.txt"
export PLAYWRIGHT_HTML_OUTPUT_DIR="playwright-report/${STEP:-main}"
# On CI a step stops after 45 min (the longest, WebKit main, takes about 26): a hung test then
# ends the step with a report naming what was still running, instead of holding the job until
# GitHub's 6 h limit (2026-11-04, 487a400's WebKit main ran 2 h without finishing).
if [ -n "$CI" ]; then set -- --global-timeout="${OTTER_STEP_TIMEOUT_MS:-2700000}" "$@"; fi
pnpm e2e "$@"
rc=$?
if [ -f test-results/ci-notices.txt ]; then cat test-results/ci-notices.txt >> "$out"; fi
exit $rc
