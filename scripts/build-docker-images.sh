#!/usr/bin/env bash
# Build CRUCIBLE Docker images (base + ecosystem).
#
# Usage: scripts/build-docker-images.sh [--force] [--test] [--parallel] [ecosystem...]
#   No args:      build all images (base first, then ecosystems)
#   --force:      rebuild even if image already exists
#   --parallel:   build ecosystem images in parallel (after base)
#   --test:       run smoke tests after build
#   ecosystem:    python rust go ruby jvm (base is always built first if needed)
#
# Examples:
#   ./scripts/build-docker-images.sh                    # build all
#   ./scripts/build-docker-images.sh python rust        # build base + python + rust
#   ./scripts/build-docker-images.sh --force --test     # force rebuild all + smoke test
#   ./scripts/build-docker-images.sh --parallel         # build ecosystems concurrently

set -euo pipefail
cd "$(dirname "$0")/.."

# ─── Config ───

DOCKER_DIR="docker"
IMAGE_PREFIX="crucible-runner"
ALL_ECOSYSTEMS=(python rust go ruby jvm)

# ─── Colors ───

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Parse args ───

FORCE=false
RUN_TESTS=false
PARALLEL=false
ECOSYSTEMS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)   FORCE=true; shift ;;
    --test)    RUN_TESTS=true; shift ;;
    --parallel) PARALLEL=true; shift ;;
    --help|-h)
      head -14 "$0" | tail -13 | sed 's/^# \?//'
      exit 0
      ;;
    *)
      # Validate ecosystem name
      valid=false
      for eco in "${ALL_ECOSYSTEMS[@]}"; do
        [[ "$1" == "$eco" ]] && valid=true && break
      done
      if $valid; then
        ECOSYSTEMS+=("$1")
      else
        echo -e "${RED}Unknown ecosystem: $1${NC}"
        echo "Valid ecosystems: ${ALL_ECOSYSTEMS[*]}"
        exit 1
      fi
      shift
      ;;
  esac
done

# Default: build all
if [[ ${#ECOSYSTEMS[@]} -eq 0 ]]; then
  ECOSYSTEMS=("${ALL_ECOSYSTEMS[@]}")
fi

# ─── Helpers ───

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

build_image() {
  local tag="$1"
  local dockerfile="$2"
  local label="$3"

  if ! $FORCE && image_exists "$tag"; then
    echo -e "  ${YELLOW}skip${NC} $tag (exists, use --force to rebuild)"
    return 0
  fi

  echo -e "  ${BLUE}build${NC} $tag from $dockerfile"
  local start_time=$SECONDS

  if ! docker build -t "$tag" -f "$dockerfile" "$DOCKER_DIR" 2>&1 | tail -3; then
    echo -e "  ${RED}FAIL${NC} $tag"
    return 1
  fi

  local elapsed=$(( SECONDS - start_time ))
  local size
  size=$(docker image inspect "$tag" --format '{{.Size}}' 2>/dev/null)
  local size_mb=$(( size / 1048576 ))
  echo -e "  ${GREEN}done${NC} $tag (${elapsed}s, ${size_mb} MB)"
}

# ─── Build ───

echo -e "${BOLD}CRUCIBLE Docker Image Builder${NC}"
echo "=============================="
echo ""

TOTAL_START=$SECONDS
FAILED=()

# 1. Always build base first
echo -e "${BOLD}[1/2] Base image${NC}"
build_image "${IMAGE_PREFIX}:base" "${DOCKER_DIR}/Dockerfile.base" "base" || FAILED+=("base")
echo ""

# 2. Build ecosystem images
echo -e "${BOLD}[2/2] Ecosystem images: ${ECOSYSTEMS[*]}${NC}"

if $PARALLEL && [[ ${#ECOSYSTEMS[@]} -gt 1 ]]; then
  # Parallel build
  PIDS=()
  LOGS_DIR=$(mktemp -d)

  for eco in "${ECOSYSTEMS[@]}"; do
    dockerfile="${DOCKER_DIR}/Dockerfile.${eco}"
    if [[ ! -f "$dockerfile" ]]; then
      echo -e "  ${RED}skip${NC} $eco (no $dockerfile)"
      FAILED+=("$eco")
      continue
    fi
    (
      build_image "${IMAGE_PREFIX}:${eco}" "$dockerfile" "$eco"
    ) > "${LOGS_DIR}/${eco}.log" 2>&1 &
    PIDS+=("$!")
  done

  # Wait and collect results
  for i in "${!PIDS[@]}"; do
    eco="${ECOSYSTEMS[$i]}"
    if ! wait "${PIDS[$i]}"; then
      FAILED+=("$eco")
    fi
    cat "${LOGS_DIR}/${eco}.log"
  done
  rm -rf "$LOGS_DIR"
else
  # Sequential build
  for eco in "${ECOSYSTEMS[@]}"; do
    dockerfile="${DOCKER_DIR}/Dockerfile.${eco}"
    if [[ ! -f "$dockerfile" ]]; then
      echo -e "  ${RED}skip${NC} $eco (no $dockerfile)"
      FAILED+=("$eco")
      continue
    fi
    build_image "${IMAGE_PREFIX}:${eco}" "$dockerfile" "$eco" || FAILED+=("$eco")
  done
fi

echo ""

# ─── Summary ───

TOTAL_ELAPSED=$(( SECONDS - TOTAL_START ))

echo "=============================="
echo -e "${BOLD}Image inventory:${NC}"
docker images "${IMAGE_PREFIX}" --format "  {{.Tag}}\t{{.Size}}\t{{.CreatedSince}}" | sort
echo ""
echo -e "Total build time: ${TOTAL_ELAPSED}s"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo -e "${RED}Failed: ${FAILED[*]}${NC}"
  exit 1
fi

echo -e "${GREEN}All images built successfully.${NC}"

# ─── Optional smoke tests ───

if $RUN_TESTS; then
  echo ""
  echo -e "${BOLD}Running smoke tests...${NC}"
  exec ./scripts/test-docker-images.sh
fi
