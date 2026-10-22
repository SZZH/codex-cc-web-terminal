# Project Rules

## Runtime Entry

- This file is the project-level runtime rule entry for this repository.
- Read this file before making code changes.
- Use it together with `.harness/` for task orchestration and verification.

## Harness

- `.harness/` is initialized for this repo and reserved for lightweight project orchestration metadata.
- Keep harness notes small and repo-specific.
- Treat `AGENTS.md` as the first-stop guardrail before execution.
- Agent-created planning, roadmap, execution, audit, review, and temporary project notes must default to `.harness/`.
- Do not place new agent-generated markdown files in the repo root unless the user explicitly asks for a root-level file or the file is intended as user-facing open-source documentation.
- If the current harness rules are not sufficient for a new note type, update `.harness/README.md` first, then add the file under `.harness/`.
- `.harness/` is not the default home for long-term project standards, architecture docs, or community-facing maintenance guides.
- Formal, long-lived project documentation must default to `docs/`.
- Documentation placement and structure rules are defined in `docs/contributing/documentation-standards.md`.
- New formal documents should follow the templates defined in `docs/contributing/document-templates.md`.
- Change execution boundaries are defined in `docs/contributing/change-scope-rules.md`.
- Minimum verification requirements are defined in `docs/contributing/verification-matrix.md`.
- Required documentation sync actions are defined in `docs/contributing/sync-checklists.md`.

## Engineering Rules

- Prefer minimal, local changes.
- 任何代码改动默认同时考虑：架构边界、长期维护、文件体量、复用空间；不要为了赶功能把复杂逻辑继续堆进一个超大文件。
- 前后端代码默认模块化：避免把会话流、接口拼装、渲染逻辑、状态管理长期堆在单个大文件里；新增逻辑优先按职责拆成可复用模块、组件、工具函数或服务层。
- 发现通用逻辑时，优先抽公共函数或组件，命名与边界要服务复用、维护和测试，而不是只为当前页面临时拼接。
- 当单文件已经明显偏大或职责超过单一边界时，后续改动应优先先拆再改，不能继续在原文件上打补丁式扩张。
- Avoid broad refactors unless explicitly requested.
- Validate changes with the smallest relevant checks before closing a task.
- 单元测试是行为契约，默认新增/补齐用例来覆盖改动，不要为了让改动通过而轻易修改既有测试；只有在需求或真实行为发生变化时，才允许连同测试一起调整，并在交付里说明原因。
- Do not include secrets, personal paths, screenshots, temp files, or local debug artifacts in commits.

## Git Rules

- This is an open-source project. Use Git tags for releases or important feature milestones.
- Git tags should use version-style names such as `v0.1.0` for releases or milestone snapshots unless the maintainer asks for another format.
- Tag annotations must be written in Chinese.
- When the maintainer asks to "打版本", "发版本", "切版本", or gives an equivalent release intent, treat it as a tag-release workflow by default unless they explicitly say otherwise.
- Tag annotations should record the recent milestone changes as grouped bullet points, covering the main new features and major bug fixes included since the previous version tag.
- Tag annotations should not be step-by-step terminal logs, but they also should not be overly brief; they should preserve the core shipped changes in a readable release-note style.
- If many fixes happened in the same milestone, summarize them by functional area instead of listing noisy implementation details.
- Before pushing code to the remote, update the Changelog in both `README.md` and `README.zh-CN.md` with the user-visible additions and fixes included in that push. Do not push until both entries exist. Group one push under one version heading. If that heading was already published by an earlier push, start the next version heading. Summarize by feature and fix, not by commit.
- `README.md` is English only. `README.zh-CN.md` is Chinese only. Prose, headings, changelog sentences, and link text stay in that document's language. Commands, configuration keys, URLs, package names, filenames, and user-facing error strings stay literal inside code. The full rule is in `docs/contributing/documentation-standards.md`.
- Commit titles should still describe the main shipped outcome, but they do not need a forced `feat(...)` / `fix(...)` prefix unless the maintainer asks for it.
- If a commit body is used, list only the core additions or a few key fixes.
- Do not write step-by-step work logs, terminal actions, or review narration into commit messages.
- If many bugs were fixed together, summarize only the most important ones.

## Default Delivery

- When a task changes behavior, summarize the outcome, verification, and any remaining edge cases.
- If a repository rule changes, update `AGENTS.md` and, when relevant, `CONTRIBUTING.md`.
