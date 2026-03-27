# Task Design Guide

Tasks are the test cases that discriminate between pipeline variants. A good task
reveals *structural* differences in how variants approach work, not just speed.

## What Makes a Good Discriminating Task

Tasks should live in the **zone of difficulty** where pipeline structure matters:
- Too easy → both variants pass, no signal (e.g., "fix a typo")
- Too hard → both variants fail, no signal (e.g., "build a compiler")
- Just right → pipeline instructions, methodology, and skills make the difference

## Task Structure

```json
{
  "description": "Short description",
  "instructions": "What the agent should do",
  "files": { "file.py": "initial content" },
  "seedDir": "tasks/my-task/seed/",
  "checks": [
    { "name": "visible: tests pass", "type": "exec", "command": "pytest" },
    { "name": "hidden: no regressions", "type": "exec", "command": "..." }
  ]
}
```

### Files vs SeedDir

- `files`: Inline file contents as key-value pairs. Good for small tasks (<5 files).
- `seedDir`: Path to a directory tree uploaded to the sandbox. Good for realistic repos.
- Use both: `files` override same-path entries from `seedDir`.

### Checks

Each check runs a shell command in the sandbox after the agent finishes.
Pass = exit code matches `expectedExitCode` (default 0).

- **Visible checks**: Correspond to criteria mentioned in the instructions.
  Name them `"visible: ..."`.
- **Hidden checks**: Test things the instructions don't mention (regressions,
  code quality, edge cases). Name them `"hidden: ..."`.

Hidden checks are the key discriminator — they test whether the variant's
methodology prevented unintended side effects.

## Design Principles

1. **Derive from real work.** Extract tasks from actual bugs/features in your
   projects. Synthetic tasks miss the texture of real codebases.

2. **Keep seed repos small.** Under 10 files. The agent needs to explore, but
   shouldn't spend most of its budget on file listing.

3. **Target 1–5 minute completion.** Longer tasks waste budget on both variants.
   Shorter tasks don't give the methodology time to matter.

4. **Include at least one hidden check.** Without hidden checks, you're only
   measuring "did it follow instructions" — not "did the pipeline prevent mistakes."

5. **Test methodology, not knowledge.** A task that requires knowing a specific
   API is testing the model, not the pipeline. A task where "read first, then edit"
   beats "edit immediately" is testing the pipeline.

## Task Families

Organize tasks by what they test:

| Family | Tests | Example |
|--------|-------|---------|
| Bugfix | Read → diagnose → minimal fix | Off-by-one, missing return |
| Feature | Plan → implement → verify | Add endpoint, new function |
| Refactor | Understand → restructure → test | Extract helper, rename |
| Multi-file | Navigate → coordinate changes | Update interface + all callers |

## Discrimination Score

After running a comparison, each task gets a discrimination score (0.0–1.0):
- **1.0** — One variant passed, the other failed (strong signal)
- **0.5** — Both passed but with very different efficiency
- **0.0** — Both had identical outcomes (task doesn't discriminate)

Over time, retire tasks with consistently low discrimination and add new ones.

## Task Catalog

| Task File | Family | Files | Hidden Checks | What It Tests |
|-----------|--------|-------|---------------|---------------|
| `example-coding.json` | Bugfix | 2 | 2 | Simple off-by-one fix. Baseline — both variants should pass. |
| `bugfix-cross-file-diagnosis.json` | Bugfix | 3 | 4 | Bug in `pricing.py`, symptom in `orders.py`. Tests read-before-write: agent must trace root cause across files, not patch the symptom. |
| `feature-inventory-search.json` | Feature | 2 | 4 | Add search to inventory module. Regression trap: case-sensitive product IDs (`ABC-001` != `abc-001`) must survive a case-insensitive search addition. |
| `refactor-extract-validator.json` | Refactor / Multi-file | 4 | 3 | Extract duplicated email validation from 3 modules into shared helper. Tests coordination: all callers must update, normalization behavior (strip + lowercase) must be preserved, unrelated functions must be untouched. |

## Comparison Findings (2026-03-27)

### Variants tested
- **bare** — No system prompt, uses agent default ("be methodical")
- **factory-lean** — 5 concise rules: read before write, plan before acting, verify before completing, minimal changes, change approach after 2 failures

### Results

| Task | bare | factory-lean | Winner |
|------|------|-------------|--------|
| Cross-file bugfix | budget_exceeded (55k tokens) | completed (5.5k tokens) | **factory-lean** |
| Refactor extract validator | completed (10.6k tokens) | ttl_exceeded (23.8k tokens) | **bare** |
| Feature: inventory search | ttl_exceeded (0 tokens) | completed (1k tokens) | **factory-lean** |

All three tasks achieved discrimination = 1.0.

### Analysis

1. **Structured methodology wins on diagnostic tasks.** The cross-file bugfix is the clearest signal — factory-lean found the root cause in pricing.py in 5.5k tokens, while bare burned 55k tokens (likely patching orders.py repeatedly). The "read before write" rule directly prevents this failure mode.

2. **Bare wins when the task is straightforward writing.** The refactor task has clear instructions and the code to write is predictable. Factory-lean spent tokens on exploration/planning that didn't add value, hitting TTL.

3. **Network reliability affects results.** Several runs show "fetch failed" errors and >1000s wall times. The bare variant on the inventory task recorded 0 tokens (sandbox never started). Retry under stable conditions to get check pass rates.

4. **Check scoring gap.** Checks only run on completed variants (by design — sandbox must be alive). Network errors may also interrupt check execution. Future work: add retry logic or score from artifacts.

### Implications for variant design

- **Simple tasks don't need methodology** — the original finding from Phase 2 holds. The factory-baseline prompt was too verbose; factory-lean is better but still over-indexes on planning for write-heavy tasks.
- **Diagnostic tasks need methodology** — when the fix location isn't obvious, "read first" discipline provides massive token savings (10x on the bugfix).
- **Task-adaptive prompting** may be the next frontier — a variant that adjusts methodology depth based on task signals (number of files, explicit debugging language, etc.).
