# Subagent Delivery Plan

Last updated: 2026-04-22
Status: draft
Owner: maintainers

## Goal

将多智能体单接口流式重构拆成边界清晰、可并行推进的子任务。

## Splitting Principles

- 先冻结契约，再实现
- 每个 subagent 尽量拥有独立写集
- 同一轮不要让多个 subagent 同时改同一份契约文档
- projector 与 transport 分开
- 前端消费层与后端协议层分开

## Workstreams

### S1 契约冻结

职责：

- 完善并冻结 refactoring 文档
- 维护 canonical examples
- 输出实施 checklist

写集：

- `docs/refactoring/*`

### S2 Provider Adapter Framework

职责：

- provider registry
- capability matrix
- adapter interface
- codex adapter 首版

写集：

- `src/providers/**`

依赖：

- S1

### S3 Canonical Projector

职责：

- canonical event 投影
- turn state machine 落代码
- immutable completed turn 规则

写集：

- `src/projector/**` 或 `src/threads/**`

依赖：

- S1

### S4 Persistence Convergence

职责：

- event log
- snapshot checkpoint
- history 只读 snapshot

写集：

- `src/sessions/history/**`
- `src/storage/**`

依赖：

- S1
- S3

### S5 Single Endpoint Transport

职责：

- `POST /input-stream`
- typed SSE transport
- aggregators

写集：

- `src/routes/**`
- `src/transport/**`

依赖：

- S1
- S3

### S6 Frontend Stream Client

职责：

- stream parser
- transport 状态管理
- 错误恢复

写集：

- `web/src/lib/**`

依赖：

- S1
- S5

### S7 Frontend State Convergence

职责：

- 只保留 `authoritativeSnapshot + liveTurnOverlay`
- 移除旧主链路

写集：

- `web/src/App.vue`
- `web/src/lib/thread-*`

依赖：

- S1
- S3
- S6

### S8 UI Typed Rendering

职责：

- message
- reasoning
- tool
- artifact
- history/realtime 统一展示

写集：

- `web/src/components/**`

依赖：

- S1
- S7

### S9 Contract And Regression QA

职责：

- 后端契约测试
- 前端契约测试
- E2E 一致性验证

写集：

- `tests/**`
- `web tests/**`

依赖：

- 全部

## Recommended Order

1. S1
2. S2
3. S3
4. S4
5. S5
6. S6
7. S7
8. S8
9. S9

## Safe Parallel Pairs

- S2 与 S4
- S5 与 S9 的测试草案
- S6 与 S8 的初始脚手架

## Unsafe Parallel Pairs

- S1 与任何正式实现
- S3 与 S7
- S5 与 S7
- 多个 subagent 同时修改同一协议文档

## Delivery Checklist

每个 subagent 交付时必须说明：

- 改动范围
- 是否碰协议
- 是否新增样本
- 跑了哪些验证
- 剩余风险
