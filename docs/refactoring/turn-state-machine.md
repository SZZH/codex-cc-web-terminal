# Turn State Machine

Last updated: 2026-10-16
Status: deprecated
Owner: backend

Superseded by: [Codex V2 聊天契约](codex-chat-v2.md)

> 本旧规划已被替代（superseded），保留用于历史和兼容层参考。Codex 当前主链路采用官方 typed 历史、独立持久回执与稳定线程 WebSocket；本文的旧 canonical/snapshot/SSE 设计不再作为 V2 实施依据。

## Goal

明确一轮 turn 的合法状态迁移，避免历史内容被回写、实时 overlay 泄漏、完成态被再次改写等问题。

## Scope

本文件覆盖：

- turn 状态枚举
- 合法迁移
- 非法迁移
- 与 snapshot / overlay 的关系

## Turn States

- `idle`
- `running`
- `completed`
- `failed`
- `interrupted`

## Canonical State Flow

```text
idle -> running -> completed
idle -> running -> failed
idle -> running -> interrupted
```

## Legal Transitions

- `idle -> running`
- `running -> completed`
- `running -> failed`
- `running -> interrupted`

## Illegal Transitions

- `completed -> running`
- `completed -> completed` with mutation
- `failed -> running`
- `interrupted -> running`
- `failed/interrupted -> completed`

## Overlay Relationship

- `running`
  - 允许存在 `liveTurnOverlay`
- `completed | failed | interrupted`
  - overlay 必须被清空

## Snapshot Relationship

- `running`
  - snapshot 中允许存在该 turn，但正文不必完整
- `completed`
  - turn 正文必须完整 materialize 到 snapshot
- `failed`
  - turn 至少保留已提交正文和错误信息
- `interrupted`
  - turn 至少保留已提交正文和中断原因

## Event To State Mapping

- `turn.started`
  - `idle -> running`
- `message.delta / reasoning.delta / tool.* / artifact.*`
  - 只能作用于 `running`
- `turn.completed`
  - `running -> completed`
- `turn.failed`
  - `running -> failed`
- `turn.interrupted`
  - `running -> interrupted`

## Hard Guardrails

- 任何 targeting 到非 running turn 的 mutation event 必须拒绝
- 即使 provider 迟到发送 delta，也不能改写已完成 turn
- 历史 view 不得自行恢复 overlay

## Verification

至少需要以下测试：

- running turn 接受 delta
- completed turn 拒绝 delta
- failed turn 拒绝 delta
- interrupted turn 拒绝 delta
- turn 完成后 overlay 清空

## Risks / Maintenance Notes

- 若 turn 状态机没有单独文档，后续极容易在某个局部补丁里重新放开 completed turn 的改写
- 多 provider 接入后，更必须依靠状态机而不是事件顺序猜测当前状态
