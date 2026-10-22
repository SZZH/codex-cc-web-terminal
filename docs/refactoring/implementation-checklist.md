# Refactoring 实施 Checklist

Last updated: 2026-10-16
Status: deprecated
Owner: maintainers

Superseded by: [Codex V2 聊天契约](codex-chat-v2.md)

> 本旧规划已被替代（superseded），保留用于历史和兼容层参考。Codex 当前主链路采用官方 typed 历史、独立持久回执与稳定线程 WebSocket；本文的旧 canonical/snapshot/SSE 设计不再作为 V2 实施依据。

## 样本与文档同步

- 先确认本次改动是否影响 `canonical-event-schema`、`thread-snapshot-schema`、`turn-state-machine` 或 `contract-testing-strategy`。
- 任何字段新增、重命名、可空语义变化，先改文档，再改 `docs/refactoring/examples/**`。
- 样本必须保持同一套 `threadId`、`turnId`、`callId`、`artifactId` 语义，不要每个文件各写一套故事。
- `events/` 下样本统一保留完整 canonical envelope；`snapshots/` 下样本只放 snapshot / overlay 读取对象。
- 提交前至少做一次 JSON 可解析检查，避免文档样本本身失效。

## 后端实施

- adapter 层只输出 canonical event kind，不透出 provider 私有字段名到主协议。
- projector 必须按 `seq` 单调处理同一 `threadId` 的事件，并对重复 `event.id` 做幂等。
- `message.delta` 只更新 live overlay；`message.completed` 或 turn 结束时再 materialize 到 snapshot。
- `tool.started`、`tool.completed`、`artifact.created` 的字段落盘命名必须与样本完全一致。
- `thread.snapshot` 的 `payload.version` 必须与 `payload.snapshot.version` 一致，且旧版本事件要忽略。
- `turn.completed / failed / interrupted` 之后，必须拒绝任何继续修改该 turn 的 mutation event。

## 前端实施

- SSE parser 逐条按 envelope 解析，不要从 `kind` 以外的位置推断事件类型。
- 历史页只读取 `authoritativeSnapshot`；实时页只允许在 `authoritativeSnapshot` 之上叠加 `liveTurnOverlay`。
- `activeTurnId` 为 `null` 时，前端状态里不得残留 overlay。
- `message.delta` 的增量文本与 `message.completed` 的全文要能在 store 中收敛为同一条最终消息。
- 工具状态展示基于 `callId` 归并，不要用文本相似度拼接。
- artifact 展示直接读 `artifactKind`、`label`、`url`、`metadata`，不要再派生第二套前端字段。

## QA 对照点

- 用 `events/` 目录样本验证事件 parser、事件顺序和字段命名。
- 用 `snapshots/thread.snapshot.json` 验证历史页直出是否稳定，刷新后结果是否一致。
- 用 `snapshots/history-with-live-overlay.json` 验证实时页叠加逻辑，确认只影响 `activeTurnId`。
- 验证 turn 完成后 overlay 被清空，且最终 UI 与 `thread.snapshot.json` 一致。
- 验证重复事件不会重复追加文本、工具项或 artifact。
- 验证旧版本 `thread.snapshot` 不会覆盖新版本 snapshot。

## 评审关口

- 如果协议变了但样本没变，本次评审不能过。
- 如果后端或前端只改了一边契约测试，本次评审不能过。
- 如果 completed turn 仍可被后续 delta 改写，本次评审不能过。
