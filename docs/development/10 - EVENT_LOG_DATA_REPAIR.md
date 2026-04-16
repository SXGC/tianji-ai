# Event Log Data Repair

## 目的

这是一份一次性数据修复手册，用来清理历史上被 node 侧 runner / ACP adapter 手工伪造的 `Run` envelope 脏数据。

不要把这里的 SQL 写进生产代码。

正确顺序是：

1. 先升级代码，确保新的 node 版本已经只产出 `DomainEvent`，并由 runtime pipeline 统一生成 envelope。
2. 再备份数据库。
3. 再做只读排查。
4. 确认命中范围后再删除。
5. 删除后再次验证。

## 问题特征

下面这类记录属于本次修复目标：

- `event_id` 以 `inproc_` / `acp_` / `runner_` 开头
- `aggregate_type = 'Run'`
- `sequence = 0`

这类数据不是 runtime pipeline 生成的合法 envelope，通常会污染 `event_log`，并可能触发 Run 聚合的 sequence 冲突。

## 清理前准备

### 1. 确认代码已经升级

至少要确认以下条件已经满足：

- runner / ACP adapter 只返回 `DomainEvent`
- node runtime pipeline 是唯一的 envelope 生成入口
- 当前测试与检查已经通过

如果代码还没升级，先不要删历史数据。否则旧版本还会继续写回脏数据。

### 2. 先完整备份 `controlplane.db`

在任何删除动作之前，先对 controlplane 使用的 SQLite 数据库做完整备份。

如果你还不确定当前实例用的是哪份数据库，先停下来确认路径，不要猜。

## 只读排查 SQL

先用只读 SQL 看命中范围：

```sql
SELECT event_id, type, occurred_at, sequence, aggregate_id, source_json
FROM event_log
WHERE aggregate_type = 'Run'
  AND sequence = 0
  AND (
    event_id LIKE 'inproc_%' OR
    event_id LIKE 'acp_%' OR
    event_id LIKE 'runner_%'
  )
ORDER BY occurred_at DESC;
```

建议重点看这几列：

- `event_id`：确认是不是伪造前缀
- `type`：确认是不是 Run 相关事件
- `aggregate_id`：确认受影响的 run 范围
- `source_json`：确认来源确实来自 node 侧旧路径

## 删除 SQL

确认备份完成，并且只读结果符合预期后，再执行删除：

```sql
DELETE FROM event_log
WHERE aggregate_type = 'Run'
  AND sequence = 0
  AND (
    event_id LIKE 'inproc_%' OR
    event_id LIKE 'acp_%' OR
    event_id LIKE 'runner_%'
  );
```

## 删除后验证

删除后，重新执行同一条只读排查 SQL，确认结果为空。

然后再做一轮业务验证：

1. 启动最新版本的 controlplane 与 node daemon。
2. 下发一个新 task。
3. 观察新写入的 `event_log`。
4. 确认不再出现下面这些特征：

- `event_id` 以 `inproc_` / `acp_` / `runner_` 开头
- `aggregate_type = 'Run'` 且 `sequence = 0`
- `UNIQUE constraint failed: event_log.aggregate_type, event_log.aggregate_id, event_log.sequence`

## 说明

- 这份文档只处理历史脏数据清理，不改变线上逻辑。
- 如果只读 SQL 查不到命中数据，就不要执行删除 SQL。
- 如果除了本文件列出的模式外，还看到了别的异常数据，先单独分析，不要顺手一起删。
