# Plan: Phase 8A — Artifact Apply

## Summary
Add diff generation at run teardown, a diff viewer + apply button to Run Detail, and API endpoints to apply agent changes back to the local codebase.

## Approach
Diff-first, apply-on-demand. Every completed run with a seedDir gets a `diff.patch` file generated automatically. The operator reviews the diff in the UI, then chooses to apply (or not). Three apply modes: working-tree (default), branch, commit.

## Key Design Choice
Use `writtenFiles` from CLI stream parsing to scope the diff to only files the agent actually modified — avoids noise from full sandbox snapshots. The diff is generated once at teardown and stored as `runs/<runId>/diff.patch`.

## Implementation Steps

### Step 1: Diff generation (backend)
- Create `src/engine/diff.ts` with `generateRunDiff()`
- Wire into all three RunEngine teardown paths (CLI, Docker-CLI, E2B)
- Extend `RunResult` with optional `diff` field
- Tests for diff generation

### Step 2: API endpoints
- Create `src/server/routes/artifacts.ts`
- `GET /api/runs/:id/diff` — return patch + stats
- `POST /api/runs/:id/apply` — git apply to seedDir
- DB migration: `applied_at`, `applied_mode` columns
- Tests for apply flow

### Step 3: Run Detail UI
- `DiffSummary` component (file list + per-file stats)
- `DiffViewer` component (expandable diff with line coloring)
- `ApplyButton` with mode dropdown
- Wire into RunDetail.tsx between Result and Events sections
- Applied badge on Dashboard

### Step 4: Verify
- Build + test pass
- End-to-end: launch run → view diff → apply → verify local changes

## Full Spec
`specs/phase-8a-artifact-apply-spec.md`
