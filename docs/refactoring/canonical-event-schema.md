# Canonical Event Schema

Last updated: 2026-04-22
Status: draft
Owner: backend

## Goal

定义多智能体接入后系统内部唯一允许流转的 canonical event 协议，作为：

- provider adapter 输出契约
- projector 输入契约
- transport 输出契约
- 持久化 event log 契约

## Scope

本文件覆盖：

- canonical event 包络字段
- 事件种类与 payload 约束
- 排序、幂等、重放规则
- provider 与 canonical 的边界

## Non-goals

本文件不覆盖：

- 前端组件展示细节
- 具体 provider 原始协议
- snapshot 结构本身

## Schema Principles

### 1. Provider-Neutral

event schema 不能带任何 provider-specific UI 语义。

### 2. Append-Only Facts

canonical event 只表达事实，不表达页面应该怎么渲染。

### 3. Idempotent Replay

同一事件重复应用，不得改变最终状态。

### 4. Ordered Within Thread

同一 `threadId` 内，`seq` 必须单调递增。

## Unified Envelope

```ts
type CanonicalEvent = {
  id: string;
  seq: number;
  provider: string;
  providerThreadId?: string;
  providerTurnId?: string;
  threadId: string;
  turnId?: string | null;
  ts: string;
  kind: CanonicalEventKind;
  payload: Record<string, unknown>;
};
```

## Required Fields

- `id`
  - 全局唯一
  - 用于幂等和去重
- `seq`
  - 同一 `threadId` 内单调递增
- `provider`
  - `codex` / `claude-code` / `cursor` / `opencode` 等
- `threadId`
  - 系统内部稳定 thread id
- `turnId`
  - 属于某一轮 turn 的事件必须填写
- `ts`
  - 事件时间戳，ISO 字符串
- `kind`
  - 统一枚举
- `payload`
  - 类型化数据

## CanonicalEventKind

稳定事件种类：

- `turn.started`
- `turn.completed`
- `turn.failed`
- `turn.interrupted`
- `message.delta`
- `message.completed`
- `reasoning.delta`
- `reasoning.completed`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`
- `artifact.created`
- `artifact.updated`
- `thread.snapshot`

## Event Payloads

### turn.started

```ts
type TurnStartedPayload = {
  clientRequestId?: string;
  inputText?: string;
};
```

### turn.completed

```ts
type TurnCompletedPayload = {
  status: "completed";
};
```

### turn.failed

```ts
type TurnFailedPayload = {
  status: "failed";
  errorCode?: string;
  message?: string;
};
```

### turn.interrupted

```ts
type TurnInterruptedPayload = {
  status: "interrupted";
  reason?: "user_interrupt" | "client_disconnect" | "provider_abort";
};
```

### message.delta

```ts
type MessageDeltaPayload = {
  text: string;
  deltaSeq: number;
  role: "assistant";
};
```

### message.completed

```ts
type MessageCompletedPayload = {
  text: string;
  role: "assistant";
};
```

### reasoning.delta

```ts
type ReasoningDeltaPayload = {
  text: string;
  deltaSeq: number;
};
```

### reasoning.completed

```ts
type ReasoningCompletedPayload = {
  text: string;
};
```

### tool.started

```ts
type ToolStartedPayload = {
  callId: string;
  toolName: string;
  category?: "command" | "mcp" | "dynamic" | "collab" | "other";
  inputSummary?: string;
};
```

### tool.progress

```ts
type ToolProgressPayload = {
  callId: string;
  toolName: string;
  progressText?: string;
};
```

### tool.completed

```ts
type ToolCompletedPayload = {
  callId: string;
  toolName: string;
  status: "completed";
  outputSummary?: string;
};
```

### tool.failed

```ts
type ToolFailedPayload = {
  callId: string;
  toolName: string;
  status: "failed";
  message?: string;
};
```

### artifact.created

```ts
type ArtifactCreatedPayload = {
  artifactId: string;
  artifactKind: "image" | "file" | "link" | "table" | "structured" | "other";
  label?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};
```

### artifact.updated

```ts
type ArtifactUpdatedPayload = {
  artifactId: string;
  metadata?: Record<string, unknown>;
};
```

### thread.snapshot

```ts
type ThreadSnapshotPayload = {
  version: number;
  snapshot: ThreadSnapshot;
};
```

## Ordering Rules

同一 turn 推荐顺序：

1. `turn.started`
2. 零到多条 `reasoning.* / tool.* / artifact.* / message.delta`
3. 可选 `message.completed`
4. `thread.snapshot`
5. `turn.completed | turn.failed | turn.interrupted`

## Idempotency Rules

- 相同 `event.id` 的事件重复进入 projector，必须被忽略
- `thread.snapshot` 若 `version` 小于当前 snapshot version，必须忽略
- 对已完成 turn 的 mutation 事件必须拒绝投影

## Provider Mapping Rules

- adapter 层必须把 provider 原始事件映射到以上枚举
- 不允许新增只属于某一 provider 的临时 event kind
- 若某 provider 无法表达某类能力，应通过 capability matrix 显式声明，而不是省略解释

## Unknown Event Policy

未识别原始事件：

- 不得直接丢弃且无痕
- 应进入 adapter 的调试日志
- 不得污染主状态
- 必要时可映射为 `tool.progress` 或 `artifact.updated` 的降级形式

## Persistence Rules

- event log 按 envelope 原样持久化
- 持久化时不得写入 UI 特有字段
- event log 必须可用于完整重放 projector

## Verification

至少需要以下测试：

- provider adapter mapping tests
- duplicate `event.id` idempotency tests
- out-of-order `seq` rejection tests
- invalid payload schema tests
- completed turn immutability tests
- 前端事件解析样本 tests
- 后端事件序列化样本 tests

## Risks / Maintenance Notes

- 如果后续有人绕过 canonical event，直接从 provider raw event 更新页面，架构会立即退化
- 如果 `kind` 枚举失控，前端将再次开始识别 provider-specific 语义
- `thread.snapshot` 事件必须视为 authoritative，不能与其他半真相源并存
- 前后端即使不共享代码，也必须消费同一批 canonical JSON 样本
