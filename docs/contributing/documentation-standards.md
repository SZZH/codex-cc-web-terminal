# Documentation Standards

Last updated: 2026-04-13

## Background

`codex-cc-web-terminal` 目标是作为开源社区项目长期共建，因此文档结构必须同时服务两类读者：

- 社区贡献者
- 运行中的 agent / maintainers

如果不区分“正式长期文档”和“临时执行笔记”，仓库会很快出现文档散落、入口不清、规则冲突的问题。

## Goal

建立一套稳定、可预期的仓库文档规则，让任何贡献者都能快速判断：

- 文档应该放在哪里
- 什么内容算正式规范
- 什么内容只是阶段性执行材料
- 哪份文档是长期有效的单一真相源
- 新文档应该套用什么模板
- 文档何时迁移、归档、删除

## Scope

本规范覆盖：

- 仓库根目录文档
- `docs/` 下的正式文档
- `.harness/` 下的执行协作文档
- 文档命名、结构、维护原则

本规范不覆盖：

- 产品文案写作风格
- README 里的市场表达
- 代码注释规范

## Documentation Architecture

### 1. Repo Root

仓库根目录只保留最高优先级入口文档：

- `README.md`
- `README.zh-CN.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`

这些文件回答的是最高层问题：

- 项目是什么
- 怎么参与
- 协作边界是什么
- 安全和社区规则是什么

### 2. `docs/`

`docs/` 是项目正式长期知识库，默认承载所有面向社区协作的正式文档。

适合放在 `docs/` 的内容：

- 架构说明
- 模块边界
- 测试策略
- 回归测试矩阵
- 重构方案
- 发布流程
- 运维说明
- 设计决策记录
- 社区可见的开发规范补充

不适合放在 `docs/` 的内容：

- 一次性执行草稿
- agent 临时计划
- 纯中间态分析笔记
- 很快会过期的任务拆分

建议在 `docs/` 内继续分层，而不是长期平铺：

- `docs/architecture/`
- `docs/testing/`
- `docs/refactoring/`
- `docs/operations/`
- `docs/contributing/`
- `docs/adr/`

### 3. `.harness/`

`.harness/` 只用于轻量、阶段性、执行导向的协作材料，不作为社区正式文档入口。

适合放在 `.harness/` 的内容：

- 当前阶段 roadmap 草稿
- 临时实施计划
- 执行 checklist
- review / audit 临时记录
- agent 协调备注

不适合放在 `.harness/` 的内容：

- 正式架构规范
- 长期测试策略
- 面向社区的文档标准
- 长期维护规则

一句话：

- `docs/` 是长期资产
- `.harness/` 是运行时协作层

`.harness/` 必须按生命周期分目录，不允许长期把 active 与已失效材料混放。

## Placement Rules

默认按以下规则放置：

- 介绍项目与上手方式：根目录 `README*`
- 贡献规则：根目录 `CONTRIBUTING.md`
- agent 执行规则：根目录 `AGENTS.md`
- 社区行为和安全规则：根目录 `CODE_OF_CONDUCT.md`、`SECURITY.md`
- 长期正式规范：`docs/`
- 阶段性执行资料：`.harness/`

若某份文档同时满足“长期有效”和“社区需要直接阅读”，优先放 `docs/`，不要放 `.harness/`。

## Placement Matrix

- 回答“这个项目是什么、怎么跑”：
  - 放 `README.md`
- 回答“贡献者怎么参与、怎么提 PR”：
  - 放 `CONTRIBUTING.md`
- 回答“系统为什么这么设计、模块边界是什么”：
  - 放 `docs/architecture/*`
- 回答“怎么测试、测什么、回归怎么做”：
  - 放 `docs/testing/*`
- 回答“某次重构打算怎么拆、分几步做”：
  - 放 `docs/refactoring/*`
- 回答“怎么部署、怎么运维、故障怎么排查”：
  - 放 `docs/operations/*`
- 回答“为什么选择这个长期方案而不是另一个”：
  - 放 `docs/adr/*`
- 只是当前阶段 agent 的执行草稿、临时计划、核对清单：
  - 放 `.harness/`

## Harness Lifecycle Layout

推荐结构：

```text
.harness/
  inbox/
  roadmaps/active/
  plans/active/
  audits/active/
  archive/completed/
  archive/superseded/
  archive/abandoned/
```

使用规则：

- `inbox/`
  - 尚未整理的输入
- `roadmaps/active/`
  - 当前仍有效的路线图
- `plans/active/`
  - 当前执行中的计划
- `audits/active/`
  - 当前仍有参考价值的审查记录
- `archive/completed/`
  - 已完成，不再作为当前输入
- `archive/superseded/`
  - 被更新方案替代
- `archive/abandoned/`
  - 明确放弃执行

## Harness Status Rules

`.harness/` 文档建议包含：

- `Created`
- `Status`
- `Owner`
- `Source`
- `Exit Condition`
- `Supersedes`
- `Superseded By`

允许的 `Status`：

- `inbox`
- `active`
- `completed`
- `superseded`
- `abandoned`

## Recommended Docs Layout

建议逐步收敛成如下结构：

```text
docs/
  architecture/
    backend.md
    frontend.md
    runtime.md
  contributing/
    documentation-standards.md
    document-templates.md
    development-workflow.md
  refactoring/
    backend-refactor-plan.md
  testing/
    strategy.md
    regression-plan.md
  operations/
    deployment.md
    service-management.md
```

## Naming Rules

- 文件名使用小写英文 + kebab-case
- 避免空格、中文文件名、临时缩写
- 文件名应表达文档用途，而不是过程状态
- 同一类文档尽量使用稳定命名，不要同义词混用

推荐：

- `regression-plan.md`
- `documentation-standards.md`
- `backend-architecture.md`

不推荐：

- `new_doc.md`
- `最终版2.md`
- `重构想法.md`

## Metadata Rules

正式文档默认使用顶部元信息块：

```md
# Title

Last updated: YYYY-MM-DD
Status: draft | active | deprecated
Owner: maintainers | backend | frontend | infra | community
```

规则：

- `Last updated` 必填
- `Status` 必填
- `Owner` 推荐填写
- 不强制使用 YAML frontmatter，保持 Markdown 可读性优先

## Required Document Types

对于长期维护的开源项目，建议至少具备这些文档：

- 根目录
  - `README.md`
  - `CONTRIBUTING.md`
  - `AGENTS.md`
  - `SECURITY.md`
  - `CODE_OF_CONDUCT.md`
- `docs/`
  - 架构说明
  - 测试策略或回归方案
  - 重构方案
  - 文档标准

随着项目变大，再补：

- 运维 runbook
- ADR
- 发布流程
- 模块级架构文档

## Content Template

正式文档建议尽量包含以下字段：

- Background
- Goal
- Scope
- Non-goals
- Current State
- Rules / Design / Plan
- Verification
- Risks / Maintenance Notes

这样有利于贡献者快速理解文档意图，也能减少“文档看起来像笔记”的问题。

模板库定义在：

- [document-templates.md](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/document-templates.md)

## Lifecycle Rules

文档生命周期统一分为：

- `draft`
  - 正在形成、可能频繁变化
- `active`
  - 当前有效，作为正式参考
- `deprecated`
  - 已废弃，但短期保留用于迁移提示

处理规则：

- `.harness/` 中的临时文档若变成长期规则，应迁移到 `docs/`
- 失效的正式文档不要直接静默留存，应至少标记 `deprecated`
- 彻底无价值的临时文档应删除，不长期占位
- `.harness/` 下的 active 文档若状态变化，必须同步迁移到对应目录，而不是仅修改正文

## Single Source Of Truth Rules

- 同一类规则应只有一个主文档
- 入口文档只放摘要和链接，不复制完整规则
- 若规则更新，先改主文档，再同步入口说明
- 避免在 `README.md`、`CONTRIBUTING.md`、`AGENTS.md` 里写出互相不一致的重复版本

## Change Triggers

出现以下情况时，必须同步更新文档：

- 新增长期目录或模块边界
- 调整测试入口或最低验证要求
- 引入新的贡献流程或 PR 规则
- 重构改变了扩展方式或约束
- `.harness/` 内某份材料升级为正式规范

## Maintenance Rules

- 规则变化时，优先更新单一真相源文档，而不是在多个地方重复写。
- 若某份 `.harness/` 临时文档变成长期规范，应迁移到 `docs/`。
- 若某份临时文档已经失效，应删除，而不是长期保留。
- 新增正式规则时，需要同步更新 `AGENTS.md` 或 `CONTRIBUTING.md` 中的入口说明。
- 新增正式文档时，优先挂到 `docs/README.md` 或相关入口文档中。

## Current Repo Guidance

对于当前仓库，建议这样理解：

- `.harness/roadmaps/active/product-roadmap.zh-CN.md`
  - 保留在 `.harness/roadmaps/active/`
  - 因为它更像当前阶段的产品推进资料
- `docs/testing/regression-plan.md`
  - 应继续保留在 `docs/`
  - 因为它属于长期有效的正式测试资产
- 后续的后端架构说明、重构方案、测试策略
  - 默认放在 `docs/`

## Template Rule

新增正式文档时，不要从空白开始自由发挥，优先使用模板库：

- [document-templates.md](/Users/jiaojian/Desktop/self/codex-cc-web-terminal/docs/contributing/document-templates.md)

## Decision Rule

当你不确定某份文档该放哪里时，用下面这条规则判断：

如果这份文档应该被未来社区贡献者长期阅读和引用，放 `docs/`。  
如果它只是帮助当前阶段执行、未来可能删除或改写，放 `.harness/`。
