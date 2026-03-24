# Eval: middleware-compose-order

## Should: Preserve middleware composition order
- Input: "Add a new middleware that rate-limits API calls"
- Expected: Agent adds the middleware to the compose stack in the correct position (after loop detector, before base LLM call) and explains ordering rationale
- Fail if: Agent inserts middleware without considering compose order or places it after the base LLM call

## Should: Use composeMiddleware for stack assembly
- Input: "Wire up the new rate limiter middleware"
- Expected: Agent uses the existing `composeMiddleware()` function in stack.ts
- Fail if: Agent manually wraps functions or creates a parallel composition mechanism
