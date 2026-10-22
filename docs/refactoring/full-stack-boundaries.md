# Full-Stack Boundaries

Last updated: 2026-10-16
Status: deprecated
Owner: maintainers

Superseded by: [Codex V2 聊天契约](codex-chat-v2.md)

> 本旧规划已被替代（superseded），保留用于历史和兼容层参考。Codex 当前主链路采用官方 typed 历史、独立持久回执与稳定线程 WebSocket；本文的旧 canonical/snapshot/SSE 设计不再作为 V2 实施依据。

## Goal

定义会话系统重构中的前后端统一边界，明确：

- 哪些东西必须共享同一份契约
- 哪些逻辑只能后端负责
- 哪些逻辑只能前端负责
- 哪些逻辑绝对不能前后端各写一份

核心目的不是补充实现细节，而是防止后续开发再次长出第二套状态解释系统。

## Background

当前系统的问题并不只是某个 bug，而是边界不清：

- 后端输出多套协议
- 前端消费多套状态源
- 页面自己再做投影与纠错

这导致：

- 当前页与新标签页不一致
- 历史与实时互相污染
- 同一轮 turn 被多次解释
- 某个修复只能压住局部，不会真正收口

## Shared Contract

以下内容必须是前后端共用的单一真相源：

- canonical event schema
- thread snapshot schema
- live turn overlay schema
- turn state machine
- provider capability schema
- transport event contract

这些内容的单一真相源应集中在：

- `docs/refactoring/*.md`

前后端**不得依赖共享代码目录**承载这些契约，而应：

- 各自实现本地类型与校验
- 共同对齐同一份文档契约
- 通过契约测试和 JSON 样本保证一致

## Backend Ownership

后端唯一负责：

- provider adapter
- canonical event 生成
- projector
- snapshot 持久化
- overlay materialization
- stream transport
- history/continuation 服务端合成

后端必须决定：

- 一个原始 provider 事件映射成什么 canonical event
- 一个 turn 什么时候算 completed / failed / interrupted
- overlay 什么时候写入 snapshot
- 历史内容从哪里读取

后端不能把这些决定交给前端猜。

## Frontend Ownership

前端唯一负责：

- 解析统一 transport 事件
- 维护最小展示态
- 渲染 `authoritativeSnapshot + liveTurnOverlay`
- 展示连接状态、错误状态、用户交互状态

前端不负责：

- 生成 canonical event
- 生成 snapshot
- 合并多条真相源
- 用文本相似度修复协议问题
- 判断哪个 provider 原始事件才算最终正文

## Hard Separation Rules

### 1. Backend Owns Projection

网络上传的是事件，但“这些事件最终变成什么线程状态”只能由后端 projector 决定。

前端不得再自行做：

- `messages[] -> turn[]`
- `conversation + snapshot -> truth`
- runtime message merge

### 2. Frontend Owns Rendering Only

前端只允许做：

- 读取 snapshot
- 渲染 snapshot
- 叠加当前 overlay

如果前端开始“修状态”，说明边界已经坏了。

### 3. History Is Backend-Composed

历史视图如果需要叠加 continuation，也必须由后端先提供：

- persisted snapshot
- live overlay

前端不能自己把历史数组和实时数组合并。

### 4. Completed Turn Is Immutable Everywhere

一旦 turn 完成：

- 后端不能再改
- 前端不能再改
- 后续迟到事件只能记录审计，不能污染已完成 turn

## Logic That Must Never Be Duplicated

下面这些逻辑绝不能前后端重复实现：

- turn 完成判定
- turn 状态机迁移
- completed turn 冻结规则
- overlay 清理时机
- 事件幂等规则
- 历史/实时隔离规则
- provider capability fallback 规则

如果这些规则在前后端各写一份，后面必然分叉。

## Logic That May Be Shared As Types Only

以下内容可以“共享契约定义”，但实现必须分开：

- schema types
- event enums
- snapshot types
- capability matrix

前提是：

- 契约定义来自同一份文档 source
- 前后端各自维护本地类型实现
- 行为规则仍由单一 projector 决定

## Logic That May Be Implemented On Both Sides

只有这类纯展示/纯解析逻辑允许双端各自实现：

- SSE parser
- 日期/时间展示格式
- UI 组件映射
- 纯读型 selector

但这些实现不得影响真相源。

## Anti-Patterns

明确禁止：

- 前端用文本相似度主导状态修复
- 前端从 `message_part` 直接构建历史内容
- 后端同时输出多套可渲染主协议
- 历史 route 与 live route 使用不同 turn identity 体系
- provider raw event 直接进入 UI
- completed turn 被新事件再次改写

## Extension Workflow

### Add A New Provider

必须按以下顺序：

1. 注册 provider entry
2. 声明 capability matrix
3. 实现 adapter
4. 补 adapter mapping tests
5. 不改 projector 契约
6. 不改 UI 协议

### Add A New Event Kind

必须按以下顺序：

1. 扩 canonical event schema
2. 扩 projector 规则
3. 扩 snapshot schema（如需要）
4. 扩 transport contract
5. 扩 renderer

禁止直接先改 UI。

### Add A New UI Content Type

必须先确认：

- 这是新的 canonical kind
- 还是已有 kind 的新展示方式

如果是新的 canonical 语义，先改 schema，再改渲染。

## Review Checklist

每次架构相关改动都应该检查：

- 有没有新增第二真相源？
- 有没有让前端承担状态纠错？
- 有没有让后端把状态判定下放给前端？
- 有没有让历史与实时重新共享可变对象？
- 有没有让某个 provider 的特例泄露到通用层？

## Verification

后续每次实现都应至少验证：

- 当前页和新标签页最终一致
- 历史内容不会被实时覆盖
- completed turn 不再变化
- 新 provider 接入时前端协议不变
- 新事件类型接入时不会绕过 projector

## Risks / Maintenance Notes

- 最容易失控的地方，不是代码量，而是“为了快先在前端补一个判断”
- 一旦前端重新承担状态修复，后续所有 provider 接入都会放大复杂度
- 一旦历史视图重新混入原始流式事件，历史与实时污染问题会再次出现

## Recommendation

正式实施前，必须先冻结：

- shared contract docs
- projector invariants
- transport contract
- 本文档中的 full-stack boundaries

冻结之后，任何实现偏离都应视为架构回退，而不是普通实现细节。
