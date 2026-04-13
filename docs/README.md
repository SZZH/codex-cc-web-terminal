# Docs Index

Last updated: 2026-04-13

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

- [Documentation Standards](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/documentation-standards.md)
- [Document Templates](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/document-templates.md)
- [Change Scope Rules](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/change-scope-rules.md)
- [Verification Matrix](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/verification-matrix.md)
- [Sync Checklists](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/sync-checklists.md)
- [Regression Plan](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/testing/regression-plan.md)

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
