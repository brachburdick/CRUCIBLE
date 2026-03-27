---
status: DRAFT
created: 2026-03-27
project: CRUCIBLE
phase: 6
title: Workbench UI
---

# Phase 6: CRUCIBLE Workbench UI

## 1. Problem Statement

CRUCIBLE's evaluation lifecycle is fully functional but CLI-only. Launching runs, monitoring agent activity, answering async questions, reviewing run records, and browsing session state all require terminal commands and JSON file inspection. This creates friction for the primary workflow: pick a task → watch an agent work → review results → iterate.

### What Success Looks Like

A local browser UI at `localhost:3000` that complements the CLI:
- Browse available tasks, configure a run, launch it
- Watch agent activity live: event stream, token burn, sandbox file changes, check results
- View decomposition graphs as visual node networks (read-only for v1, interactive later)
- Manage session state: answer queued questions, browse run history, inspect state snapshots
- Everything the session model persists is visible and manageable from the UI

### What Already Exists

The `ui/` directory has a working Vite + React + Tailwind SPA with:
- **Dashboard** (`pages/Dashboard.tsx`): Run list table + "New Run" launch form
- **Run Detail** (`pages/RunDetail.tsx`): Event feed + token progress bar + status badge
- **WebSocket streaming** (`hooks/useWebSocket.ts`): Live event subscription per run
- **REST hooks** (`hooks/useApi.ts`): `useFetch` for API calls
- **Components**: `EventFeed`, `LaunchForm`, `RunStatusBadge`, `TokenProgressBar`
- **Backend**: Fastify API with `/api/tasks`, `/api/agents`, `/api/runs`, `/api/ws`, `/metrics`, `/api/health`
- **Database**: SQLite with `runs` and `run_events` tables

This spec extends the existing UI, not replaces it.

---

## 2. Design Principles

1. **Functional wireframe first** — default browser-like Tailwind styling. No custom design system. Ship fast, polish later.
2. **Complement CLI** — UI is for visibility and session management. CLI remains first-class for scripting and power users.
3. **Real-time by default** — WebSocket events update all views live. No manual refresh.
4. **Node graph is read-only for v1** — visual representation of decomposition graphs, click to inspect. No drag/connect/rearrange yet.
5. **Session model is the source of truth** — UI reads/writes the same `.agent/` files the CLI does.

---

## 3. Information Architecture

```
CRUCIBLE Workbench
├── Dashboard (existing, extended)
│   ├── Run list table (existing)
│   ├── Launch form (existing, extended with flow type + session toggle)
│   └── Quick stats bar (new: active runs, total tokens today, last run status)
│
├── Run Detail (existing, extended)
│   ├── Header: status, agent, variant, timing (existing)
│   ├── Panel: Event Stream (existing EventFeed, enhanced)
│   ├── Panel: Token Burn (existing TokenProgressBar, enhanced to chart)
│   ├── Panel: Sandbox Files (new: file tree from artifacts)
│   ├── Panel: Checks Status (new: pass/fail per check with stdout)
│   └── Panel: Flow Phases (new: current phase indicator for session runs)
│
├── Graph View (new page)
│   ├── Visual node graph (read-only)
│   ├── Node detail sidebar (click node → see description, status, metrics)
│   └── Graph-level stats (tokens, wall time, nodes completed/failed)
│
├── Session (new page)
│   ├── Tab: Questions — pending questions with answer form
│   ├── Tab: Run History — run records from .agent/runs.jsonl
│   ├── Tab: State Snapshot — current session knowledge, decisions, dead ends
│   └── Tab: Task Queue — tasks from .agent/tasks.jsonl with status
│
└── Settings (new page, minimal)
    ├── API keys status (E2B, Anthropic, OpenAI — present/missing, not values)
    ├── OTel endpoint config
    └── Default budget/TTL
```

---

## 4. New Backend API Endpoints

The existing Fastify server needs new routes to expose session model data. These read/write the same `.agent/` files the CLI uses.

### Session Routes (`src/server/routes/session.ts` — new file)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/session/snapshot` | Current state snapshot |
| `GET` | `/api/session/tasks` | Task queue (all tasks) |
| `PATCH` | `/api/session/tasks/:id` | Update task status (claim, complete) |
| `GET` | `/api/session/questions` | All questions |
| `GET` | `/api/session/questions?status=pending` | Pending questions only |
| `POST` | `/api/session/questions/:id/answer` | Answer a question `{ answer: string }` |
| `GET` | `/api/session/run-records` | Run record history |
| `GET` | `/api/session/run-records?last=10` | Recent N records |

### Graph Routes (`src/server/routes/graphs.ts` — new file)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/graphs` | List all graphs (from GraphStore) |
| `GET` | `/api/graphs/:id` | Full graph with nodes and edges |
| `GET` | `/api/graphs/:id/nodes/:nodeId` | Single node detail |
| `GET` | `/api/graphs/:id/events` | Graph execution events |

### Config Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config/env-status` | Which API keys are set (boolean, not values) |

---

## 5. New UI Pages & Components

### 5.1 — Graph View Page (`pages/GraphView.tsx`)

**Route:** `/graphs/:id`

**Layout:** Full-width canvas with a node graph on the left (70%) and a detail sidebar on the right (30%).

**Node Graph Panel:**
- Render decomposition graph as a DAG (directed acyclic graph)
- Each node is a box showing: `id`, `description` (truncated), `status` badge
- Edges drawn as lines/arrows between nodes based on `graph.edges`
- Color-code by status: pending=gray, ready=blue, active=yellow, completed=green, failed=red, blocked=orange
- Click a node to select it → detail sidebar shows full info
- Use a simple canvas/SVG layout library (see §7 for options)

**Node Detail Sidebar:**
- Description (full text)
- Acceptance criteria (list)
- Status + execution record (if executed): exit reason, tokens, wall time, mutations, test cycles
- Owned paths
- Inputs/outputs
- Reasoning log

**Graph Stats Header:**
- Total tokens, wall time, nodes completed/failed/pending
- Strategy used, created/updated timestamps

### 5.2 — Session Page (`pages/Session.tsx`)

**Route:** `/session`

**Layout:** Tab bar across the top with four tabs.

**Tab: Questions**
- List of questions from `.agent/questions.jsonl`
- Pending questions highlighted at top with answer form
- Each question shows: task ID, question text, options (radio buttons), default, impact
- Submit button calls `POST /api/session/questions/:id/answer`
- Answered questions shown below in muted style

**Tab: Run History**
- Table of run records from `.agent/runs.jsonl`
- Columns: run ID, date, task ID, task type, result (badge), summary, files touched count, human touches
- Click to expand: full summary, file list, human touch breakdown

**Tab: State Snapshot**
- Current session snapshot displayed as structured panels:
  - **Decisions** — table: timestamp, node, decision, rationale
  - **Key Locations** — table: path, description
  - **Dead Ends** — table: approach, reason
  - **Friction** — mutations since test, total mutations, test cycles, unique files
- Read-only for v1

**Tab: Task Queue**
- Table of tasks from `.agent/tasks.jsonl`
- Columns: ID, description, type, status (badge), priority, risk, blocked by
- Filter by status (pending, in_progress, complete, blocked)
- Click row to see full task detail

### 5.3 — Enhanced Run Detail (`pages/RunDetail.tsx` — extend existing)

**New panels** added below existing event feed:

**Sandbox Files Panel:**
- After run completes, fetch artifact manifest from `GET /api/runs/:id`
- Show file tree with sizes
- Click to download via `GET /api/runs/:id/artifacts/*`

**Checks Panel:**
- Show each check: name, passed/failed badge, stdout/stderr (collapsible)
- Overall pass rate bar

**Flow Phase Indicator:**
- If the run used a flow template (session-aware run), show the phase sequence
- Highlight current/completed phases
- Show which hard rules are active

### 5.4 — Enhanced Dashboard (`pages/Dashboard.tsx` — extend existing)

**Quick Stats Bar** (above run table):
- Active runs count (from `engine.getActiveRunIds()`)
- Total tokens consumed today
- Last run result (badge)
- Session status: questions pending count

**Launch Form Enhancements:**
- Show detected flow type when task is selected
- Toggle: "Session-aware run" (enables mutation guard + flow templates + run records)
- Show available variant YAML files (new API: list `variants/*.yaml`)

### 5.5 — Navigation

Add a sidebar or top nav bar to all pages:
- **Dashboard** (home icon) — `/`
- **Session** — `/session`
- **Graphs** — `/graphs` (lists all graphs, click to view)
- **Settings** — `/settings`

---

## 6. WebSocket Enhancements

The existing WebSocket broadcasts `run:event` messages. Extend to also broadcast:

- **Session events** — when a question is answered, when a task status changes
- **Graph events** — when a node status changes during graph execution

New message types:
```typescript
{ type: 'session_event', event: 'question_answered', data: { questionId, answer } }
{ type: 'session_event', event: 'task_status_changed', data: { taskId, oldStatus, newStatus } }
{ type: 'graph_event', graphId, event: 'node_status_changed', nodeId, data: { oldStatus, newStatus } }
```

---

## 7. Node Graph Rendering

Based on deep research into node-based UI architectures (see `CRUCIBLE_CLAUDE_node_architecture` and `CRUCIBLE_GPT_node_architecture`), here is the informed recommendation.

### Why NOT dagre + raw SVG

The original spec proposed dagre + SVG for v1. Research invalidates this:

1. **dagre cannot do compound/hierarchical graphs.** CRUCIBLE's decomposition graphs ARE hierarchical — `DecompositionNode` has `parentId`, nodes nest inside parent nodes. dagre explicitly does not support sub-flows (confirmed by the xyflow team). This is a dealbreaker.
2. **Building from raw SVG means rebuilding React Flow.** Pan/zoom, hit testing, selection, viewport culling — React Flow solves all of these. Building them from scratch for "simplicity" is a false economy, especially when v2 needs interactivity.
3. **Migration cost.** Starting with raw SVG then migrating to React Flow means rewriting the entire graph renderer. Starting with React Flow means v2 interactive features are incremental additions.

### Recommendation: React Flow + ELK (from v1)

**Stack:**
- `@xyflow/react` (v12.x) — rendering, interaction, state management. 35K+ GitHub stars, 3M+ weekly npm downloads, MIT license.
- `elkjs` — layout computation. Supports compound graphs, hierarchy handling, multiple algorithms. EPL-2.0 license.

**Why ELK over dagre for CRUCIBLE specifically:**
- CRUCIBLE's `DecompositionGraph` has parent-child node hierarchies — ELK's `hierarchyHandling: 'INCLUDE_CHILDREN'` lays out across hierarchy levels in a single pass
- For pure tree decompositions (D0, D4 strategies), ELK's `mrtree` algorithm (Walker II) is purpose-built and faster than Sugiyama
- For DAGs with cross-edges (D5 redecomposition), ELK Layered handles this correctly
- Built-in Web Worker support prevents main-thread blocking as graphs scale

**Performance budget:** CRUCIBLE graphs are typically 1-50 nodes (decomposition depth). React Flow handles this trivially. The research shows SVG maintains 60fps up to ~1,000-2,000 elements. At 50 nodes with ~10 DOM elements each = 500 elements — well within budget.

### v1 Architecture (read-only)

```
DecompositionGraph (from API)
        │
        ▼
  ELK layout (Web Worker)
   ├── mrtree for pure trees
   └── layered for DAGs
        │
        ▼
  React Flow (rendering)
   ├── Custom CrucibleNode component (memoized)
   ├── Status-colored edges
   ├── Click → detail sidebar
   └── Pan/zoom/minimap (free from React Flow)
```

**Custom node component:**
```tsx
const CrucibleNode = memo(({ data }: NodeProps) => {
  const statusColor = STATUS_COLORS[data.status]; // gray/blue/yellow/green/red/orange
  return (
    <div className={`border-2 rounded-lg p-3 ${statusColor}`}>
      <div className="font-mono text-xs text-slate-400">{data.id}</div>
      <div className="text-sm font-medium truncate">{data.description}</div>
      <div className="flex gap-1 mt-1">
        <StatusBadge status={data.status} />
        {data.tokenUsage > 0 && <span className="text-xs">{data.tokenUsage} tokens</span>}
      </div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});
```

**ELK layout integration:**
```tsx
import ELK from 'elkjs/lib/elk.bundled.js';
const elk = new ELK();

async function layoutGraph(graph: DecompositionGraph) {
  const isTree = graph.edges.every(e => e.type === 'dependency'); // no cross-edges
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': isTree ? 'mrtree' : 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '30',
    },
    children: toElkNodes(graph.nodes),  // recursive: nest children under parents
    edges: toElkEdges(graph.edges),
  };
  return elk.layout(elkGraph);
}
```

**Data model mapping** (DecompositionGraph → React Flow):
| CRUCIBLE | React Flow | Notes |
|----------|-----------|-------|
| `DecompositionNode.id` | `Node.id` | Direct mapping |
| `DecompositionNode.parentId` | `Node.parentId` | Enables compound grouping |
| `DecompositionNode.status` | `Node.data.status` | Drives color coding |
| `DependencyEdge` | `Edge` | `source` → `target` with `animated` for active |
| `DecompositionNode.type === 'composite'` | `Node.type = 'group'` | Expandable container |

### v1 Interaction (read-only)
- **Click node** → detail sidebar populates with full node info
- **Pan/zoom** — React Flow built-in
- **Minimap** — React Flow `<MiniMap>` component
- **Fit view** — button calls `reactFlowInstance.fitView()`
- **Status color coding**: pending=slate, ready=blue, active=amber, completed=emerald, failed=red, blocked=orange
- **Animated edges** for currently-active nodes (React Flow `animated: true`)
- **No dragging, no connecting, no creating** — v1 is observation only

### v2 Roadmap (interactive, future)
When interactive editing is needed, React Flow provides the foundation:
- **Searchable node creation palette** — highest-impact feature from TouchDesigner/Blueprints. Right-click → fuzzy search → create node. Implement with `onPaneContextMenu` + `cmdk` search.
- **Drag to rearrange** — React Flow supports this out of the box; just remove `nodesDraggable={false}`
- **Connection creation** — drag from Handle to Handle with type validation via `isValidConnection`
- **Type-colored wires** — color edges by data type (following Blueprints' convention)
- **Collapse-to-subgraph** — replace selected nodes with a group node
- **Undo/redo** — state history stack

### Critical Performance Rules (from research)

These apply even at v1's modest scale — they prevent performance debt:

1. **`React.memo` on CrucibleNode is non-negotiable.** Without it, dragging/selection re-renders ALL nodes. Research shows this is the difference between 10 FPS and 60 FPS at 100 nodes.
2. **Define `nodeTypes` outside the component** (stable reference). Defining inside causes full remount on every render.
3. **Use ELK Web Worker from the start** (`elkjs/lib/elk.bundled.js` or the worker variant). Even though v1 graphs are small, this prevents future regressions.
4. **Level-of-detail rendering** — show simplified nodes when zoomed out. Check `useStore(s => s.transform[2])` for zoom level.
5. **Memoize all callback props** (`useCallback` for `onNodeClick`, etc).

### New Dependencies (ui/package.json)

| Package | Purpose | Size |
|---------|---------|------|
| `@xyflow/react` | Node graph rendering + interaction | ~55 KB gzip |
| `elkjs` | DAG layout with compound graph support | ~300 KB gzip |

Both are widely adopted (React Flow: 3M+/week, elkjs: 1M+/week).

---

## 8. Files to Create

| File | Purpose |
|------|---------|
| `src/server/routes/session.ts` | Session model REST endpoints |
| `src/server/routes/graphs.ts` | Graph store REST endpoints |
| `ui/src/pages/GraphView.tsx` | Visual node graph page |
| `ui/src/pages/Session.tsx` | Session management (questions, run history, snapshot, tasks) |
| `ui/src/pages/Settings.tsx` | Env status + defaults |
| `ui/src/components/NodeGraph.tsx` | SVG node graph renderer |
| `ui/src/components/NodeDetail.tsx` | Node detail sidebar |
| `ui/src/components/QuestionForm.tsx` | Answer pending questions |
| `ui/src/components/ChecksPanel.tsx` | Check results display |
| `ui/src/components/FlowPhaseBar.tsx` | Flow phase progress indicator |
| `ui/src/components/NavBar.tsx` | Global navigation |
| `ui/src/components/StatBar.tsx` | Quick stats bar for dashboard |

## Files to Modify

| File | Change |
|------|--------|
| `src/server/index.ts` | Register new route modules |
| `src/server/serve.ts` | Initialize SessionModel for API routes |
| `ui/src/main.tsx` | Add new routes |
| `ui/src/pages/Dashboard.tsx` | Add stat bar, enhance launch form |
| `ui/src/pages/RunDetail.tsx` | Add checks, sandbox files, flow phase panels |

---

## 9. Implementation Order

```
Phase 6A — Backend routes + navigation:
  1. Session API routes (reads/writes .agent/ files)
  2. Graph API routes (reads GraphStore)
  3. Config/env status route
  4. NavBar component + route registration
  5. Settings page (minimal)

Phase 6B — Session page:
  6. Session page with 4 tabs
  7. Question answer form (POST to API)
  8. Run history table
  9. State snapshot viewer
  10. Task queue table

Phase 6C — Enhanced run detail:
  11. Checks panel
  12. Sandbox files panel
  13. Flow phase bar
  14. Dashboard stat bar + launch form enhancements

Phase 6D — Graph view:
  15. dagre layout integration
  16. SVG node graph renderer
  17. Node detail sidebar
  18. Graph list page
```

Phase 6A-B are highest priority — they give you session management in the browser. Phase 6C enhances existing run monitoring. Phase 6D is the visual node graph.

---

## 10. Non-Goals (v1)

- Interactive node editing (drag, connect, rearrange) — v2
- Searchable node creation palette — v2 (highest-impact interactive feature per research)
- Type-colored wires / connection validation — v2
- Multi-run comparison / side-by-side view — v2
- Elo/Bradley-Terry leaderboard — v2 (after Phase 5B ranking is built)
- Custom design system / animations — later
- Authentication / multi-user — not needed for local dev server
- Mobile responsive — desktop-only for v1

---

## 11. Research References

Architecture decisions in §7 are grounded in two deep research reports:

- **`CRUCIBLE_CLAUDE_node_architecture`** — React Flow + ELK recommended stack, performance benchmarks (SVG 60fps to ~2K elements), memoization as non-negotiable optimization, ELK Web Worker for layout, `mrtree` for tree structures
- **`CRUCIBLE_GPT_node_architecture`** — dagre vs ELK comparison, Sugiyama algorithm phases, SVG vs Canvas tradeoffs, TouchDesigner/Max/Blueprints interaction patterns, React Flow covers ~70% of needed functionality out of the box

Key findings that changed the spec:
1. dagre cannot handle compound/hierarchical graphs → ELK required for CRUCIBLE's decomposition trees
2. React Flow + ELK is the production-validated stack (used by Langflow, Flowise, Rivet AI, Stripe)
3. Starting with raw SVG then migrating to React Flow is a false economy — start with React Flow from v1
4. `React.memo` on custom nodes is the single most impactful performance optimization (10→60 FPS at 100 nodes)
