# SonarQube 剩余问题修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 SonarQube 报告中剩余 4 个 OPEN issues（全部 MINOR CODE_SMELL），使 Quality Gate 的 `new_violations = 0` 条件通过。

**Architecture:** 4 个问题分布在 3 个包的 4 个文件中，按文件逐一修复，每个 Task 对应一个文件。修复后运行 `pnpm check` 确保无回归。

**Tech Stack:** TypeScript, React (TSX), Vitest, Biome

---

## Task 1: 提取联合类型为类型别名 — parse.ts (S4323)

**Files:**
- Modify: `apps/node/src/commands/types.ts:45,50`
- Modify: `apps/node/src/commands/parse.ts:143,146,173,202`

**问题:** `string | number | boolean` 联合类型在 `parse.ts` 和 `types.ts` 中重复出现 6 次，SonarQube 要求提取为类型别名。

**注意:** `types.ts:45` 和 `types.ts:50` 已有相同的联合类型，应一并替换，保持一致性。

- [ ] **Step 1: 在 types.ts 中添加类型别名**

在 `apps/node/src/commands/types.ts` 的 `ArgumentDefinition` 接口之前添加：

```typescript
/** CLI 选项值的允许类型。 */
export type OptionValue = string | number | boolean
```

然后将 `types.ts` 中的两处 `string | number | boolean` 替换为 `OptionValue`：

```typescript
// 第 45 行
readonly default?: OptionValue

// 第 50 行
readonly options: Record<string, OptionValue>
```

- [ ] **Step 2: 在 parse.ts 中替换联合类型**

在 `apps/node/src/commands/parse.ts` 顶部的 `import type` 中加入 `OptionValue`：

```typescript
import type {
  // ...existing imports...
  OptionValue,
} from './types.js'
```

替换 4 处 `string | number | boolean`：

```typescript
// 第 143 行
defaults: Record<string, OptionValue>

// 第 146 行
const defaults: Record<string, OptionValue> = {}

// 第 173 行
options: Record<string, OptionValue>,

// 第 202 行
options: Record<string, OptionValue>
```

- [ ] **Step 3: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add apps/node/src/commands/types.ts apps/node/src/commands/parse.ts
git commit -m "refactor(node): 提取 OptionValue 类型别名替代重复联合类型 (S4323)"
```

---

## Task 2: 修复 catch 中的 String(value) 可能输出 [object Object] — deepagents-engine.ts (S6551)

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:778`

**问题:** `stableSerialize` 函数的 catch 块中，`String(value)` 对对象类型会输出 `[object Object]`。此处是 `JSON.stringify` 失败的降级路径，应确保对象也能被正确字符串化。

**分析:** catch 块在 `JSON.stringify(value, ...)` 抛出异常时执行。此时 `value` 可能是任意类型。当前代码 `typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)` 有问题：如果 `JSON.stringify(value, replacer)` 已经失败，不带 replacer 的 `JSON.stringify(value)` 对于简单对象仍可能成功（失败原因可能在 replacer 中），但为安全起见应加 try-catch。

- [ ] **Step 1: 修改 catch 块**

将 `packages/runtime/src/engines/deepagents-engine.ts` 第 777-778 行：

```typescript
  } catch {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  }
```

改为：

```typescript
  } catch {
    if (typeof value !== 'object' || value === null) {
      return String(value)
    }

    try {
      return JSON.stringify(value)
    } catch {
      return '[Unserializable]'
    }
  }
```

- [ ] **Step 2: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "fix(runtime): 修复 stableSerialize catch 中对象字符串化可能输出 [object Object] (S6551)"
```

---

## Task 3: 替换已废弃的 React.FormEvent — chat-composer.tsx (S1874)

**Files:**
- Modify: `apps/controlplane/src/web/components/chat-composer.tsx:1,12`

**问题:** `React.FormEvent` 在 `@types/react@19.2.14` 中已标记为 `@deprecated`，注释说明 "FormEvent doesn't actually exist"。实际上表单提交事件就是 `React.SyntheticEvent`。

**分析:** `@types/react@19` 将 `FormEvent` 标记为 deprecated，因为浏览器 DOM 中不存在名为 `FormEvent` 的原生事件。React 19 推荐直接使用 `React.FormEvent` 的父类型 `React.SyntheticEvent`，或更精确地使用 `React.BaseSyntheticEvent`。但从 `@types/react@19.2.14` 源码看，`FormEvent` 继承自 `SyntheticEvent` 且无额外属性，因此 `React.SyntheticEvent<HTMLFormElement>` 是等价替换。

- [ ] **Step 1: 替换类型**

将 `apps/controlplane/src/web/components/chat-composer.tsx` 第 12 行：

```typescript
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
```

改为：

```typescript
  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
```

- [ ] **Step 2: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add apps/controlplane/src/web/components/chat-composer.tsx
git commit -m "refactor(controlplane): 替换已废弃 React.FormEvent 为 SyntheticEvent (S1874)"
```

---

## Task 4: 移除 toJsonValue 中不可达的对象分支 — sdk-gateway.ts (S6551)

**Files:**
- Modify: `packages/runtime/src/llm/sdk-gateway.ts:176`

**问题:** `toJsonValue` 函数第 176 行 `typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)` 中的对象分支不可达，因为：
- `null` 在第 160 行已处理
- `Array` 在第 168 行已处理
- 其他 `object` 在第 172 行已处理

到达第 176 行的 `value` 只可能是 `undefined`、`symbol`、`bigint`、`function` 这些非 object 类型。但 SonarQube 不做控制流分析，仍然警告 `String(value)` 可能对对象输出 `[object Object]`。

**修复:** 移除不可达的对象分支，直接 `return String(value)`。

- [ ] **Step 1: 简化返回语句**

将 `packages/runtime/src/llm/sdk-gateway.ts` 第 176 行：

```typescript
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
```

改为：

```typescript
  return String(value)
```

- [ ] **Step 2: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add packages/runtime/src/llm/sdk-gateway.ts
git commit -m "refactor(runtime): 移除 toJsonValue 中不可达的对象分支 (S6551)"
```

---

## 验证

完成全部 4 个 Task 后，触发 SonarQube 重新扫描，确认：
- `new_violations = 0`
- 所有 4 个 OPEN issue 变为 CLOSED
- Quality Gate 的 violations 条件变为 OK

注意：Quality Gate 整体仍可能为 ERROR，因为 `new_coverage` (67.6% < 80%) 需要额外补充测试才能通过，不在本次修复范围内。
