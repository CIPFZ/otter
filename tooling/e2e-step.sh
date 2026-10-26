#!/bin/sh
# One CI e2e step: `pnpm e2e "$@"`, then keeps its notices. Playwright empties test-results/ at the
# start of every run, so each step's test-results/ci-notices.txt is appended to one file that the
# notices step reads ($RUNNER_TEMP/ci-notices.txt, or ./ci-notices-all.txt outside Actions).
out="${RUNNER_TEMP:-.}/ci-notices.txt"
pnpm e2e "$@"
rc=$?
if [ -f test-results/ci-notices.txt ]; then cat test-results/ci-notices.txt >> "$out"; fi
exit $rc
