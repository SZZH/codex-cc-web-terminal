# Change Scope Rules

Last updated: 2026-04-14
Status: active
Owner: maintainers

## Background

开源社区项目在长期维护中，最常见的问题不是“没人改”，而是“顺手改太多”。

## Goal

明确一次改动允许影响的范围、默认禁止的越界行为，以及什么情况下必须先补方案再执行。

## Default Principle

- 默认最小改动
- 默认局部闭环
- 默认不顺手扩散
- 默认先保兼容，再做整理

## Change Levels

### `docs-only`

- 只改 `README`、`CONTRIBUTING`、`docs/`、`.harness/`
- 不夹带代码实现改动

### `small-code-change`

- 单一功能点补丁
- 不顺手重构 unrelated 模块

### `behavior-change`

- 对外行为变化
- 必须同步文档与验证

### `structure-change`

- 文件拆分
- 模块迁移
- 目录边界调整
- 原则上不顺手改行为

### `refactor`

- 中大型结构重构
- 必须先有正式方案文档

## Out-Of-Bounds Behavior

- 修一个 bug，顺手重命名一大片文件
- 做结构整理时偷偷改行为
- 改实现时不更新对应文档入口
- 没有计划文档就直接做跨模块迁移

## When A Plan Is Required

以下情况必须先补方案文档：

- 新增顶层目录
- 大规模目录迁移
- 改变模块边界
- 大文件拆分为多个子域模块
- 引入新的长期规则体系

## Split Rules

以下情况建议拆成多次提交或多阶段执行：

- 文档治理 + 代码重构
- 行为变化 + 文件迁移
- 新功能 + 重构旧模块

## Directory Rules

- 新目录必须有明确职责
- 临时材料不应新增正式长期目录
- `.harness/` 下新增目录必须符合状态/生命周期模型

## Final Rule

如果你不确定某次改动算不算越界，默认按越界处理：先缩小范围，或先补方案，再执行。
