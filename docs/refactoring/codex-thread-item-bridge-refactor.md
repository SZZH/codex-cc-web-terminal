# Codex Thread / Turn / Item Bridge Refactor

Last updated: 2026-10-16
Status: deprecated
Owner: backend

Superseded by: [Codex V2 聊天契约](codex-chat-v2.md)

> 本旧规划已被替代（superseded），保留用于历史和兼容层参考。Codex 当前主链路采用官方 typed 历史、独立持久回执与稳定线程 WebSocket；本文的旧 canonical/snapshot/SSE 设计不再作为 V2 实施依据。

## Background

当前 `codex-cc-web-terminal` 的会话事实在三个层级并存：

- 后端 live memory state
- 历史 jsonl 解析结果
- 前端 timeline 归并结果

这导致同一个 thread 在“实时查看”“刷新后重进”“历史列表重开”三个入口下可能出现不同的展示结果。

在进一步分析真实 Codex session 数据与官方 `openai/codex` 源码后，问题已经可以更精确地表述为：

- 真实 Codex 持久化的是 rollout records，不是最终 UI 结构
- 官方 app-server 会先把 rollout records 归并成 `Turn { items }`
- 官方 TUI 以 `ThreadItem` 为正式展示语义，而不是自由拼接的 timeline 文本流

因此，这次重构不应继续扩展当前自定义 conversation/timeline 体系，而应把桥接应用收敛到与官方 Codex 尽量一致的 thread/turn/item 语义模型。

## Goal

建立一套可长期维护的会话架构，使以下结果同时成立：

- 同一个 thread 的实时视图与历史视图都来自同一套 reducer 输出
- 前端不再拥有“重建事实”的权限
- 后端 live/history 不再通过 richer-content 或文本近似规则争夺真相
- 工具调用、命令执行、文件改动、多代理、reasoning 都成为正式 `ThreadItem`
- 移动端桥接前端与官方 Codex 的语义边界尽量保持一致

## Scope

本方案覆盖：

- conversation/history 的核心事实模型
- 原始 session 数据的持久化与归一化
- turn reducer / thread snapshot / websocket 同步方式
- 前端 turn-item 渲染边界
- 兼容旧历史与运行期异常场景

## Non-goals

本方案不要求：

- 与官方 TUI 的视觉布局完全一致
- 一次性迁移所有旧数据到新格式后立刻删除兼容层
- 在第一阶段就做最细粒度 patch 协议
- 在本阶段直接执行代码实现

## Source Inputs

本方案基于以下输入收敛：

- 真实 Codex session jsonl 抽样统计
- 官方 `openai/codex` 本地源码：
  - `codex-rs/thread-store/src/types.rs`
  - `codex-rs/thread-store/src/local/read_thread.rs`
  - `codex-rs/app-server-protocol/src/protocol/thread_history.rs`
  - `codex-rs/app-server-protocol/src/protocol/v2.rs`
  - `codex-rs/tui/src/app/app_server_adapter.rs`
  - `codex-rs/tui/src/chatwidget/tests/history_replay.rs`
- 当前仓库核心实现：
  - `src/sessionManager.js`
  - `src/sessions/history/*`
  - `web/src/App.vue`
  - `web/src/lib/conversation-timeline.js`

## Current Problems

- 后端同时存在 live memory conversation 和历史解析 conversation，两者在读取时再做仲裁。
- 前端仍以 timeline 文本流为主，并通过 merge/reconcile/dedupe 推断事实。
- 正文、reasoning、工具调用、命令执行、文件改动、多代理状态没有统一的正式 item 语义。
- 历史重放与实时更新没有共享同一个 reducer。
- 实时完成和历史可重读完成之间存在语义窗口。

## Official Codex Semantics We Must Preserve

根据官方源码，以下语义边界应被视为桥接应用的单一真相源：

### 1. Store layer

官方持久化的是 rollout history / stored thread metadata，而不是 UI 直接使用的数据结构。

### 2. Reducer layer

官方通过 `ThreadHistoryBuilder` 将 rollout items 归并为：

- `Turn`
- `Turn.items: ThreadItem[]`

### 3. Render layer

官方 TUI 按 `ThreadItem` 类型分别渲染，而不是把所有内容压成 message timeline。

### 4. Item taxonomy

官方 `ThreadItem` 覆盖以下正式语义：

- `UserMessage`
- `HookPrompt`
- `AgentMessage`
- `Plan`
- `Reasoning`
- `CommandExecution`
- `FileChange`
- `McpToolCall`
- `DynamicToolCall`
- `CollabAgentToolCall`
- `WebSearch`
- `ImageView`
- `ImageGeneration`
- `EnteredReviewMode`
- `ExitedReviewMode`
- `ContextCompaction`

## Target Structure

目标架构如下：

```text
Codex raw session records
  -> RawRecordStore
  -> CanonicalEventNormalizer
  -> ThreadReducer
  -> ThreadSnapshotStore
  -> HTTP / WebSocket thread APIs
  -> Mobile UI turn-item renderers
```

### Layer Responsibilities

#### RawRecordStore

- 原样保存 Codex 原始记录
- 保存顺序、来源、turn_id、thread_id
- 允许将来重新归一化或重放

#### CanonicalEventNormalizer

- 将原始 `response_item` / `event_msg` / `turn_context` 等映射到稳定领域事件
- 不直接负责最终展示结构

#### ThreadReducer

- 输入 canonical events
- 输出 `ThreadSnapshot`
- 规则尽量对齐官方 `ThreadHistoryBuilder`
- history replay 与 live updates 共用同一 reducer

#### ThreadSnapshotStore

- 缓存当前 thread 的 reducer 结果
- 供 HTTP / WebSocket 读取
- 不是事实源，只是读取优化层

#### Mobile UI

- 只渲染 `turns + items`
- 不再基于文本做事实 dedupe / merge / reconcile

## Canonical Data Model

### ThreadSnapshot

```ts
type ThreadSnapshot = {
  threadId: string
  metadata: ThreadMetadata
  turns: Turn[]
  runtime: {
    latestTurnContext?: RuntimeContext | null
  }
  metrics: {
    latestUsage?: UsageMetrics | null
  }
  version: number
  lastEventSeq: number
  updatedAt: string
}
```

### Turn

```ts
type Turn = {
  id: string
  items: ThreadItem[]
  status: "inProgress" | "completed" | "failed" | "aborted"
  error?: TurnError | null
  startedAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
}
```

### ThreadItem

第一版必须与官方 item taxonomy 对齐，不引入自创主语义类型。

## Storage Design

### `raw_thread_records`

保存原始 Codex 记录。

建议字段：

- `id`
- `thread_id`
- `turn_id`
- `source`
- `record_type`
- `record_subtype`
- `raw_json`
- `record_ts`
- `ingested_at`
- `seq`

### `canonical_thread_events`

保存归一化事件。

建议字段：

- `id`
- `thread_id`
- `turn_id`
- `seq`
- `event_type`
- `payload_json`
- `record_source_id`
- `event_ts`
- `created_at`

### `thread_snapshots`

保存当前 reducer 结果。

建议字段：

- `thread_id`
- `snapshot_json`
- `last_event_seq`
- `updated_at`
- `version`

### Optional: `thread_subscribers_state`

用于 websocket 重连与增量投递游标管理。

## Raw Record -> Canonical Event Mapping

### Session / runtime records

- `session_meta`
  - `thread_metadata_initialized`
- `turn_context`
  - `runtime_context_recorded`
- `event_msg.token_count`
  - `usage_metrics_recorded`

### Turn boundaries

- `event_msg.user_message`
  - `turn_started`（必要时）
  - `user_message_recorded`
- `event_msg.task_complete`
  - `turn_completed`
- `event_msg.turn_aborted`
  - `turn_aborted`
- 其他失败类事件
  - `turn_failed`

### Assistant content

- `response_item.message(role=assistant, content=output_text)`
  - `agent_message_recorded`
- `event_msg.agent_message(phase=final_answer)`
  - `agent_message_recorded`，但标记为 fallback source
- `response_item.message(role=assistant, content=input_image / output image-like content)`
  - `image_generation_*` 或 `agent_message_recorded` 的附件扩展，按真实 payload 决定

### Reasoning

- `response_item.reasoning.summary`
  - `reasoning_summary_recorded`
- `response_item.reasoning.content`
  - `reasoning_raw_recorded`
- `event_msg.agent_reasoning`
  - `reasoning_summary_recorded`
- `event_msg.agent_message(phase=commentary)`
  - `reasoning_summary_recorded` 或 `status_commentary_recorded`

### Tools / commands / file changes / agents

- `response_item.function_call(name=exec_command|shell|shell_command)`
  - `command_execution_started`
- matching `function_call_output`
  - `command_execution_completed`

- `response_item.function_call(name=apply_patch)`
  - `file_change_started`
- matching `function_call_output`
  - `file_change_completed`

- `response_item.function_call(name` starts with `mcp__`)`
  - `mcp_tool_call_started`
- matching `function_call_output`
  - `mcp_tool_call_completed`

- `response_item.custom_tool_call`
  - `dynamic_tool_call_started`
- `response_item.custom_tool_call_output`
  - `dynamic_tool_call_completed`

- `spawn_agent` / `wait_agent` / `send_input` / `close_agent`
  - `collab_tool_call_started`
- matching outputs or status notifications
  - `collab_tool_call_completed`

### Review / compaction / images / search

- web search begin/end
  - `web_search_started` / `web_search_completed`
- image view
  - `image_view_recorded`
- image generation begin/end
  - `image_generation_started` / `image_generation_completed`
- context compaction
  - `context_compaction_recorded`
- review mode events
  - `review_mode_entered` / `review_mode_exited`

## Reducer Rules

### 1. Single active turn

同一 thread 任意时刻只能有一个 active turn。

### 2. Explicit boundary first

优先使用显式 turn 边界事件；没有显式边界时，`user_message_recorded` 才作为兜底开启 turn。

### 3. UserMessage stays as an item

不要把用户输入降级成仅仅是 turn 字段；它在 reducer 结果里仍是 `ThreadItem::UserMessage`。

### 4. AgentMessage is the main final content item

`AgentMessage` 是桥接端主正文的正式来源。

### 5. Reasoning accumulates

对齐官方 reducer：

- 相邻 reasoning summary 追加到同一个 item 的 `summary[]`
- reasoning raw content 追加到同一个 item 的 `content[]`

### 6. Begin/end items upsert by id

`CommandExecution`、`FileChange`、`McpToolCall`、`DynamicToolCall`、`CollabAgentToolCall` 必须按稳定 id 做 upsert，而不是 append 两条独立记录。

### 7. Route completions by `turn_id`

即使完成事件晚到，也必须挂回原 turn，而不是当前 active turn。

### 8. Runtime / metrics do not pollute main conversation

`turn_context` 与 `token_count` 进入 snapshot 的 `runtime` / `metrics`，默认不进入主消息渲染。

## Realtime Protocol

第一阶段推荐只提供：

- `thread.snapshot`

在 reducer 结果每次变化后直接广播整份 snapshot。  
这是最稳的方案，便于先验证一致性。

第二阶段如需优化，再补：

- `thread.patch`

patch 必须是 reducer 级别 patch，而不是原始 record patch。

## Frontend Rendering Contract

前端必须从 timeline-first 切换为 turn-first：

- 遍历 `turns`
- 每个 turn 里按 `items` 渲染
- 不再把历史和实时拍平成消息流

### Frontend History Handling Rule

前端默认不处理任何历史记录语义，以下能力必须全部放在后端：

- 原始历史记录解析
- 历史记录与实时记录归一化
- turn 边界判定
- `ThreadItem` 类型归类
- 工具 begin/end 配对归并
- reasoning 累积
- 正文去重
- 多来源 assistant 正文收敛
- 历史重放

前端唯一允许的数据层处理，是当前 active turn 的**实时展示 overlay**：

- 只允许挂载在当前 active turn 上
- 只允许维护一个临时 assistant 可见槽位
- 不得修改已提交历史 snapshot
- 一旦后端新 snapshot 到达，前端必须以前端临时态让位给后端正式态
- 不允许基于文本相似度做历史 dedupe
- 不允许前端自行重建 `turns`

前端状态模型应收敛为：

```ts
type ThreadScreenState = {
  snapshot: ThreadSnapshot
  liveOverlay: ActiveTurnLiveOverlay | null
}
```

其中：

- `snapshot` 是后端唯一正式事实源
- `liveOverlay` 只是当前 active turn 的临时展示层，不属于历史记录本体

### Realtime Visibility And Dedup Guarantees

实时对话必须立即可见，同时最终历史中不能出现重复正文。本方案对此做以下硬约束：

#### 1. Single live assistant slot

同一个 active turn 只能存在一个实时 assistant 正文槽位。

这意味着：

- 同一 turn 的多来源正文更新只能覆盖这个槽位
- 前端不能为同一 turn 追加第二条实时 assistant 正文

#### 2. Single committed assistant message

同一个 turn 最终最多只允许一个主 assistant 正文 item。

除非未来官方 Codex 明确支持同一 turn 的多个独立 assistant message，否则桥接端不应扩展出多主正文结构。

#### 3. Visibility before convergence

只要当前 turn 出现正文候选，就必须先可见。

即：

- fallback 来源先到时，先显示 fallback
- 更高优来源后到时，再收敛替换
- 宁可短暂使用临时态，也不能让正文消失

#### 4. Convergence happens on the backend

多来源正文的正式收敛只能在后端 reducer 完成，前端不得决定：

- 哪个正文来源更权威
- 哪些 assistant 文本应去重
- 哪些段落应并入历史正文

#### 5. Replace-over-append for active turn live text

当前 active turn 的实时正文更新默认采用“覆盖当前 live slot”，而不是“追加一条新消息”。

这样可以保证：

- 实时界面始终只有一条当前 assistant 正文
- 不会因为 fallback / structured message 双源到达而立刻出现重复

#### 6. Turn-id routing is mandatory

所有正文完成事件、工具完成事件、状态完成事件都必须优先按 `turn_id` 路由归属。

禁止按“当前 active turn”做默认归属，除非进入明确标记的 legacy compatibility 分支。

### Assistant Content Convergence Rule

后端必须为 assistant 正文建立正式的双层模型：

```ts
type AssistantTurnState = {
  liveText: string | null
  committedMessages: AgentMessageItem[]
  processItems: ThreadItem[]
  status: TurnStatus
}
```

含义如下：

- `liveText`
  - 当前实时可见正文
  - 允许来自临时来源
  - 不属于最终历史事实
- `committedMessages`
  - 最终进入历史的正式 assistant 正文
  - 只允许唯一主正文
- `processItems`
  - reasoning / command / file change / tool / collab 等正式过程项

收敛规则：

1. 当前 turn 出现正文候选时，先更新 `liveText`
2. 当 turn 达到正式提交条件时，再把正文收敛进 `committedMessages`
3. 收敛后清空 `liveText` 或把它视作已提交正文的临时显示镜像
4. 后续低优先级来源不得再追加第二条主 assistant 正文

### Assistant Source Priority Rule

基于真实 Codex 数据，正文来源优先级定义如下：

1. `response_item.message(role=assistant, output_text)`：
   - 作为主正文来源
2. `event_msg.agent_message(phase=final_answer)`：
   - 作为 fallback 正文来源
3. 其他兼容正文来源：
   - 仅在前两类缺失时作为临时可见来源

约束：

- fallback 来源可以先显示，但不能永久压过主来源
- 主来源后到时，应收敛替换同一 turn 的 live slot，而不是新增正文
- 如果主来源永远缺失，则 fallback 来源可成为最终 committed assistant message

### Realtime Assistant State Machine

为了同时满足“实时正文必须立刻可见”和“最终历史不能重复”，active turn 的 assistant 正文必须遵循固定状态机。

#### Assistant live states

```ts
type AssistantLiveState =
  | "idle"
  | "live_visible_from_fallback"
  | "live_visible_from_primary"
  | "committed"
  | "failed"
  | "aborted"
```

#### State meaning

- `idle`
  - 当前 turn 还没有任何 assistant 正文候选
- `live_visible_from_fallback`
  - 当前可见正文来自 fallback 来源
  - 允许后续被主来源收敛替换
- `live_visible_from_primary`
  - 当前可见正文来自主来源
  - 后续 fallback 不得再新增第二条正文
- `committed`
  - 当前 turn 已生成唯一正式正文
  - `liveText` 已清空或仅作为 committed 内容镜像
- `failed`
  - 当前 turn 失败，但已出现的正文不得因此消失
- `aborted`
  - 当前 turn 中断，但已出现的正文不得因此消失

#### State transitions

1. `idle -> live_visible_from_fallback`
   - 条件：首次收到 fallback 正文来源
   - 动作：更新 `liveText`

2. `idle -> live_visible_from_primary`
   - 条件：首次收到主正文来源
   - 动作：更新 `liveText`

3. `live_visible_from_fallback -> live_visible_from_primary`
   - 条件：后续收到同一 turn 的主正文来源
   - 动作：以主来源收敛替换当前 `liveText`
   - 约束：不得 append 第二条正文

4. `live_visible_from_primary -> live_visible_from_primary`
   - 条件：同一 turn 收到主正文的后续更新
   - 动作：覆盖当前 `liveText`

5. `live_visible_from_fallback -> live_visible_from_fallback`
   - 条件：同一 turn 收到 fallback 正文更新，但主来源尚未到达
   - 动作：覆盖当前 `liveText`

6. `live_visible_from_primary -> committed`
   - 条件：turn 达到正式提交条件
   - 动作：生成唯一 committed assistant message

7. `live_visible_from_fallback -> committed`
   - 条件：turn 达到正式提交条件且主来源始终缺失
   - 动作：将 fallback 正文收敛成唯一 committed assistant message

8. `committed -> committed`
   - 条件：同一 turn 后续再到达低优兼容正文来源
   - 动作：仅允许补 metadata 或忽略，不得再新增第二条正文

9. `live_visible_from_* -> failed`
   - 条件：turn failed
   - 动作：保留已可见正文，标记 turn failed

10. `live_visible_from_* -> aborted`
    - 条件：turn aborted
    - 动作：保留已可见正文，标记 turn aborted

#### Mandatory invariants

实时正文状态机必须长期满足：

1. 同一 active turn 任意时刻最多只有一个 `liveText`
2. 进入 `committed` 后，同一 turn 不得再新增第二条主正文
3. `failed` / `aborted` 不能清空用户已经看见的正文
4. 任何缺少 `turn_id` 的正文候选都不得静默覆盖另一个 turn 的 `liveText`

#### Fallback safety rule

fallback 来源的职责是“保证正文可见”，不是“长期压过主来源”。

因此：

- fallback 可以先显示
- 主来源后到时必须无缝收敛替换
- 如果主来源永远不到，fallback 才能成为 committed 正文

### Primary content uniqueness rule

最终历史层对每个 turn 的正文唯一性要求如下：

- 一个 turn 最终最多只有一个主 `AgentMessage`
- `Plan` 作为独立 primary item 保留，但不能与 `AgentMessage` 形成重复正文
- 后续兼容来源只能更新既有正文的 metadata 或被忽略
- 不允许因为“多来源都合法”而在最终历史里保留两条语义重复正文

### Unknown Item Rendering Rule

前端遇到尚未实现专用 renderer 的 `ThreadItem` 时，禁止直接丢弃。

最低要求：

- 使用通用系统 item 卡片渲染
- 显示 item 类型、状态和摘要
- 保证“数据到了但用户完全看不到”不会发生

建议组件：

- `TurnCard`
- `UserMessageItem`
- `AgentMessageItem`
- `PlanItem`
- `ReasoningItem`
- `CommandExecutionItem`
- `FileChangeItem`
- `McpToolCallItem`
- `DynamicToolCallItem`
- `CollabAgentToolCallItem`
- `WebSearchItem`
- `ImageGenerationItem`
- `ReviewModeItem`
- `ContextCompactionItem`

### UI consistency rule

- 语义与官方保持一致
- 视觉可按移动端重新组织
- 不得改变 item 的归属、状态和合并规则

### Chronological Turn Presentation Contract

移动端桥接前端必须尊重一个更高优先级约束：

**同一 turn 内，正文与执行过程必须按真实产出顺序展示。**

这意味着：

- 不能为了“正文区 / 过程区”视觉整洁而打乱 item 顺序
- 不能把所有过程统一挪到正文之后
- 不能把正文和过程拆成两块完全独立的静态区域

正确目标是：

- 事实层严格保留 `Turn.items` 的 reducer 顺序
- 展示层仅允许对**相邻连续同类 item** 做 segment 包装
- 折叠单位是“连续过程段”，不是“整个 turn 的过程区”

### Chronological rendering rule

前端必须按 `Turn.items` 的真实顺序渲染 turn。

允许的唯一包装性处理是：

- 识别连续相邻的 process item
- 将这些连续 process item 包装成一个可折叠的 `process segment`

禁止：

- 改变 item 先后顺序
- 把正文 item 与它前后的 process item 强行重排成固定上下区块
- 把两个被正文隔开的 process 段重新合并

### Presentation segments

前端可以在不改变事实顺序的前提下，把 turn 投影成展示 segments：

```ts
type TurnSegment =
  | { kind: "user"; items: [UserMessageItem] }
  | { kind: "primary"; items: PrimaryItem[] }
  | { kind: "process"; items: ProcessItem[]; collapsible: boolean; summary?: ProcessSummary }
```

规则：

- `Turn.items` 是事实顺序
- `TurnSegment[]` 只是 UI 包装结果
- `TurnSegment[]` 不能改变 `Turn.items` 的相对顺序

### Primary items

正文样式白名单保持保守：

- `AgentMessage`
- `Plan`

这些 item 仍然在时间线上占据自己的位置，只是使用正文样式渲染。

### Process items

过程样式 item 第一版包括：

- `Reasoning`
- `CommandExecution`
- `FileChange`
- `McpToolCall`
- `DynamicToolCall`
- `CollabAgentToolCall`
- `WebSearch`
- `ImageView`
- `ImageGeneration`
- `EnteredReviewMode`
- `ExitedReviewMode`
- `ContextCompaction`
- 其他未知但已到达前端的 `ThreadItem`

这些 item 仍然在时间线上占据自己的位置，只是使用过程样式渲染。

### Segment collapse rules

折叠是展示行为，不是数据行为。

硬约束：

- snapshot 中的 `Turn.items` 必须完整保留
- reducer 中的 `ThreadItem` 必须完整保留
- 折叠只作用于 `process segment`
- 不允许折叠导致 item 丢失或跨段重排

默认折叠策略：

1. 一个 turn 只有过程、没有正文：
   - 对应的 process segment 默认展开
2. 某个 process segment 后已经出现正文：
   - 该 process segment 默认可折叠
3. turn 已完成：
   - 所有 process segment 默认折叠，但必须保留展开入口

### Segment boundary rule

连续的 process item 才能形成一个 process segment。

例如：

- `Reasoning -> CommandExecution -> FileChange`
  - 可以包装成一个 process segment
- `Reasoning -> AgentMessage -> CommandExecution`
  - 必须包装成三个 segment：
    - process
    - primary
    - process

这条规则保证正文和过程的真实时间关系不会被破坏。

### Late-arriving item stability rule

晚到事件不得改变时间线结构。

规则：

- 晚到的过程 item 只能进入它真实所属位置对应的 process segment
- 晚到的正文更新只能更新它真实所属位置对应的 primary segment
- 如果一个 process segment 已被正文打断，后续过程 item 必须进入新的 process segment
- 不允许因为晚到事件把正文移动到后面
- 不允许因为晚到事件把两个被正文隔开的过程段重新并成一个

### Unknown item fallback rule

未来官方 Codex 可能新增新的 `ThreadItem` 类型。桥接端在尚未实现专用 renderer 前，必须：

- 将未知 item 视为 process-style item
- 保留其在时间线中的真实位置
- 使用通用系统卡片渲染
- 显示类型、状态、摘要

禁止：

- 直接丢弃未知 item
- 把未知 item 默认放进正文样式
- 因为未知 item 而打乱现有 segment 顺序

### Ambiguous item placement rule

某些 item 可能既像结果也像过程，例如：

- `ImageGeneration`
- 部分 tool result
- review mode 输出

第一版保守策略：

- 默认使用 process-style 渲染
- 仍按时间线原位出现
- 只有明确进入正文白名单的 item 才使用正文样式

### Turn visual invariants

前端必须长期保持以下展示不变量：

1. `Turn.items` 的相对顺序永远不变
2. 过程折叠不改变正文与过程的先后关系
3. 正文前的过程与正文后的过程是两个不同 segment，不能跨正文合并
4. 展开/折叠某个 process segment 不影响其他 segment 的顺序和内容
5. 重连、刷新、重进历史后，同一 turn 的 segment 结构保持稳定

## Compatibility Rules

- 必须兼容现有历史 jsonl
- 第一阶段允许保留 legacy importer
- 不允许继续保留前端文本推断逻辑作为主路径
- 新旧链路并存期间，snapshot 结果必须是唯一对外真相

## Legacy Compatibility Strategy

旧历史兼容必须被视为正式工作流，而不是临时补丁。第一阶段允许保留 legacy importer，但兼容边界必须明确。

### Supported legacy cases

- 没有显式 `turn_started` / `turn_completed`
- 只有 `event_msg.user_message`
- 只有 `event_msg.agent_message(final_answer)`
- 只有 `agent_message(commentary)` / `agent_reasoning`
- begin/end 型事件缺少其中一端，但仍能从同 id 推断稳定 item

### Compatibility reconstruction rules

1. 若旧记录缺少显式 turn 边界：
   - 以 `user_message` 作为兜底 turn 起点
2. 若旧记录缺少主正文来源：
   - 允许 `final_answer` 直接成为 committed assistant message
3. 若旧记录只有 commentary / reasoning：
   - 不得伪造正文
   - 只构建 process-style item
4. 若 begin/end 型事件缺少一端：
   - 允许构建降级 item
   - 但必须显式标记状态不完整
5. 若旧记录无法稳定判断归属 turn：
   - 进入兼容降级路径
   - 必须保留诊断日志

### Unsupported perfect-replay cases

以下场景允许只能做到降级展示，不要求完美重建官方语义：

- 原始旧历史缺失关键 turn 归属信息
- 同一轮正文与 commentary 在旧格式中被彻底混淆
- 多代理旧历史缺少稳定 receiver thread 标识
- begin/end 事件严重不配对且无稳定 id

这些场景的要求是：

- 不丢用户可见正文
- 不制造重复正文
- 过程项尽量保留
- 明确走降级路径，而不是伪装成完整官方语义

### Legacy importer responsibility

legacy importer 的职责是：

- 接住旧数据
- 映射为 canonical events
- 给 reducer 提供最保守的可重放输入

legacy importer 的职责不是：

- 在 importer 层直接决定最终 UI
- 用文本启发式长期替代 reducer

## Rollout Gates

本重构必须分阶段切换，并设置明确上线门槛。

### Gate 0: Spec approval

进入实现前必须满足：

- 本方案文档获用户确认
- `.harness` active plan 与 `docs/refactoring` 正式方案一致

### Gate 1: Canonical types and reducer ready

必须完成：

- canonical type definitions
- raw -> canonical mapping
- reducer replay / incremental tests

未通过前：

- 禁止切换历史 API
- 禁止切换前端主渲染路径

### Gate 2: Snapshot-only history cutover

必须完成：

- history API 改为只读 snapshot
- legacy importer 可覆盖旧历史最关键场景

必须通过：

- 历史读取一致性测试
- 旧历史兼容基础测试

未通过前：

- websocket 仍可沿用旧链路
- 前端仍可读旧渲染路径，但不得新增功能依赖旧路径

### Gate 3: Snapshot-only realtime cutover

第一阶段实时链路只允许：

- `thread.snapshot`

不允许在未验证稳定前上线复杂 patch 协议。

必须通过：

- 实时可见性专项测试
- 重连恢复测试
- “无重复正文”专项测试

### Gate 4: Turn-item renderer cutover

前端切到 turn-item 渲染前，必须满足：

- snapshot 结构已稳定
- 未知 item fallback renderer 可用
- chronology segment 规则已验证

必须通过：

- 主要 turn-item render tests
- chronological segment tests
- process collapse tests

### Gate 5: Old path removal

以下条件全部满足后，才能删除旧主路径：

- 历史读取完全来自 snapshot
- 实时显示完全来自 snapshot + active live overlay
- 旧 `conversation-timeline` 不再承担事实语义
- 回归测试全绿

### Blockers that stop rollout

出现以下任一情况，禁止继续切主路径：

- assistant 正文存在“偶发不显示”
- assistant 正文存在“偶发重复”
- 历史重进与实时视图结构不一致
- 晚到事件导致正文 / 过程顺序错乱
- 未知 item 被静默丢弃

## Edge Cases We Must Cover

### Normal chat

- 单轮问答
- 多轮问答
- 多段 assistant 消息
- plan + agent message 混合

### Tool lifecycle

- command 成功 / 失败 / declined
- file change 成功 / 失败
- mcp tool 成功 / 失败
- dynamic tool 成功 / 失败
- begin/end 到达顺序错乱

### Collaboration

- spawn / send / wait / close
- 多 receiver thread
- 部分成功部分失败
- agent 状态多次更新

### Special modes

- review mode
- context compaction
- image generation
- image view
- web search

### Failure / recovery

- turn aborted
- turn failed
- thread rollback
- websocket 重连
- server restart
- reducer 全量重放

### History compatibility

- 旧历史没有显式 turn boundary
- 旧历史只有 final answer
- 同一 turn 同时存在 assistant message 与 final answer fallback
- reasoning 只有 commentary，没有 raw content

### User input richness

- input text
- local image
- remote image
- text elements
- replay 时图片与 text elements 不能丢

## Verification

### Unit tests

- raw -> canonical event mapping tests
- reducer replay tests
- reducer incremental apply tests
- begin/end upsert tests
- reasoning accumulation tests
- duplicate final answer reconciliation tests
- realtime live-slot convergence tests

### Integration tests

- 实时结束后刷新重进，snapshot 一致
- 历史导入后读取，与实时结果一致
- command completion 晚到仍归属原 turn
- collab item 多状态更新保持单 item
- websocket version gap 后 snapshot 恢复一致
- 只有 fallback final answer 到达时，实时正文立即可见
- fallback 先到、主正文后到时，界面始终只有一条 assistant 正文
- 主正文先到、fallback 后到时，不会追加重复正文
- 同一 turn 多次实时更新时，只更新当前 live slot，不新增第二条 assistant 正文
- turn completed 后，`liveText` 正确收敛为唯一 committed assistant message
- websocket 重连后，进行中的 active turn 正文仍可恢复可见
- turn failed / aborted 后，已出现的正文不会被后续兼容事件吞掉

### Snapshot tests

参考官方 chatwidget snapshot 风格，为移动端 turn-item 渲染建立快照测试。

## Phases

1. 定义 canonical types 与 storage schema
2. 实现 raw ingest 与 canonical normalizer
3. 实现 thread reducer 与 snapshot store
4. 切历史 API 到 snapshot
5. 切 websocket 到 thread snapshot
6. 切前端到 turn-item 渲染
7. 删除旧 timeline 推断主路径

## Risks

- 真实历史中存在未完整配对的 begin/end 事件，legacy importer 需要补兼容
- 不同来源的 assistant 文本可能重复，需要基于来源优先级而非纯文本相似度去重
- 前端切换 turn-item 渲染后，移动端信息密度可能突然上升，需要额外做折叠策略
- 一次性重构范围较大，必须严格按阶段切换，不要混做行为改动与结构迁移

## Maintenance Notes

- `ThreadItem` taxonomy 未来如需扩展，应优先对照官方 Codex 新版本协议，不要先在桥接端私自发明长期类型
- raw records 必须长期保留，方便协议升级时重跑 reducer
- 若未来引入更深的官方 app-server v2 接入，本方案应能平滑替换部分桥接层，而无需重写前端展示语义
