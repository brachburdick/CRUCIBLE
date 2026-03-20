#!/bin/bash
# SubagentStop hook: Verify session summary exists before allowing subagent completion
# This enforces the protocol rule that every session must produce a session summary.

INPUT=$(cat)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // empty')

# Skip check for orchestrator (it writes state snapshots, not session summaries in the same way)
if [ "$AGENT_NAME" = "orchestrator" ]; then
  exit 0
fi

# Check for recent session summary files (modified in the last 10 minutes)
RECENT_SUMMARIES=$(find specs/*/sessions/ -name "session-*-${AGENT_NAME}*.md" -mmin -10 2>/dev/null | head -1)

if [ -z "$RECENT_SUMMARIES" ]; then
  echo '{"decision": "block", "reason": "No session summary found. Every agent session must write a session summary to specs/feat-[name]/sessions/ before completing. Use templates/session-summary.md."}'
  exit 0
fi

exit 0
