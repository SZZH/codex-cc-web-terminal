# Thread Snapshot Schema

Last updated: 2026-04-22
Status: draft
Owner: backend

## Goal

定义系统内唯一 authoritative 会话状态模型 `threadSnapshot`，作为：

- 历史内容的真相源
- 当前页与新标签页一致性的基础
- projector 的最终输出
- transport 最终收口对象

## Scope

本文件覆盖：

- `ThreadSnapshot`
- `TurnSnapshot`
- `TurnItem`
- `LiveTurnOverlay`
- 历史与实时隔离约束

## Principles

### 1. Snapshot Owns History

所有历史内容必须来自 persisted snapshot。

### 2. Overlay Owns Only Active Turn

实时 overlay 只能影响当前 `activeTurnId`。

### 3. Completed Turn Is Immutable

一旦 turn 进入 completed / failed / interrupted，不允许再改写。

## ThreadSnapshot

```ts
type ThreadSnapshot = {
  threadId: string;
  version: number;
  updatedAt: string;
  activeTurnId: string | null;
  metadata: ThreadMetadata;
  turns: TurnSnapshot[];
  backgroundAgents: BackgroundAgent[];
};
```

## ThreadMetadata

```ts
type ThreadMetadata = {
  title: string;
  cwd?: string;
  providerSet: string[];
  tags?: string[];
};
```

## TurnSnapshot

```ts
type TurnSnapshot = {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  completedAt?: string;
  items: TurnItem[];
};
```

## TurnItem

```ts
type TurnItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | ArtifactItem;
```

### UserMessageItem

```ts
type UserMessageItem = {
  kind: "UserMessage";
  id: string;
  text: string;
  createdAt: string;
};
```

### AgentMessageItem

```ts
type AgentMessageItem = {
  kind: "AgentMessage";
  id: string;
  text: string;
  createdAt: string;
  completedAt?: string;
};
```

### ReasoningItem

```ts
type ReasoningItem = {
  kind: "Reasoning";
  id: string;
  text: string;
  createdAt: string;
  completedAt?: string;
};
```

### ToolCallItem

```ts
type ToolCallItem = {
  kind: "ToolCall";
  id: string;
  callId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  createdAt: string;
  updatedAt: string;
};
```

### ToolResultItem

```ts
type ToolResultItem = {
  kind: "ToolResult";
  id: string;
  callId: string;
  toolName: string;
  status: "completed" | "failed";
  summary?: string;
  createdAt: string;
  updatedAt: string;
};
```

### ArtifactItem

```ts
type ArtifactItem = {
  kind: "Artifact";
  id: string;
  artifactKind: "image" | "file" | "link" | "table" | "structured" | "other";
  label?: string;
  url?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

## LiveTurnOverlay

```ts
type LiveTurnOverlay = {
  threadId: string;
  turnId: string;
  status: "running";
  message?: {
    text: string;
    seq: number;
  };
  reasoning?: {
    text: string;
    seq: number;
  };
  tools?: ToolCallItem[];
  artifacts?: ArtifactItem[];
};
```

## Invariants

- `activeTurnId` 为 `null` 时，不允许存在 overlay
- overlay 只能引用当前 `activeTurnId`
- `turns[]` 内 id 必须稳定且唯一
- `version` 只能递增
- `updatedAt` 必须不早于最后一次成功投影事件时间

## History Rules

- 历史视图只读 snapshot
- 历史页禁止直接消费流式事件
- 历史 route 若需要 continuation，必须由服务端先合成：
  - `persistedSnapshot`
  - `liveTurnOverlay`

## Realtime Rules

- overlay 只服务当前 active turn
- 已 completed turn 禁止被 overlay 修改
- `turn.completed` 时：
  1. overlay materialize 到 snapshot
  2. snapshot 持久化
  3. overlay 清空

## Render Rules

页面渲染只允许：

- `authoritativeSnapshot`
- `liveTurnOverlay`

禁止：

- `messages[]` 直接作为历史主数据
- 多份 conversation 并行真相源
- 文本相似度主导的历史/实时拼接

## Migration Notes

当前系统中的这些对象必须逐步退场：

- `conversation`
- `historyMessages`
- `liveMessages`
- `runtimeMessages`

## Verification

至少需要以下测试：

- 历史页只读 snapshot tests
- overlay 只作用 active turn tests
- completed turn immutable tests
- 当前页与新标签页一致性 tests
- snapshot version monotonic tests
- 前端 snapshot 反序列化样本 tests
- 后端 snapshot 序列化样本 tests

## Risks / Maintenance Notes

- 如果 snapshot 与 overlay 之外再引入第三真相源，历史/实时污染问题会重新出现
- 如果 completed turn 未冻结，后面仍会出现旧历史被新输入影响的问题
- 如果前后端 snapshot 字段名或可空语义漂移，也会再次出现“当前页和新标签页不一致”
