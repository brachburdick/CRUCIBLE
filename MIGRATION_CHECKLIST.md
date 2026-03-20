# CRUCIBLE Bootstrap Migration Checklist

Protocol Enforcer bootstrap completed 2026-03-19. Use this checklist to finish project setup.

## Operator Actions Required

### Immediate (Before First Agent Session)
- [ ] Initialize git repo: `cd CRUCIBLE && git init`
- [ ] Create `.gitignore` with: `node_modules/`, `runs/`, `.env`, `dist/`
- [ ] Copy `.env.example` to `.env` and fill in API keys (E2B, Anthropic, Langfuse, OpenAI)
- [ ] Initialize Node project: `npm init -y` and install dependencies (`e2b`, `@langfuse/langfuse`, `openai`, `typescript`)
- [ ] Create `tsconfig.json` with strict mode + NodeNext resolution
- [ ] Create `docs/architecture.md` — layer boundaries and interfaces (Architect session, Phase 4)
- [ ] Create `docs/constraints.md` — non-negotiable rules extracted from bootstrap spec
- [ ] Create `specs/feat-mvp-sandbox/` directory for the MVP feature

### Phase 4: Architecture (Next Step)
- [ ] Run Architect session using `docs/agents/startup-prompts/architect.md`
- [ ] Provide the CRUCIBLE bootstrap spec as the handoff
- [ ] Architect produces: `specs/feat-mvp-sandbox/spec.md`, `plan.md`, `tasks.md`
- [ ] Review spec — resolve all `[DECISION NEEDED]` tags
- [ ] Apply atomization test to every task in the breakdown

### Before First Developer Session
- [ ] Populate skill files with any research findings (E2B SDK patterns, Langfuse integration)
- [ ] Verify hook scripts are executable: `ls -la .claude/hooks/`
- [ ] Run a test Researcher session if E2B SDK or Langfuse patterns are unfamiliar

## What Was Created (Protocol Enforcer Output)

| Category | Count | Location |
|----------|-------|----------|
| Artifact templates | 10 | `templates/` |
| Role preambles | 8 | `preambles/` (COMMON_RULES + 7 roles) |
| Subagent definitions | 6 | `.claude/agents/` |
| Startup prompts | 7 | `docs/agents/startup-prompts/` |
| Skill file skeletons | 3 | `skills/` (e2b-sandbox, langfuse-tracing, typescript-node) |
| Hooks | 2 | `.claude/hooks/` (fix-node-cmd, subagent-stop) |
| Settings | 1 | `.claude/settings.json` |
| Orchestrator state | 1 | `docs/agents/orchestrator-state.md` |
| AGENT_BOOTSTRAP.md | 1 | project root |
| .env.example | 1 | project root |

## Decisions Flagged

- `[DECISION NEEDED]`: **Package manager** — The hook `fix-node-cmd.sh` assumes `npx tsx` for running TypeScript. If using a different runner (e.g., `ts-node`, `bun`), update the hook.
- `[DECISION NEEDED]`: **CLI argument parsing** — Bootstrap spec says "no framework." For CLI args, decide between raw `process.argv` parsing, `commander`, or `yargs`. Architect should decide during Phase 4.

## What the Protocol Enforcer Did NOT Create
- Source code (owned by Developer agents)
- `docs/architecture.md` (owned by Architect)
- `docs/constraints.md` (owned by Architect)
- `docs/decisions.md` (populated during development)
- `docs/glossary.md` (populated as needed)
- Skill file content beyond skeletons (populated from research findings)
