#!/bin/sh
# TEMPORARY (M6 WebKit lost-frame regression, owner 2026-11-02; removed when found). $1:
#   early / late: the four-tile surveillance cases on desktop-safari, 3 times, on a fresh preview
#     server, before and after the main step (retries off).
#   old: the tree of c93d22f on desktop-safari with every spec up to surveillance in order, i.e.
#     the same position as in the main step, notices prefixed. Never fails the job.
projects="--project=desktop-safari"
case "$1" in
  early|late)
    STEP="ab-$1" OTTER_CI_TAG="$1" sh tooling/e2e-step.sh $projects e2e/surveillance.spec.ts --grep-invert "@bench" --repeat-each 3 --retries 0 --workers=1 || true
    ;;
  old)
    out="${RUNNER_TEMP:-.}/ci-notices.txt"
    tree="${RUNNER_TEMP:-/tmp}/c93d22f"
    here="$(pwd)"
    git fetch --depth=1 origin c93d22fee904081126d77fcacddd6ff039d1e2ec && git worktree add "$tree" FETCH_HEAD || exit 0
    cd "$tree" || exit 0
    pnpm install --frozen-lockfile || exit 0
    specs="$(ls e2e/*.spec.ts | awk '$0 <= "e2e/surveillance.spec.ts"')"
    PLAYWRIGHT_HTML_OUTPUT_DIR="$here/playwright-report/ab-c93d22f" pnpm exec playwright test $projects $specs --grep-invert "@network|@bench|@solo" --retries 0 --workers=1 || true
    if [ -f test-results/ci-notices.txt ]; then sed 's/^/[c93d22f] /' test-results/ci-notices.txt >> "$out"; fi
    ;;
esac
exit 0
