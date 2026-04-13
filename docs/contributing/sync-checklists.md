# Sync Checklists

Last updated: 2026-04-14
Status: active
Owner: maintainers

## Goal

把“改了什么就必须同步哪里”写成固定清单。

## Checklist: 文档规则变化

必须同步：

- `AGENTS.md`
- `CONTRIBUTING.md`
- `docs/README.md`（如影响 docs 结构）

## Checklist: `.harness/` 结构变化

必须同步：

- `.harness/README.md`
- `AGENTS.md`
- `docs/contributing/documentation-standards.md`

## Checklist: 新增正式文档类型

必须同步：

- `docs/README.md`
- 必要时 `docs/contributing/document-templates.md`

## Checklist: 代码结构变化

必须同步：

- `docs/architecture/*`
- 若是重构，补 `docs/refactoring/*`

## Checklist: 测试入口变化

必须同步：

- `CONTRIBUTING.md`
- `docs/testing/*`
- 必要时 `verification-matrix.md`

## Checklist: 贡献流程变化

必须同步：

- `CONTRIBUTING.md`
- `AGENTS.md`（如影响 agent 执行边界）

## Checklist: 运维或服务流程变化

必须同步：

- `README.md`（若影响上手方式）
- `docs/operations/*`

## Checklist: 计划执行状态变化

必须动作：

- 更新状态
- 必要时迁移到 `archive/completed/`
- 若被替代，迁移到 `archive/superseded/`
- 若放弃，迁移到 `archive/abandoned/`
