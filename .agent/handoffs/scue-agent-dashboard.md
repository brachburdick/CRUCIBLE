# Handoff: Agent Dashboard Features from SCUE

**From:** SCUE agent (2026-03-27)
**To:** CRUCIBLE agent
**Context:** These features were built for SCUE's frontend but belong in CRUCIBLE. Code was written, tested, and verified working — then removed from SCUE. Port the concepts below into CRUCIBLE's existing UI using CRUCIBLE's patterns (useFetch, useWebSocket, Tailwind warm palette).

---

## Feature 1: Token Metrics Bars (Session-Level)

**What:** Horizontal progress bars showing token consumption and context usage for Claude Code sessions. CRUCIBLE already has `TokenProgressBar` for individual runs — this is the **session-level** equivalent reading from conversation transcripts.

**Data source:** Claude Code stores conversation transcripts at:
```
~/.claude/projects/<project-slug>/*.jsonl
```
Each JSONL file = one session. Assistant messages contain `message.usage` with:
- `input_tokens`, `output_tokens`
- `cache_read_input_tokens`, `cache_creation_input_tokens`

**Backend endpoint needed:** `GET /api/sessions?project=SCUE&limit=20`

**Parsing logic** (tested, working):
```python
def _parse_session(path):
    # Read JSONL, deduplicate assistant turns by requestId (keep highest output_tokens)
    # For each assistant entry: extract usage.input_tokens, output_tokens,
    #   cache_read_input_tokens, cache_creation_input_tokens
    # total_context = input + cache_read + cache_create
    # peak_context_pct = peak_context / 200_000 (default context size)
    # Title = first user message content (max 60 chars, strip @/ file refs)
```

Full working implementation was in `scue/api/agent.py` — the `_parse_session()` and `_extract_title()` functions. Also reference `THE_FACTORY/scripts/token-dashboard.py` which has the complete parsing with streaming deduplication.

**Response shape:**
```typescript
interface SessionSummary {
  session_id: string
  title: string
  first_timestamp: string
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read: number
  total_cache_creation: number
  peak_context: number
  peak_context_pct: number  // 0.0-1.0
  turn_count: number
}
```

**UI design:**
- Current session: prominent section with 5 horizontal bars (input, output, context %, cache read, cache create)
- Color thresholds: green < 50%, yellow 50-80%, red > 80% (for context bar)
- Token bars: blue, scaled to session's own max
- Recent sessions: collapsible list, each row = title + turn count + compact context bar + total tokens
- Fits naturally in CRUCIBLE's Session page as a new tab or section

---

## Feature 2: Faux Terminal

**What:** Claude Code-styled terminal panel showing agent output. Monospace font, black background, colored text, macOS-style title bar dots.

**Design:**
- Title bar: red/yellow/green dots + "agent — crucible" label
- Log entries: timestamp (gray) + source badge (colored) + message (green/yellow/red by severity)
- Auto-scroll with user-scroll-detection (pause auto-scroll when user scrolls up)
- Disabled input field at bottom: `$ agent messaging coming soon...`
- Future: bidirectional message exchange with agents

**Data source:** In CRUCIBLE context, this should show the `EventFeed` data styled as a terminal instead of (or alongside) the current event list. Run events (run_started, token_warning, loop_warning, agent_completed, kill) map naturally to terminal lines.

**Auto-scroll pattern:**
```typescript
const scrollRef = useRef<HTMLDivElement>(null);
const isAtBottomRef = useRef(true);

function handleScroll() {
  const el = scrollRef.current;
  if (!el) return;
  isAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
}

useEffect(() => {
  const el = scrollRef.current;
  if (el && isAtBottomRef.current) el.scrollTop = el.scrollHeight;
}, [entries.length]);
```

---

## Feature 3: Git Commit Button

**What:** Simple button with git-branch SVG icon, fires a toast on click ("Git commit — coming soon"). Placeholder for future wiring to a backend endpoint that runs `git commit`.

**Future endpoint:** `POST /api/git/commit` with body `{ message: string, files?: string[] }`

---

## Feature 4: Task Claim via UI

**What:** "Start Task" button in task detail view that sets a task's status to `in_progress` in tasks.jsonl.

**Endpoint:** `POST /api/projects/tasks/:taskId/claim`

**Implementation:** Read tasks.jsonl line by line, find matching ID, rewrite with `status: "in_progress"`, write back. Return the updated task.

**Note:** CRUCIBLE's Projects page already shows tasks — this just adds the claim action. The "Run →" button on Projects already launches an agent run, so "Start Task" might integrate with that flow rather than being standalone.

---

## Integration Notes

- CRUCIBLE uses `useFetch<T>` not TanStack Query — follow that pattern
- CRUCIBLE uses warm Tailwind palette (espresso/sepia, orange accents) not SCUE's cool grays
- The terminal should use CRUCIBLE's `--crucible-bg-deep` (#13100c) instead of pure black
- Session metrics could be a new tab on the existing Session page
- The terminal could be an alternative view mode on RunDetail's EventFeed
