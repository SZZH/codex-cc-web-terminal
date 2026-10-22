# Contract Testing Strategy

Last updated: 2026-10-16
Status: deprecated
Owner: maintainers

Superseded by: [Codex V2 聊天契约](codex-chat-v2.md)

> 本旧规划已被替代（superseded），保留用于历史和兼容层参考。Codex 当前主链路采用官方 typed 历史、独立持久回执与稳定线程 WebSocket；本文的旧 canonical/snapshot/SSE 设计不再作为 V2 实施依据。

## Goal

在前后端不共享代码目录的前提下，确保双方对同一份会话契约保持一致。

## Scope

本文件覆盖：

- 契约测试原则
- JSON 样本管理方式
- 前后端各自需要验证的内容

## Core Principle

共享的是契约文档和 JSON 样本，不共享实现代码。

## Source Of Truth

单一真相源为：

- `docs/refactoring/canonical-event-schema.md`
- `docs/refactoring/thread-snapshot-schema.md`
- `docs/refactoring/provider-adapter-contract.md`
- `docs/refactoring/turn-state-machine.md`

## Canonical Samples

建议维护一个文档配套样本目录：

- `docs/refactoring/examples/events/`
- `docs/refactoring/examples/snapshots/`

样本内容：

- `turn.started.json`
- `message.delta.json`
- `message.completed.json`
- `tool.started.json`
- `tool.completed.json`
- `artifact.created.json`
- `thread.snapshot.json`
- `history-with-live-overlay.json`

## Backend Contract Tests

后端至少验证：

- provider raw event -> canonical event 映射
- canonical event -> snapshot 投影
- snapshot 输出字段与样本一致
- completed turn 不可再修改
- `POST /api/sessions/:id/input-stream` 在 session 级路由下输出 thread 级语义：
  - 流中所有 `threadId` 必须来自 `resumeSessionId`
  - 不允许把 `sessionId` 当成 `threadId`
  - 同一请求里的 `resize` / `input` 顺序不能丢
- typed SSE transport contract：
  - `payload.type` 必须映射到 `event:`
  - `version` / `toVersion` / `seq` / `timestamp` 的优先级必须稳定映射到 `id:`
  - `data:` 必须始终是完整 JSON，不允许裸文本帧混进主链
- 主链关闭条件：
  - 已追踪 turn 收到 terminal payload 后 SSE 应自动收口
  - 未追踪 turn 的 terminal payload 不能误关别的流

## Frontend Contract Tests

前端至少验证：

- SSE event parser 能解析标准样本
- snapshot parser 能读取标准样本
- UI store 对相同样本的状态结果与预期一致
- 当前页与新标签页基于同一 snapshot 呈现一致
- `requestSessionInputStream` 必须按 typed SSE 解析：
  - 事件名来自 `event:`
  - payload 类型来自 JSON 内的 `type`
  - 不能退化成按旧 WS message shape 猜类型
- SSE 作为主入口时，旧 WS 只能保留最小兼容职责：
  - 当前页不允许让旧 WS 重新主导消息渲染
  - 新标签页至少要保证主路径不会回挂到旧 WS 流式正文
  - 如果短期做不到跨标签完全一致，也要先用回归测试卡住“非 `session_updated` 的旧 WS 事件不得覆盖 SSE 主链”

## Drift Detection

协议改动顺序必须是：

1. 先改文档
2. 再改样本
3. 再改后端实现与测试
4. 再改前端实现与测试

禁止：

- 先改某一端实现
- 再回头补文档

## Review Checklist

- 本次改动是否影响 canonical event？
- 是否影响 snapshot 字段？
- 是否影响 completed turn 的不可变性？
- 是否需要新增样本？
- 前后端两边的契约测试是否都更新了？
- 是否影响 `POST /input-stream` 的 threadId 语义？
- 是否影响 typed SSE 的 `event/id/data` 规则？
- 是否重新引入了“旧 WS 与新 SSE 同时写主 store”？

## Risks / Maintenance Notes

- 如果没有固定样本，前后端会逐渐对“同名字段”的含义产生漂移
- 如果只有一边跑契约测试，另一边最终还是会长出自己的解释
