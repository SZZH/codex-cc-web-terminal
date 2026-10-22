# Docs Index

Last updated: 2026-10-16

## Purpose

`docs/` is the long-term documentation home for `codex-cc-web-terminal`.

Use this directory for formal, durable, community-facing project knowledge:

- architecture
- testing
- refactoring plans
- contributor standards
- operations and maintenance

Do not use `docs/` for temporary execution scratch notes. Those belong in `.harness/`.

## Recommended Structure

```text
docs/
  README.md
  architecture/
    backend.md
    frontend.md
    runtime.md
  contributing/
    documentation-standards.md
    document-templates.md
    development-workflow.md
  testing/
    strategy.md
    regression-plan.md
  refactoring/
    backend-refactor-plan.md
  operations/
    deployment.md
    service-management.md
  adr/
    0001-some-decision.md
```

## Current Documents

- [Codex V2 聊天契约（当前主链路）](refactoring/codex-chat-v2.md)
- [Codex 桌面兼容边界](architecture/codex-desktop-compatibility.md)
- [界面品牌、状态反馈与运行中筛选](architecture/interface-feedback.md)
- [本地文件与网页预览运维](operations/local-preview.md)
- [公网前端静态发布与回退](operations/frontend-release.md)
- [Documentation Standards](contributing/documentation-standards.md)
- [Document Templates](contributing/document-templates.md)
- [Change Scope Rules](contributing/change-scope-rules.md)
- [Verification Matrix](contributing/verification-matrix.md)
- [Sync Checklists](contributing/sync-checklists.md)
- [Regression Plan](testing/regression-plan.md)
- [旧 Thread / Turn / Item Bridge 方案（superseded，历史参考）](refactoring/codex-thread-item-bridge-refactor.md)

## Placement Quick Rules

- “这个项目是什么、怎么跑”:
  - root `README.md`
- “贡献者怎么参与、怎么提 PR”:
  - root `CONTRIBUTING.md`
- “系统为什么这样设计、模块边界是什么”:
  - `docs/architecture/*`
- “怎么测试、测什么、回归怎么做”:
  - `docs/testing/*`
- “这次重构打算怎么拆、分几步做”:
  - `docs/refactoring/*`
- “只是当前阶段的 agent 草稿、执行计划、临时核对项”:
  - `.harness/`

## Maintenance Rule

When a document becomes stable and useful for future contributors, move it into `docs/` and link it from the appropriate entry document.
