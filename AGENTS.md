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
- Avoid broad refactors unless explicitly requested.
- Validate changes with the smallest relevant checks before closing a task.
- Do not include secrets, personal paths, screenshots, temp files, or local debug artifacts in commits.

## Git Rules

- This is an open-source project. Use Git tags for releases or important feature milestones.
- Git tags should use version-style names such as `v0.1.0` for releases or milestone snapshots unless the maintainer asks for another format.
- Tag annotations must be written in Chinese.
- When the maintainer asks to "打版本", "发版本", "切版本", or gives an equivalent release intent, treat it as a tag-release workflow by default unless they explicitly say otherwise.
- Tag annotations should record the recent milestone changes as grouped bullet points, covering the main new features and major bug fixes included since the previous version tag.
- Tag annotations should not be step-by-step terminal logs, but they also should not be overly brief; they should preserve the core shipped changes in a readable release-note style.
- If many fixes happened in the same milestone, summarize them by functional area instead of listing noisy implementation details.
- Keep `README.md` updated with a `Changelog` section organized by tag, and for each new tag add a concise summary of the main shipped changes without dumping every low-level detail.
- Commit titles should still describe the main shipped outcome, but they do not need a forced `feat(...)` / `fix(...)` prefix unless the maintainer asks for it.
- If a commit body is used, list only the core additions or a few key fixes.
- Do not write step-by-step work logs, terminal actions, or review narration into commit messages.
- If many bugs were fixed together, summarize only the most important ones.

## Default Delivery

- When a task changes behavior, summarize the outcome, verification, and any remaining edge cases.
- If a repository rule changes, update `AGENTS.md` and, when relevant, `CONTRIBUTING.md`.
