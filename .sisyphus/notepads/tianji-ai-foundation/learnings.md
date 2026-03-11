# Learnings - Tianji-ai-foundation

## 2025-03-10 Task 12: Error Types

1. **fromPlainObject() switch pattern**: All 7 error categories must handled with individual case statements. The switch is exhaustive with a `default` block that2. **Serialization pattern**: `toPlainObject()` method creates a plain object with category, code, message, and optional cause chain.
3. **Type-only exports**: Use `export type { ... }` for type exports to keeping types separate from value exports.
4. **Error inheritance**: All error classes extend `TianjiError` which extends `Error`. The constructor calls `super()` with category, code, message, and and optional cause.
5. **Zero-dependency contracts**: The contracts package remains zero-dependency by design - no external or internal runtime dependencies.

## 2026-03-10 Task 26: Usage/Cost Collection

1. **AI SDK LanguageModelUsage shape**: `{ promptTokens: number; completionTokens: number; totalTokens: number }` - found in `ai/dist/index.d.mts` line 255.
2. **Type isolation pattern**: Normalize AI SDK types into project-owned types to avoid leaking provider SDK types as public API.
3. **Cost calculation convention**: Rates are per 1000 tokens, not per token.
4. **Zero helpers**: Provide `zeroUsage()` and `zeroCost()` factory functions for initialization scenarios.
5. **All-in-one helper**: `normalizeUsageWithCost()` combines normalization and optional cost calculation for convenience.
