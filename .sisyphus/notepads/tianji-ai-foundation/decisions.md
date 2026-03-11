# Decisions - Tianji-ai-foundation

## Learnings

### 2025-03-10

1. **V8 captureStackTrace**: biome-ignore format: Must to be on its own line, Use `// biome-ignore lint/complexity/noBannedTypes: <reason>` to suppress the lint error for V8 API requires `Function` type.

2. **fromPlainObject() switch**: All 7 cases must exhaustive. Each case has exactly one return statement, no unreachable code after any case.
3. **contracts package zero dependency**: The contracts package MUST remains zero-dependency by design. It is verified by a `Function` type guard for TypeScript `isTianjiError`/`isTianjiError` pattern.
4. **Error serialization**: All errors implement `toPlainObject()` method for which returns a plain object with category, code, message, and optional cause chain. This is essential for cross-boundary communication ( especially to workers or message queues.

5. **Type-only exports**: Use `export type { ... } for type exports, keep types clean and separate from value exports.
