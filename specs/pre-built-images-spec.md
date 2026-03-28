# Pre-Built Docker Image Strategy for CRUCIBLE

**Status:** Approved
**Date:** 2026-03-28

## Problem

Tasks targeting specific projects need project-specific toolchains (Rust needs rustc/cargo, Python ML needs torch/numpy, Ruby needs rbenv). Installing at container startup adds 30-120s latency per run. We want pre-built images that already have the right toolchain.

## Design

### Detection: 3-Tier Cascade

CRUCIBLE resolves an image tag for each run by checking these tiers in order:

**Tier 1 — Explicit (task payload)**
```typescript
interface TaskPayload {
  // ... existing fields
  runtime?: string;   // "node" | "python" | "rust" | "go" | "ruby" | "jvm"
  image?: string;     // full override: "crucible-runner:rust" or any custom tag
}
```
`image` takes highest priority (full override). `runtime` maps to `crucible-runner:<runtime>`.

**Tier 2 — Convention (file detection in seedDir)**

If no explicit runtime, scan `taskPayload.seedDir` for signature files:

| File | Runtime |
|---|---|
| `Cargo.toml` | `rust` |
| `go.mod` | `go` |
| `Gemfile` | `ruby` |
| `pom.xml` or `build.gradle` | `jvm` |
| `pyproject.toml` or `requirements.txt` or `setup.py` | `python` |
| `package.json` | `node` |

Order matters — first match wins. `package.json` is last because the base image already includes Node 20.

**Tier 3 — Fallback**

No match → `crucible-runner:base` (current behavior, unchanged).

### Image Taxonomy

Ecosystem-level images sharing a common base layer:

```
crucible-runner:base        ← node:20-bookworm-slim + git, python3, build-essential,
                              curl, jq, iptables, claude-code (~450 MB)

crucible-runner:node        ← alias for base (Node already included)
crucible-runner:python      ← base + python3.12-full + pip + venv (~650 MB)
crucible-runner:rust        ← base + rustup + stable toolchain (~1.2 GB)
crucible-runner:go          ← base + go 1.22 (~750 MB)
crucible-runner:ruby        ← base + ruby 3.3 + bundler (~600 MB)
crucible-runner:jvm         ← base + openjdk-21 + maven + gradle (~900 MB)
```

**Why ecosystem-level, not combo images:** Combinatorial explosion (6 ecosystems → 15 pairs). The base already has Node 20 + Python 3, so most combos are handled. For the rare Rust+Python task, `rust` inherits base which has Python 3.

**Why not per-project images:** Build-on-first-use adds 1-5 min to the first run. Cache invalidation is hard. Ecosystem images cover 95%+ of cases.

### Dockerfile Structure

```
docker/
  Dockerfile.base     ← renamed from Dockerfile (current image)
  Dockerfile.python
  Dockerfile.rust
  Dockerfile.go
  Dockerfile.ruby
  Dockerfile.jvm
  entrypoint.sh       ← unchanged, shared by all images
```

Each ecosystem Dockerfile extends the base:
```dockerfile
FROM crucible-runner:base
RUN <install toolchain>
```

### Build Strategy

- **Local dev:** `docker build -t crucible-runner:base -f docker/Dockerfile.base docker/`
- **ensureImage() enhancement:** Accepts any `crucible-runner:<ecosystem>` tag. Finds the right Dockerfile by tag suffix. Builds base first if needed (since ecosystem images depend on it).
- **Future:** CI pipeline for weekly rebuilds (out of scope for initial implementation).

### Image Resolution in DockerRunner

Change `ensureImage()` to handle the new multi-image setup:

1. Parse tag to extract ecosystem suffix (`crucible-runner:rust` → `rust`)
2. Check if image exists locally
3. If missing, check if base exists (build base first if needed)
4. Build ecosystem image from `Dockerfile.<ecosystem>`

### Startup Latency Budget (image cached)

| Phase | Time |
|---|---|
| `docker create` | ~200ms |
| `docker start` + entrypoint | ~500ms-1s |
| `docker cp` (seed files) | ~200ms-2s |
| **Total** | **~1-3.5s** (meets <5s target) |

## Changes Required

### 1. Types (`src/types/index.ts`)
- Add `runtime?: string` and `image?: string` to `TaskPayload`

### 2. Runtime detection (`src/sandbox/runtime-detect.ts`) — NEW FILE
- `detectRuntime(seedDir: string): string | null` — scan for signature files
- `resolveImageTag(task: TaskPayload): string` — 3-tier cascade

### 3. DockerRunner (`src/sandbox/docker-runner.ts`)
- `ensureImage()`: support multi-image builds (base → ecosystem chain)
- `create()`: call `resolveImageTag()` instead of hardcoded `DEFAULT_IMAGE_TAG`
- Rename `docker/Dockerfile` → `docker/Dockerfile.base`

### 4. Dockerfiles (`docker/Dockerfile.*`)
- `Dockerfile.base` — current image, renamed
- `Dockerfile.python` — extends base
- `Dockerfile.rust` — extends base
- `Dockerfile.go` — extends base
- `Dockerfile.ruby` — extends base
- `Dockerfile.jvm` — extends base

### 5. DockerCliAgent (`src/agents/docker-cli-agent.ts`)
- No changes needed — already passes `imageTag` through to DockerRunner

## What We're NOT Doing

- **Devcontainer spec adoption:** Overhead exceeds value. We'd gain composable features but add a CLI dependency and subprocess overhead for something our custom Dockerfiles handle fine.
- **Buildpacks:** Designed for deployment, not dev environments. No exec/mount control.
- **Nix inside containers:** Good composability but 200-500 MB overhead and complexity. Revisit if ecosystem images prove too rigid.
- **Agent self-declaration:** Adds latency for a problem solvable statically.
- **Per-project images:** Maintenance burden, cache invalidation headaches.

## Prior Art Considered

| System | Approach | Startup | Our Takeaway |
|---|---|---|---|
| E2B | Firecracker VM snapshots | ~150ms | Fastest, but proprietary infra |
| Codespaces | devcontainer.json + prebuilds | 15-30s | Good spec, heavy for our needs |
| Replit | Nix closures in containers | ~3s warm | Best composability, steep curve |
| Nixpacks | File-signature auto-detect → OCI | N/A (build) | Borrowed detection pattern |
| Paketo/CNB | Buildpack groups → OCI | N/A (build) | Too deployment-focused |
| Gitpod | .gitpod.yml + prebuilds | ~3s prebuild | Similar to Codespaces |
