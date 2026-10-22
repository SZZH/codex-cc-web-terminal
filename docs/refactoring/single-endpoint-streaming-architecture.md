# Single-Endpoint Streaming Architecture

Last updated: 2026-10-16
Status: deprecated
Owner: backend

Superseded by: [Codex V2 聊天契约](codex-chat-v2.md)

> 本旧规划已被替代（superseded），保留用于历史和兼容层参考。Codex 当前主链路采用官方 typed 历史、独立持久回执与稳定线程 WebSocket；本文的旧 canonical/snapshot/SSE 设计不再作为 V2 实施依据。

## Background

当前会话系统已经暴露出一组同源问题：

- 历史内容与实时 continuation 会互相污染
- 当前标签页与新标签页最终内容不一致
- 回复会出现半截、尾字符、重复拼接、慢慢蹦完等现象
- 前端同时消费 `message_part`、`conversation.delta/snapshot`、`threadSnapshot` 等多条状态链
- 未来还要接入 `codex` 之外的 `claude code`、`cursor`、`opencode` 等智能体，现有架构很难扩展

这些问题说明当前实现缺少两件核心东西：

- provider-neutral 的 canonical event 模型
- 单一 authoritative 状态源

## Goal

将会话链路重构为一套支持多智能体的、长期可维护的单接口流式架构：

- 输入和流式输出通过单个 `POST` 接口完成
- 网络上传输的是类型化事件流
- 系统内部只认 `threadSnapshot` 作为真相源
- 历史内容与实时内容严格隔离
- 前端只渲染 `threadSnapshot + liveTurnOverlay`
- 后续新增 provider、新增输出类型时，不需要重写整条链路

## Scope

本方案覆盖：

- provider 接入边界
- canonical event schema
- `threadSnapshot` / `liveTurnOverlay` 状态模型
- 单接口 SSE 协议
- 历史/实时隔离规则
- 服务端 projector 与聚合器设计
- 前端状态与渲染收敛方案
- 分阶段实施计划

## Non-goals

本方案不覆盖：

- 某一家的 prompt 设计与模型效果优化
- 具体 UI 视觉设计
- provider 商业能力选择
- 多前台 active turn 并发对话
- 多用户协作编辑同一 thread

## Design Principles

### 1. Thread Is Primary, Provider Is Metadata

同一个 thread 内，无论消息来自哪个 provider，最终都进入同一套线程状态模型。

### 2. Snapshot Is The Only Source Of Truth

`threadSnapshot` 是唯一 authoritative state。

以下对象不能再成为并行真相源：

- `conversation`
- `historyMessages`
- `liveMessages`
- `runtimeMessages`
- 页面临时 merge 出来的消息数组

### 3. History Is Snapshot, Realtime Is Overlay

- 历史内容只来自 persisted snapshot
- 实时内容只允许作用当前 `activeTurnId`
- 已完成 turn 永远冻结

### 4. UI Never Projects Raw Events

UI 不直接把网络事件拼成页面状态。  
UI 只消费 projector 已经收敛好的：

- `threadSnapshot`
- `liveTurnOverlay`

### 5. Capability Gaps Are Explicit, Not Implicit

不同 provider 不一定都支持：

- reasoning
- tool lifecycle
- artifact
- interrupt
- background agent

缺失能力必须在 adapter contract 中显式声明，不能让 projector 或 UI 通过“没收到某种事件”去猜。

## System Layers

建议最终收敛为 6 层：

1. Provider Adapter Layer
2. Canonical Event Layer
3. Projector Layer
4. Persistence Layer
5. Transport Layer
6. UI Render Layer

数据流固定为：

`provider raw events -> adapter -> canonical events -> projector -> snapshot/overlay -> transport -> UI`

## Provider Adapter Layer

### Goal

屏蔽不同 provider 的原始协议差异。

### Suggested Modules

- `src/providers/codex/`
- `src/providers/claude-code/`
- `src/providers/cursor/`
- `src/providers/opencode/`

### Adapter Contract

```ts
interface ProviderAdapter {
  providerId: string;
  capabilities: {
    reasoning: boolean;
    tools: boolean;
    artifacts: boolean;
    interrupt: boolean;
  };
  startTurn(input: StartTurnInput): Promise<ProviderTurnHandle>;
  interruptTurn(handle: ProviderTurnHandle): Promise<void>;
  normalizeEvent(raw: unknown): CanonicalEvent[];
}
```

### Adapter Rules

- provider-specific 原始事件必须先进入 adapter
- adapter 只能输出 canonical events
- adapter 不负责 snapshot 生成
- adapter 不负责 UI 逻辑
- adapter 不负责历史读取
- adapter 必须声明 capability gaps
- adapter 必须把 provider 原始 thread/turn id 映射到内部稳定 id

### Provider Registry Rules

建议额外维护 provider registry：

- provider id
- display name
- capability matrix
- protocol version
- adapter implementation path

这样未来新增 provider 时，不需要改核心分发代码。

## Canonical Event Model

### Unified Envelope

```json
{
  "id": "evt_xxx",
  "seq": 101,
  "provider": "codex",
  "providerThreadId": "raw-thread-id",
  "providerTurnId": "raw-turn-id",
  "threadId": "thread_1",
  "turnId": "turn_9",
  "ts": "2026-04-22T10:00:00.000Z",
  "kind": "message.delta",
  "payload": {}
}
```

### Stable Event Kinds

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

### Event Design Rules

- 新 provider 只能映射到 canonical kinds
- 不允许前端直接识别 provider-specific 原始事件
- 每种新事件类型必须定义 projector 规则
- 未识别事件必须可降级为通用事件，而不是导致线程状态损坏

## State Model

### threadSnapshot

```ts
type ThreadSnapshot = {
  threadId: string;
  version: number;
  updatedAt: string;
  activeTurnId: string | null;
  metadata: {
    title: string;
    cwd?: string;
    providerSet: string[];
  };
  turns: TurnSnapshot[];
  backgroundAgents: BackgroundAgent[];
};
```

```ts
type TurnSnapshot = {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  completedAt?: string;
  items: TurnItem[];
};
```

```ts
type TurnItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | ArtifactItem;
```

### liveTurnOverlay

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
  tools?: ToolLiveState[];
  artifacts?: ArtifactItem[];
};
```

### Hard Rules

- 一个 thread 同时只能有一个 active overlay
- overlay 只服务当前 `activeTurnId`
- turn 完成时必须 materialize 到 snapshot，再清空 overlay
- overlay 不允许直接持久化成独立历史结构

### Sequence And Idempotency

必须提前设计：

- `seq` 单调递增
- `event.id` 全局唯一
- projector 对重复事件幂等

否则断线重试或 provider 重发会再次引入重复内容。

## Projector Layer

### Goal

将 canonical events 投影为可持久化、可重放、可渲染的统一状态。

### Input

- canonical events

### Output

- `threadSnapshot`
- `liveTurnOverlay`

### Projector Rules

- `turn.started`
  - 创建 active turn
  - 设定 `activeTurnId`
- `message.delta`
  - 更新 `liveTurnOverlay.message`
- `message.completed`
  - 将聚合后的正文 materialize 到 turn item
- `reasoning.*`
  - 独立进入 reasoning item，不混入正文
- `tool.*`
  - 更新当前 turn 的工具状态
- `artifact.*`
  - 更新当前 turn 的 artifact 列表
- `turn.completed`
  - 将 overlay materialize 到 snapshot
  - 清空 overlay
  - 增加 snapshot version

### Turn State Machine

建议明确状态机：

- `idle`
- `running`
- `completed`
- `failed`
- `interrupted`

只允许以下迁移：

- `idle -> running`
- `running -> completed`
- `running -> failed`
- `running -> interrupted`

禁止：

- `completed -> running`
- `completed -> completed` 的内容改写
- `failed/interrupted -> running`

### Immutable Completed Turn Rule

```text
if event.turnId belongs to completed turn:
  reject mutation
```

这是历史/实时不串的根规则。

## History And Realtime Isolation

### Invariants

1. 历史内容只来自 persisted snapshot
2. 实时 overlay 只能作用当前 active turn
3. 已 completed turn 禁止被后续事件改写
4. history route 与 live route 看到的是同一个 thread 的不同时间视图
5. 历史页禁止直接消费 provider 原始流式事件
6. 历史页默认只展示 persisted snapshot；若需要 continuation，必须由服务端先合成稳定视图

### Rendering Model

- 历史视图：`persistedSnapshot`
- 实时视图：`authoritativeSnapshot + liveTurnOverlay`

### Forbidden Patterns

- 历史与实时分别维护两份 `messages[]`
- UI 直接 merge 两份 `conversationState`
- 通过文本相似度猜同一轮 turn
- turn 完成后继续用流式事件改旧 turn

## Persistence Layer

建议同时持久化：

- canonical event log
- snapshot checkpoints

### Why

- 可以重放
- 可以恢复
- projector 升级后可重建 snapshot
- 不同 provider 统一存储

### Persistence Rules

- `thread.snapshot` 是稳定 checkpoint
- event log 保留完整顺序
- 历史读取默认优先 snapshot
- event log 只作为重建、审计和调试输入

## Transport Layer

### API

`POST /api/sessions/:id/input-stream`

### Main Entry Selection

主入口选型现在固定为：

- 写入和当前轮流式输出：`POST /api/sessions/:id/input-stream`
- 会话外壳和最低限度会话状态同步：旧 `/ws`
- 历史和补拉：`GET /api/sessions/:id/conversation` / thread history 相关接口

这样拆分的原因不是“长期同时维护双主链”，而是分阶段退役：

- SSE 负责本轮 turn 的唯一主渲染链
- WS 只保留 live session 存活感知、`session_updated` 这类轻量兼容信号
- 任何正文流式、snapshot 收口、typed transport 契约都不再以旧 WS 为真相源

评审和回归测试必须明确卡住这一点：同一页面在 `preferInputTransport=true` 期间，不允许旧 WS 非 `session_updated` 事件继续写主 store。

### Why Single Endpoint

采用单接口的前提是：

- 当前交互模型是一问一答型 turn
- 输入与本轮输出天然属于同一个生命周期
- 当前优先目标是状态收敛和体验稳定，而不是长连接复用

如果未来出现强需求：

- 跨标签页复用同一流
- 同一 thread 多前台观察者
- 浏览器断线后继续接上同一轮流

则需要评估是否保留二级订阅接口，但这不影响当前 single-endpoint 作为默认主链路。

### Request

```http
POST /api/sessions/:id/input-stream
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "text": "告诉我最近改过哪些接口",
  "clientRequestId": "uuid-123"
}
```

### Response Headers

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Stream Framing Rules

- 每个事件必须完整输出一个 `event:` + `data:` block
- 每个 block 以空行结尾
- 长文本 payload 必须先 JSON 序列化，不允许直接拼多行裸文本
- `thread.snapshot` 建议始终是完整对象，不做半截 patch
- typed transport 约束固定如下：
  - `payload.type` 映射到 SSE `event:`
  - `version` / `toVersion` / `seq` / `timestamp` 按既定优先级映射到 `id:`
  - `data:` 始终是 JSON object；不要再混入旧 WS 风格的自由形状文本帧
- `threadId` 必须始终表达 thread 语义：
  - `/api/sessions/:id/input-stream` 的 URL 参数仍然是 session id
  - 但流中 payload 的 `threadId` 必须来自该 session 对应的 `resumeSessionId`
  - 禁止把 session id 复用成流式 payload 的 `threadId`

### Response Events

示例：

```text
event: turn.started
data: {"turnId":"turn-123","threadId":"thread-1"}

event: reasoning.delta
data: {"turnId":"turn-123","text":"我先查一下历史记录"}

event: tool.started
data: {"turnId":"turn-123","tool":"search","callId":"tool-1"}

event: tool.completed
data: {"turnId":"turn-123","tool":"search","callId":"tool-1","summary":"命中 3 条历史"}

event: message.delta
data: {"turnId":"turn-123","text":"最近改过的接口是这 3 处：\n","seq":1}

event: message.completed
data: {"turnId":"turn-123","text":"最近改过的接口是这 3 处：\n- 2026-04-19\n- 2026-04-15\n- 2026-04-12"}

event: thread.snapshot
data: {...}

event: turn.completed
data: {"turnId":"turn-123","status":"completed"}
```

### Required Event Ordering

同一 turn 内建议固定顺序：

1. `turn.started`
2. 零到多条 `reasoning.* / tool.* / artifact.* / message.delta`
3. 可选 `message.completed`
4. `thread.snapshot`
5. `turn.completed`

如果顺序不稳定，前端必须进入复杂补偿逻辑，维护性会明显下降。

## Server-Side Aggregation

### Problem To Solve

provider 上游输出可能非常碎：

- 1 个字
- 2 个字
- 半句
- 句尾标点
- 最终 completed

不能原样透传给前端。

### Aggregation Responsibilities

- 聚合正文 delta
- 聚合 reasoning delta
- 保持 tool lifecycle 粒度
- 在合适边界 flush 给前端

### Message Aggregation Rules

满足任一条件时 flush：

- 到达句号/问号/换行
- 达到最小字符阈值
- 超过短时间窗口
- 收到 `message.completed`
- 收到 `turn.completed`

### Important Review Note

聚合器不能只靠“文本长度阈值”工作，还必须考虑：

- CJK 文本一字成句
- 标点延迟到达
- provider 可能重复发送整段当前 draft
- provider 可能只发最终 completed 而不发 delta

否则会重新出现：

- 最后一个字/标点单独蹦出
- 结尾半句迟到
- 全文重复拼接

### Reasoning Aggregation Rules

- reasoning 与正文分开缓冲
- reasoning 不混进 `AgentMessage`
- reasoning 可按段落或时间窗 flush

### Tool Rules

- 工具输出只发摘要和生命周期
- 不把 noisy output 原样刷到正文区

## UI Render Layer

### Final Frontend State

前端只保留：

- `authoritativeSnapshot`
- `liveTurnOverlay`
- `streamStatus`

### Frontend State Guardrails

- 前端不再保留并行可渲染真相源
- `streamStatus` 只表示 transport 生命周期，不代表 turn 完成状态
- UI 中“进行中/已完成”必须来自 turn state，而不是来自流是否仍在传输

### Must Remove From Main Path

- `liveView.messages`
- `liveView.conversation`
- `historyMessages` 主状态
- `runtimeMessages` 主状态
- 多状态 merge 渲染

### Render Rules

- 历史内容永远来自 snapshot
- 当前流式只渲染 `activeTurnId` 上的 overlay
- 一旦收到新的 `thread.snapshot`，优先用 snapshot 收口

## Frontend Call Flow

前端直接使用：

```ts
const response = await fetch(`/api/sessions/${sessionId}/input-stream`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "text/event-stream"
  },
  body: JSON.stringify({
    text,
    clientRequestId
  })
});
```

然后读取 `ReadableStream` 并解析 SSE 事件。

## Migration Plan

### Phase 0: Freeze Contracts

先冻结：

- canonical event schema
- `threadSnapshot` schema
- `liveTurnOverlay` schema
- provider adapter contract
- SSE contract
- 历史/实时隔离规则

产物：

- 本文档
- `docs/refactoring/canonical-event-schema.md`
- `docs/refactoring/thread-snapshot-schema.md`
- `docs/refactoring/provider-adapter-contract.md`
- `docs/refactoring/turn-state-machine.md`
- `docs/refactoring/contract-testing-strategy.md`

### Phase 1: Build Canonical + Projector

目标：

- provider raw event 全部先进入 canonical 层
- 建立统一 projector

改动：

- 后端新增 canonical event 实现目录
- 后端新增 projector 实现目录
- 前端新增本地协议类型定义
- 改 provider runner
- 改 `sessionManager`

验收：

- 任意 provider 事件都能映射成统一 snapshot
- 前后端本地实现均能通过同一份契约样本测试

### Phase 2: Persistence Convergence

目标：

- 历史读取默认基于 snapshot
- event log 仅作为重放与恢复输入

改动：

- `HistoricalSessionService`
- event log 存储
- snapshot checkpoint 存储

### Phase 3: Single Endpoint Streaming

目标：

- 上线 `POST /input-stream`
- 服务端 aggregator 可稳定输出 typed SSE

要求：

- 新接口先以 feature flag 挂载
- 与旧链路并行一段时间
- 输出事件必须打 debug trace，方便对比 old/new 行为

### Phase 4: Frontend Switch

目标：

- 页面切到新接口
- UI 只渲染 snapshot + overlay

要求：

- 单页同一时刻只能启用一条主链路
- 明确禁止旧 WS 与新 SSE 同时更新同一个 store
- 旧 WS 在该阶段的允许范围必须写死：
  - 允许：`session_updated`、连接存活、最低限度兼容元数据
  - 不允许：`message_part`、`response_item`、`event_msg`、`conversation.snapshot` 重新成为正文主来源
- 如果当前页与新标签页还没有完全统一到同一份 snapshot-only 渲染，至少要先保证：
  - 当前页在 input-stream 主链下不会回挂旧 WS
  - 新标签页不会因为旧 WS 残余消息而覆盖已收口的 SSE snapshot

### Phase 5: Remove Legacy Paths

删除：

- 旧 WS 输出主链路
- `message_part` 直渲染
- 前端多状态源拼装
- 旧 `conversation` 主真相源

退役策略分两步：

1. 先把旧 WS 缩到兼容壳层
   - 只保留 `session_updated` 和连接级信号
   - 回归测试持续防止正文事件重新穿透
2. 再删除旧 WS 正文事件与对应 UI 分支
   - 删除前必须确认 typed SSE 已覆盖新建会话、继续历史会话、中断、刷新恢复这几条主路径
   - 删除前必须确认当前页 / 新标签页一致性测试已经稳定，或至少已有明确的主路径保护测试

## Verification

### Backend

- provider adapter contract tests
- canonical event mapping tests
- projector contract tests
- completed turn immutability tests
- history fallback tests
- SSE ordering tests
- provider capability gap tests
- duplicate event idempotency tests
- reconnect / replay safety tests

### Frontend

- snapshot-only 历史渲染
- active overlay rendering
- turn completed 收口
- 当前页与新标签页一致性
- completed turn 不被覆盖

### E2E

必须覆盖：

- 新建会话流式回复
- 历史会话继续对话
- 中途刷新页面
- 新开标签页查看同一 thread
- reasoning/tool/artifact 混合输出
- 多 provider 接入
- 浏览器主动取消请求
- provider 只发 final 不发 delta
- provider 重发整段 draft
- provider 在 turn.completed 后迟到事件

## Risks And Review Notes

### 1. Single POST Streaming Compatibility

风险：
- 某些代理层对 `POST + SSE` 支持不稳定

建议：
- 明确本地与生产环境支持矩阵
- 保留开发期开关与诊断日志
- 在反向代理和 CDN 层验证禁用缓冲

### 2. Provider Event Ambiguity

风险：
- 不同 provider 对 reasoning、tool、final message 的边界定义不同

建议：
- adapter 层必须显式映射，不允许让 projector 猜

### 3. History Migration Incompleteness

风险：
- 老历史数据仍可能依赖旧解析链

建议：
- 迁移期先允许 event log 重建 snapshot
- 历史读取统一先看 snapshot，没有再回放

### 4. Overlay Leakage

风险：
- 如果 overlay 清理时机错了，历史仍可能被实时污染

建议：
- `turn.completed` 后必须同步执行：
  - materialize
  - persist snapshot
  - clear overlay

### 5. Cancellation Semantics

风险：
- 单接口 `POST + SSE` 下，浏览器取消请求、用户主动中断、provider 自己失败，这三种结束原因容易混淆

建议：
- 单独定义：
  - client disconnect
  - user interrupt
  - provider failure
- 它们必须映射到不同 canonical 事件

### 6. Parallel Frontend State During Migration

风险：
- 迁移期同时保留旧状态和新状态，页面可能继续打架

建议：
- 用 feature flag
- 同一页面一次只允许一条主渲染链路生效

### 6. Tool / Artifact Growth

风险：
- 后续新增输出类型时，重新把类型逻辑塞回 UI

建议：
- 新类型必须先扩 canonical schema 和 projector，再扩 renderer

### 7. Snapshot Payload Size

风险：
- `thread.snapshot` 如果始终全量发送，长线程会越来越大

建议：
- P0 阶段先用全量，保证一致性
- P1 阶段再评估 snapshot checkpoint + range/delta 机制
- 但不允许为了省流量重新回到多真相源

## Open Questions Before Implementation

- `POST + SSE` 是否需要支持浏览器取消后 turn 自动中断？
- 单个 thread 是否未来允许并发多个 active turn？
- `thread.snapshot` 是否需要增量版，还是始终发送全量？
- artifact 是否需要独立持久化索引？
- 是否需要为 provider capability 差异暴露最低通用子集？
- 同一 session 是否允许多个观察者同时订阅？
- provider 迟到事件是否要写入审计日志但拒绝投影？

## Final Recommendation

优先顺序建议为：

1. 冻结 schema 与 contract
2. 先做 canonical + projector
3. 再做单接口流式
4. 最后切前端主链路

不要先重写前端。

前端在没有统一 snapshot 真相源之前，继续重写只会制造新的状态分叉。
