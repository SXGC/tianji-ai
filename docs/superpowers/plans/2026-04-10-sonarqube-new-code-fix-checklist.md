# SonarQube New Code 修复清单

**Date:** 2026-04-10
**Scope:** 只处理 SonarQube `new code` 问题
**Project:** `tianji-ai`
**Quality Gate:** `ERROR`

## 目标

让 `new code` 质量门通过，要求同时满足：

| 条件 | 当前值 | 目标 |
| --- | --- | --- |
| `new_violations` | `30` | `0` |
| `new_coverage` | `79.7%` | `>= 80%` |
| `new_security_hotspots_reviewed` | `0%` | `100%` |
| `new_duplicated_lines_density` | `0.26253%` | `<= 3%` |

## 当前问题概览

| 维度 | 数量 |
| --- | --- |
| `CRITICAL` | `4` |
| `MAJOR` | `1` |
| `MINOR` | `25` |
| `BUG` | `0` |
| `VULNERABILITY` | `0` |
| `CODE_SMELL` | `30` |

## 修复顺序

1. 先清 `CRITICAL`
2. 再清 `MAJOR`
3. 再清批量 `MINOR`
4. 补新代码测试，把 `new_coverage` 拉到 `80%+`
5. 在 Sonar 上 review 新增 `Security Hotspot`
6. 重新扫描，确认质量门变为 `OK`

## 按文件拆分

### P0

| 文件 | 级别分布 | 问题数 | 处理方向 |
| --- | --- | --- | --- |
| `packages/agent/src/orchestration/graph-validator.ts` | `CRITICAL x2` | `2` | 拆函数，压低认知复杂度 |
| `packages/agent/src/orchestration/graph-compiler.ts` | `CRITICAL x1`, `MAJOR x1`, `MINOR x1` | `3` | 拆函数，去掉嵌套模板串，去掉多余断言 |
| `packages/runtime/src/runtime.ts` | `CRITICAL x1`, `MINOR x7` | `8` | 拆函数，顺手清否定条件写法 |

### P1

| 文件 | 级别分布 | 问题数 | 处理方向 |
| --- | --- | --- | --- |
| `packages/runtime/src/llm-call-recorder.ts` | `MINOR x7` | `7` | 合并重复导入，去掉多余断言，替换废弃 API，修正字符串化风险 |
| `packages/agent/src/orchestration/state-channels.ts` | `MINOR x2` | `2` | 清理无意义空对象展开 |
| `packages/runtime/src/engines/deepagents-engine.ts` | `MINOR x2` | `2` | 改写否定条件 |

### P2

| 文件 | 级别分布 | 问题数 | 处理方向 |
| --- | --- | --- | --- |
| `apps/node/src/node-runtime/controlplane-runtime.ts` | `MINOR x1` | `1` | 改写否定条件 |
| `packages/agent/src/orchestration/executors/acp-executor.ts` | `MINOR x1` | `1` | catch 参数改名 |
| `packages/agent/src/orchestration/executors/deepagents-executor.ts` | `MINOR x1` | `1` | catch 参数改名 |
| `packages/agent/src/orchestration/graph-runner.ts` | `MINOR x1` | `1` | 删除多余断言 |
| `packages/agent/src/orchestration/io-mapping.ts` | `MINOR x1` | `1` | `match()` 改为 `RegExp.exec()` |
| `packages/agent/src/tools/fetch-url-tool.ts` | `MINOR x1` | `1` | 删除多余断言 |

## 规则级修复清单

### 1. `typescript:S3776` 认知复杂度过高

**数量:** `4`

**文件:**
- `packages/agent/src/orchestration/graph-validator.ts`
- `packages/agent/src/orchestration/graph-compiler.ts`
- `packages/runtime/src/runtime.ts`

**动作:**
- 拆分长函数，不要继续在原函数里堆 `if/else`
- 提取具名小函数，每个函数只负责一个判断分支
- 把校验、分支选择、报错信息组装拆开
- 避免多层嵌套，优先早返回

**验收:**
- Sonar 不再报 `S3776`
- 拆分后单文件总长度仍需小于 `800` 行
- 相关行为测试通过

### 2. `typescript:S4624` 嵌套模板字符串

**数量:** `1`

**文件:**
- `packages/agent/src/orchestration/graph-compiler.ts`

**动作:**
- 先把内层字符串算出来，再拼外层
- 不要在模板字符串里再塞模板字符串

**验收:**
- Sonar 不再报 `S4624`

### 3. `typescript:S7735` 否定条件不直观

**数量:** `11`

**文件:**
- `apps/node/src/node-runtime/controlplane-runtime.ts`
- `packages/runtime/src/engines/deepagents-engine.ts`
- `packages/runtime/src/runtime.ts`
- `packages/runtime/src/llm-call-recorder.ts`

**动作:**
- 把 `if (!something)` 改写为更直白的正向判断
- 复杂布尔表达式先拆成具名变量
- 多分支逻辑优先用早返回代替双重否定

**验收:**
- Sonar 不再报 `S7735`
- 条件语义不变

### 4. `typescript:S4325` 多余断言

**数量:** `4`

**文件:**
- `packages/agent/src/orchestration/graph-compiler.ts`
- `packages/agent/src/orchestration/graph-runner.ts`
- `packages/agent/src/tools/fetch-url-tool.ts`
- `packages/runtime/src/llm-call-recorder.ts`

**动作:**
- 删除不会改变类型的断言
- 真需要缩窄类型时，改成显式类型守卫

**验收:**
- Sonar 不再报 `S4325`
- TypeScript 类型检查仍通过

### 5. `typescript:S7718` catch 参数命名

**数量:** `2`

**文件:**
- `packages/agent/src/orchestration/executors/acp-executor.ts`
- `packages/agent/src/orchestration/executors/deepagents-executor.ts`

**动作:**
- catch 参数统一改名为 `error_`

**验收:**
- Sonar 不再报 `S7718`

### 6. `typescript:S7744` 无意义空对象

**数量:** `2`

**文件:**
- `packages/agent/src/orchestration/state-channels.ts`

**动作:**
- 删除无意义的 `{}` 展开
- 保留最终对象结构不变

**验收:**
- Sonar 不再报 `S7744`

### 7. `typescript:S3863` 重复导入

**数量:** `2`

**文件:**
- `packages/runtime/src/llm-call-recorder.ts`

**动作:**
- 合并同源导入
- 保持顶部导入，不要引入动态导入

**验收:**
- Sonar 不再报 `S3863`

### 8. `typescript:S1874` 使用废弃 API

**数量:** `2`

**文件:**
- `packages/runtime/src/llm-call-recorder.ts`

**动作:**
- 查当前依赖类型定义，确认 `msg._getType` 的替代 API
- 不要猜测外部 API 类型
- 改成正式、未废弃的公开接口

**验收:**
- Sonar 不再报 `S1874`
- 类型检查通过

### 9. `typescript:S6594` 正则匹配方式

**数量:** `1`

**文件:**
- `packages/agent/src/orchestration/io-mapping.ts`

**动作:**
- `string.match(regexp)` 改为 `regexp.exec(string)`

**验收:**
- Sonar 不再报 `S6594`

### 10. `typescript:S6551` 对象默认字符串化

**数量:** `1`

**文件:**
- `packages/runtime/src/llm-call-recorder.ts`

**动作:**
- 不要直接把对象塞进模板字符串
- 明确取对象字段，或显式格式化为可读字符串

**验收:**
- Sonar 不再报 `S6551`

## 覆盖率补齐

`new_coverage` 现在是 `79.7%`，差 `0.3%`。

处理策略：

1. 优先给 `P0` 文件补测试
2. 测试写在对应包目录执行
3. 先覆盖新增分支，不追求补历史无关路径

建议测试目标：

| 文件 | 补测重点 |
| --- | --- |
| `packages/agent/src/orchestration/graph-validator.ts` | 非法图结构、缺失节点、循环依赖、边引用错误 |
| `packages/agent/src/orchestration/graph-compiler.ts` | 编译成功路径、分支节点、错误输入、字符串组装结果 |
| `packages/runtime/src/runtime.ts` | 关键分支路由、异常路径、早返回分支 |

## Security Hotspot

当前有 `1` 个新增 `Security Hotspot`，但 API 权限不足，暂时拿不到具体明细。

动作：

1. 在 Sonar Web UI 打开项目 `tianji-ai`
2. 进入 `Security Hotspots`
3. 过滤 `new code`
4. review 这 1 条热点
5. 按实际情况标记为 `Safe` 或继续修复

**注意:** 这一步不做，质量门不会过。

## 执行清单

- [ ] 修 `packages/agent/src/orchestration/graph-validator.ts`
- [ ] 修 `packages/agent/src/orchestration/graph-compiler.ts`
- [ ] 修 `packages/runtime/src/runtime.ts`
- [ ] 修 `packages/runtime/src/llm-call-recorder.ts`
- [ ] 修其余 `MINOR` 问题
- [ ] 补 `new code` 测试，覆盖率拉到 `80%+`
- [ ] 在 Sonar 上 review 新增热点
- [ ] 执行 `pnpm check`
- [ ] 重新触发 Sonar 扫描
- [ ] 确认 `Quality Gate = OK`

## 完成标准

只有同时满足下面 4 条，任务才算结束：

1. `new_violations = 0`
2. `new_coverage >= 80%`
3. `new_security_hotspots_reviewed = 100%`
4. `Quality Gate = OK`
