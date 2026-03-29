---
status: DRAFT
created: 2026-03-28
project: CRUCIBLE
phase: 8A
title: Artifact Apply — Diff-First, Apply-on-Demand
---

# Phase 8A: Artifact Apply — Diff-First, Apply-on-Demand

## 1. Problem Statement

CRUCIBLE's three agent backends (coder, claude-cli, docker-cli) all execute in isolation — a temp
directory, Docker container, or E2B sandbox. After a run completes, the agent's file changes are
flushed to `runs/<runId>/artifacts/` as a full directory snapshot. But there is no mechanism to:

1. See **what changed** (diff between seed files and artifacts)
2. **Apply** those changes back to the local codebase
3. Track which runs have been applied vs. reviewed vs. discarded

This was exposed during Phase 7A QA: task-023 launched via the UI successfully added a TEST tab
to NavBar.tsx, but the change existed only in the run's temp directory. A subsequent task to
*remove* the tab failed because the local codebase was never modified.

CRUCIBLE is an evaluation harness first, but operators increasingly use it for real work. The gap
between "agent completed successfully" and "changes are in my codebase" needs a deliberate bridge
— one that preserves the review-first evaluation mindset.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary artifact | Unified diff (`.patch`) | Human-readable, git-native, works with all three backends. The diff is the evaluation artifact — you review what changed before deciding to apply. |
| Diff scope | `writtenFiles` only, not full snapshot | CLI stream parsing already tracks which files were Write/Edit targets. Diffing only those avoids noise from unchanged seed files copied into the sandbox. |
| Diff baseline | seedDir at run start time | The diff represents what the agent changed relative to what it was given. If seedDir has changed since the run, the apply may conflict — this is expected and handled by git. |
| Storage | `runs/<runId>/diff.patch` alongside existing `artifacts/` | No new directories. The patch file is a peer of `result.json` and `artifacts/`. |
| Apply mechanism | `git apply` on the local repo | Leverages git's conflict detection. Operator sees the result in `git diff` and can commit or reset. |
| Apply tracking | `applied` field in run DB row | Simple boolean + timestamp. No new table. |
| Commit creation | Optional, operator-initiated | Apply puts changes in the working tree. The operator decides whether to commit, amend, or discard. An optional "Apply & commit" bundles both steps. |
| Branch creation | Not default, available as escalation | Most applies are small and direct. A "Apply to branch" option creates `crucible/<runId-short>` for cases where the operator wants isolation. |

---

## 3. Architecture

### 3.1 Diff generation (backend, at teardown)

After artifact flush completes in RunEngine, generate a unified diff comparing the original seed
files against the artifact versions — but **only for files in `writtenFiles`**.

```
Run completes
    │
    ▼
flushArtifacts() → runs/<runId>/artifacts/
    │
    ▼
generateDiff(seedDir, artifactDir, writtenFiles)
    │
    ▼
runs/<runId>/diff.patch
    │
    ▼
result.json updated: { diff: { path, stats: { filesChanged, insertions, deletions } } }
```

**Why `writtenFiles` not full snapshot?** The artifact directory contains every file from the
sandbox — including unchanged copies of seed files, `.bashrc`, tool configs, etc. Diffing the
entire directory would produce noise. The CLI stream parsing already identifies exactly which
files the agent wrote to via Write/Edit tool calls. Diffing only those gives a clean, relevant
patch.

**Fallback for coder (E2B) path:** The E2B/coder agent doesn't use CLI stream parsing, so
`writtenFiles` isn't populated. For this path, diff all files in `artifacts/` that also exist in
the seed — or generate a full-tree diff. This is noisier but acceptable since E2B runs are
typically evaluated, not applied.

### 3.2 Diff endpoint (API)

```
GET /api/runs/:id/diff
  → 200: { patch: string, stats: { filesChanged, insertions, deletions }, applied: boolean }
  → 404: { error: "No diff available" }  (run has no seedDir, or diff generation failed)
```

Returns the unified diff as a string (for rendering) plus summary stats.

### 3.3 Apply endpoint (API)

```
POST /api/runs/:id/apply
  Body: { mode: 'working-tree' | 'branch' | 'commit', commitMessage?: string }
  → 200: { applied: true, mode, branch?: string, commitHash?: string }
  → 409: { error: "Conflicts detected", conflicts: string[] }
  → 400: { error: "No seedDir on this run" | "Already applied" | "No diff available" }
```

**Modes:**
- `working-tree` (default): `git apply` the patch to the seedDir. Changes appear in
  `git status`. Operator reviews and commits manually.
- `branch`: Creates `crucible/<runId-short>`, applies there. Returns the branch name.
- `commit`: Applies + commits with the provided message (or auto-generated:
  `crucible: apply run <runId-short> (<variant>)`). Returns the commit hash.

**Conflict handling:** If `git apply` fails, return 409 with the list of conflicting files.
The operator can then manually apply with `git apply --3way` or review the artifacts directly.

### 3.4 Apply tracking (DB)

Add to the runs table:

```sql
ALTER TABLE runs ADD COLUMN applied_at TEXT;      -- ISO 8601 timestamp, null if not applied
ALTER TABLE runs ADD COLUMN applied_mode TEXT;     -- 'working-tree' | 'branch' | 'commit'
```

The `GET /api/runs/:id` response includes these fields so the UI can show apply status.

---

## 4. Frontend Changes

### 4.1 Diff viewer on Run Detail page

Add a collapsible **"Changes"** section to RunDetail.tsx, between the Result section and Events
section. Visible only for completed runs that have a diff.

```
─── Changes ──────────────────────────────────────────────────────────
3 files changed, +42 insertions, -7 deletions

  ui/src/components/NavBar.tsx     +5 -0
  ui/src/pages/TestPage.tsx        +32 -0   (new file)
  ui/src/App.tsx                   +5 -7

  [View full diff]     [Apply to working tree]     [Apply & commit ▾]
─────────────────────────────────────────────────────────────────────
```

**Components:**
- **DiffSummary**: File list with per-file insertion/deletion counts. Always visible.
- **DiffViewer**: Full unified diff with syntax highlighting (expandable). Uses a simple
  `<pre>` with green/red line coloring — no need for a full code editor.
- **ApplyButton**: Primary action. Shows "Apply to working tree" by default. Dropdown for
  "Apply & commit" and "Apply to branch". Disabled + shows "Applied" after successful apply.

### 4.2 Applied badge on Dashboard

Runs that have been applied show a small "applied" badge next to the status badge in the
Dashboard run list. This helps operators distinguish between runs they've reviewed/applied
and runs that are just evaluation artifacts.

### 4.3 Run Detail layout (updated)

```
[Run Header — id, variant, agent, status badge, applied badge]

[Config Summary — Agent, Variant, Budget, TTL]

[Token Progress Bar]

[Result — Exit Reason, Tokens, Wall Time]     (completed runs only)

[Changes — diff summary, apply buttons]        (NEW — completed runs with diff)

[Events — event feed]
```

---

## 5. Backend Changes

### 5.1 Diff generation in RunEngine

**Where:** After artifact flush, before emitting `run_completed` event. All three teardown paths
(CLI, Docker-CLI, E2B) converge on writing `result.json` — the diff step goes just before that.

**New function:** `generateRunDiff(runId, seedDir, artifactDir, writtenFiles) → DiffResult`

```typescript
interface DiffResult {
  patchPath: string;        // runs/<runId>/diff.patch
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: Array<{
      path: string;           // relative to seedDir
      insertions: number;
      deletions: number;
      status: 'modified' | 'added' | 'deleted';
    }>;
  };
}
```

**Implementation:** For each file in `writtenFiles`:
1. Resolve the original path relative to `seedDir`
2. Resolve the artifact path relative to `artifactDir`
3. Generate unified diff (use `diff` library or shell out to `git diff --no-index`)
4. Concatenate into a single `.patch` file
5. Parse stats from the diff output

**Edge cases:**
- File in `writtenFiles` doesn't exist in seedDir → new file (show as added)
- File in seedDir deleted by agent → not in `writtenFiles` (won't appear in diff — acceptable
  since agents rarely delete files)
- No seedDir on the run → skip diff generation entirely
- Empty diff (agent wrote files but content is identical) → don't create diff.patch

### 5.2 New route: `src/server/routes/artifacts.ts`

Register both endpoints:
- `GET /api/runs/:id/diff` — reads `runs/<runId>/diff.patch`, returns parsed content + stats
- `POST /api/runs/:id/apply` — applies the patch via `git apply` in the seedDir

### 5.3 DB migration

Add `applied_at` and `applied_mode` columns to the runs table. Both nullable.

### 5.4 RunResult extension

Add optional `diff` field to `RunResult`:

```typescript
interface RunResult {
  // ... existing fields ...
  diff?: {
    patchPath: string;
    stats: { filesChanged: number; insertions: number; deletions: number };
  };
}
```

---

## 6. Implementation Order

```
Step 1 — Diff generation (backend, no UI)
  a. Implement generateRunDiff() utility function
  b. Wire into CLI teardown path (writtenFiles available)
  c. Wire into Docker-CLI teardown path (writtenFiles available)
  d. Wire into E2B teardown path (fallback: diff all seed-matching files)
  e. Extend RunResult with diff field
  f. Write diff.patch to runs/<runId>/
  g. Tests: generate diff for known before/after, verify stats

Step 2 — API endpoints
  a. GET /api/runs/:id/diff — return patch content + stats
  b. POST /api/runs/:id/apply — git apply + tracking
  c. DB migration: applied_at, applied_mode columns
  d. Include applied status in GET /api/runs/:id response
  e. Tests: apply endpoint with clean apply, conflict case, already-applied case

Step 3 — Run Detail UI
  a. DiffSummary component (file list + stats)
  b. DiffViewer component (expandable full diff with line coloring)
  c. ApplyButton with mode dropdown
  d. Wire into RunDetail.tsx between Result and Events
  e. Applied badge on Dashboard run list

Step 4 — Verify
  a. npm run build — no type errors
  b. npm test — all tests pass
  c. End-to-end: launch a run via UI, view diff, apply, verify local files changed
```

---

## 7. Files to Create

| File | Purpose |
|------|---------|
| `src/engine/diff.ts` | `generateRunDiff()` utility — diffing logic, stats parsing |
| `src/server/routes/artifacts.ts` | `GET /api/runs/:id/diff` + `POST /api/runs/:id/apply` |
| `ui/src/components/DiffSummary.tsx` | File list with per-file stats |
| `ui/src/components/DiffViewer.tsx` | Expandable unified diff display |
| `ui/src/components/ApplyButton.tsx` | Apply action with mode dropdown |

## Files to Modify

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `diff` field to `RunResult` |
| `src/engine/RunEngine.ts` | Call `generateRunDiff()` in all three teardown paths |
| `src/server/index.ts` | Register artifacts route |
| `src/server/db.ts` | Add `applied_at`, `applied_mode` columns; update queries |
| `ui/src/pages/RunDetail.tsx` | Add Changes section with DiffSummary, DiffViewer, ApplyButton |
| `ui/src/pages/Dashboard.tsx` | Add applied badge to run rows |

---

## 8. Non-Goals (Phase 8A)

- **Cherry-pick / partial apply** — Apply is all-or-nothing. Partial apply (selecting specific
  files from the diff) is a future enhancement.
- **Auto-apply** — Applying is always operator-initiated. No automatic application even for
  passing runs.
- **PR creation** — The "Apply to branch" mode creates a local branch but doesn't open a PR.
  PR creation can be added later as a trivial `gh pr create` extension.
- **Merge conflict resolution UI** — If `git apply` fails, the operator is told which files
  conflict and must resolve manually. An in-browser merge tool is out of scope.
- **Cross-run diffing** — Comparing artifacts between two runs is a separate feature.
- **Artifact browsing UI** — A file browser for `runs/<runId>/artifacts/` is useful but
  orthogonal to the apply flow.

---

## 9. Test Coverage

New tests needed:
- `generateRunDiff()` — known seed + artifacts → expected patch content and stats
- `generateRunDiff()` — new file (not in seed) appears as added
- `generateRunDiff()` — empty writtenFiles → no diff generated
- `generateRunDiff()` — no seedDir → returns null
- `GET /api/runs/:id/diff` — returns patch + stats for a run with diff
- `GET /api/runs/:id/diff` — 404 for run without diff
- `POST /api/runs/:id/apply` — clean apply updates DB columns
- `POST /api/runs/:id/apply` — already applied returns 400
- `POST /api/runs/:id/apply` — conflicting patch returns 409

---

## 10. Security Considerations

- **Path traversal**: The apply endpoint must validate that the resolved seedDir is within an
  expected project directory. A malicious artifact with `../../etc/passwd` paths must not be
  applied outside the project boundary.
- **Destructive writes**: `git apply` only modifies files within the git working tree. It will
  refuse to write outside the repo. This is a natural safety boundary.
- **Stale applies**: If the local codebase has diverged significantly from when the run was
  seeded, `git apply` will fail with conflicts rather than silently overwriting. This is the
  desired behavior.
