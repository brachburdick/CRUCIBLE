#!/usr/bin/env bash
# CRUCIBLE Integration Test Suite
# Tests all four exit scenarios: clean completion, budget kill, loop kill, TTL kill.
# Requires: .env with valid API keys, npm run build completed.
#
# Usage: ./scripts/integration-test.sh [test-name]
#   test-name: clean | budget | loop | ttl (omit to run all)

set -euo pipefail
cd "$(dirname "$0")/.."

# ─── Helpers ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped)"; ((SKIP++)); }

# Check that result.json has the expected exitReason.type
check_exit_reason() {
  local run_dir="$1"
  local expected_type="$2"
  local result_file="$run_dir/result.json"

  if [[ ! -f "$result_file" ]]; then
    fail "result.json not found at $result_file"
    return 1
  fi
  pass "result.json exists"

  local actual_type
  actual_type=$(node -e "const r = JSON.parse(require('fs').readFileSync('$result_file','utf8')); console.log(r.exitReason.type)")

  if [[ "$actual_type" == "$expected_type" ]]; then
    pass "exitReason.type = '$expected_type'"
  else
    fail "exitReason.type = '$actual_type' (expected '$expected_type')"
    return 1
  fi
}

# Find the most recent run directory
latest_run_dir() {
  ls -td runs/*/ 2>/dev/null | head -1
}

# ─── Preflight ────────────────────────────────────────────────────────────────

echo "CRUCIBLE Integration Tests"
echo "========================="

if [[ ! -f .env ]] && [[ -z "${E2B_API_KEY:-}" ]]; then
  echo -e "${RED}Error: No .env file and no E2B_API_KEY in environment.${NC}"
  echo "Copy .env.example to .env and fill in your API keys."
  exit 1
fi

# Source .env if present (simple key=value, no export needed for node)
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Check required keys
missing_keys=()
for key in E2B_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY; do
  if [[ -z "${!key:-}" ]]; then
    missing_keys+=("$key")
  fi
done

if [[ ${#missing_keys[@]} -gt 0 ]]; then
  echo -e "${RED}Error: Missing required API keys: ${missing_keys[*]}${NC}"
  exit 1
fi

# Build if needed
if [[ ! -f dist/cli/run.js ]]; then
  echo "Building..."
  npm run build
fi

FILTER="${1:-all}"

# ─── TASK-011: Clean Completion ───────────────────────────────────────────────

run_clean() {
  echo ""
  echo "Test: Clean Completion (TASK-011)"
  echo "---------------------------------"

  local exit_code=0
  node dist/cli/run.js \
    --task tasks/example-simple.json \
    --variant integration-clean \
    --budget 10000 \
    --ttl 120 \
    || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    pass "exit code = 0"
  else
    fail "exit code = $exit_code (expected 0)"
    return
  fi

  local run_dir
  run_dir=$(latest_run_dir)
  if [[ -z "$run_dir" ]]; then
    fail "no run directory created"
    return
  fi

  check_exit_reason "$run_dir" "completed"
}

# ─── TASK-012: Budget Kill ────────────────────────────────────────────────────

run_budget() {
  echo ""
  echo "Test: Budget Kill (TASK-012)"
  echo "----------------------------"

  local exit_code=0
  node dist/cli/run.js \
    --task tasks/example-simple.json \
    --variant integration-budget \
    --budget 100 \
    --ttl 120 \
    || exit_code=$?

  if [[ $exit_code -eq 1 ]]; then
    pass "exit code = 1"
  else
    fail "exit code = $exit_code (expected 1)"
    return
  fi

  local run_dir
  run_dir=$(latest_run_dir)
  check_exit_reason "$run_dir" "budget_exceeded"
}

# ─── TASK-013: Loop Kill ─────────────────────────────────────────────────────

run_loop() {
  echo ""
  echo "Test: Loop Kill (TASK-013)"
  echo "--------------------------"

  local exit_code=0
  node dist/cli/run.js \
    --task tasks/example-looping.json \
    --variant integration-loop \
    --budget 50000 \
    --ttl 120 \
    || exit_code=$?

  if [[ $exit_code -eq 2 ]]; then
    pass "exit code = 2"
  else
    fail "exit code = $exit_code (expected 2)"
    return
  fi

  local run_dir
  run_dir=$(latest_run_dir)
  check_exit_reason "$run_dir" "loop_detected"
}

# ─── TASK-014: TTL Kill ──────────────────────────────────────────────────────

run_ttl() {
  echo ""
  echo "Test: TTL Kill (TASK-014)"
  echo "-------------------------"

  local exit_code=0
  node dist/cli/run.js \
    --task tasks/example-simple.json \
    --variant integration-ttl \
    --budget 50000 \
    --ttl 5 \
    || exit_code=$?

  if [[ $exit_code -eq 3 ]]; then
    pass "exit code = 3"
  else
    fail "exit code = $exit_code (expected 3)"
    return
  fi

  local run_dir
  run_dir=$(latest_run_dir)
  check_exit_reason "$run_dir" "ttl_exceeded"
}

# ─── Run ──────────────────────────────────────────────────────────────────────

case "$FILTER" in
  clean)  run_clean ;;
  budget) run_budget ;;
  loop)   run_loop ;;
  ttl)    run_ttl ;;
  all)
    run_clean
    run_budget
    run_loop
    run_ttl
    ;;
  *)
    echo "Unknown test: $FILTER"
    echo "Usage: $0 [clean|budget|loop|ttl|all]"
    exit 1
    ;;
esac

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "========================="
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
