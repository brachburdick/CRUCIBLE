#!/bin/bash
# PreToolUse hook: Fix common Node.js/TypeScript command mistakes
# - Rewrite `node` to `npx tsx` for .ts files
# - Inject node_modules/.bin to PATH when running project scripts

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ "$TOOL" != "Bash" ] || [ -z "$COMMAND" ]; then
  exit 0
fi

UPDATED="$COMMAND"

# If running a .ts file directly with node, use npx tsx instead
if echo "$UPDATED" | grep -qE 'node\s+\S+\.ts'; then
  UPDATED=$(echo "$UPDATED" | sed -E 's/node(\s+\S+\.ts)/npx tsx\1/g')
fi

if [ "$UPDATED" != "$COMMAND" ]; then
  echo '{"updatedInput": {"command": "'"$(echo "$UPDATED" | sed 's/"/\\"/g')"'"}}'
fi
