#!/bin/sh
# TEMPORARY (M6 WebKit lost-frame regression, owner 2026-11-02; removed when found): the four-tile
# surveillance cases on desktop-safari and emulated-iphone, 3 times each, in five groups:
# prewarm / live-only off-off, prewarm only, live-only only, on-on (this tree, ?ab=), and the tree
# of c93d22f as it was. Notices go to the step's notices file (c93d22f's prefixed). Never fails the job.
projects="--project=desktop-safari --project=emulated-iphone"
STEP=ab OTTER_CI_AB=1 sh tooling/e2e-step.sh $projects e2e/surveillance.spec.ts --grep-invert "@bench" --repeat-each 3 --retries 0 || true
out="${RUNNER_TEMP:-.}/ci-notices.txt"
old="${RUNNER_TEMP:-/tmp}/c93d22f"
here="$(pwd)"
git fetch --depth=1 origin c93d22fee904081126d77fcacddd6ff039d1e2ec && git worktree add "$old" FETCH_HEAD || exit 0
cd "$old" || exit 0
pnpm install --frozen-lockfile || exit 0
PLAYWRIGHT_HTML_OUTPUT_DIR="$here/playwright-report/ab-c93d22f" pnpm exec playwright test $projects e2e/surveillance.spec.ts --grep-invert "@bench" --repeat-each 3 --retries 0 || true
if [ -f test-results/ci-notices.txt ]; then sed 's/^/[c93d22f] /' test-results/ci-notices.txt >> "$out"; fi
exit 0
