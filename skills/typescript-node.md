# Skill: TypeScript + Node.js Conventions

## When This Applies
All CRUCIBLE source code.

## Stack / Environment
- TypeScript strict mode
- NodeNext module resolution
- No framework (no Express, no NestJS) — library + CLI only
- All async, no sync LLM calls

## Common Patterns
[TODO: Fill from project experience]
- Structured error types extending base Error classes (BudgetExceededError, LoopDetectedError)
- Composable middleware pattern (wrapping LLM call functions)
- CLI using minimal tooling (process.argv parsing or lightweight CLI lib)
- Structured JSON logging for kill events

## Known Gotchas
[TODO: Fill from project experience]
- NodeNext requires explicit `.js` extensions in imports even for `.ts` files
- `tsconfig.json` must have `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`
- Strict mode catches more issues but requires explicit null handling everywhere

## Anti-Patterns
- Sync LLM calls — blocks the event loop, breaks timeout enforcement
- Using a web framework for what is a library + CLI
- Implicit `any` types — strict mode will reject these
- Relative imports without file extensions under NodeNext
