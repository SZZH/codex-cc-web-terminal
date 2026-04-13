# Project Rules

## Runtime Entry

- This file is the project-level runtime rule entry for this repository.
- Read this file before making code changes.
- Use it together with `.harness/` for task orchestration and verification.

## Harness

- `.harness/` is initialized for this repo and reserved for lightweight project orchestration metadata.
- Keep harness notes small and repo-specific.
- Treat `AGENTS.md` as the first-stop guardrail before execution.

## Engineering Rules

- Prefer minimal, local changes.
- Avoid broad refactors unless explicitly requested.
- Validate changes with the smallest relevant checks before closing a task.
- Do not include secrets, personal paths, screenshots, temp files, or local debug artifacts in commits.

## Git Rules

- This is an open-source project. Use Git tags for releases or important feature milestones.
- Git tags should use version-style names such as `v0.1.0` for releases or milestone snapshots unless the maintainer asks for another format.
- Tag annotations must be written in Chinese.
- Tag annotations should summarize the recent core work of that milestone, not step-by-step implementation logs.
- If many fixes happened in the same milestone, summarize only the few most important ones.
- Commit titles should still describe the main shipped outcome, but they do not need a forced `feat(...)` / `fix(...)` prefix unless the maintainer asks for it.
- If a commit body is used, list only the core additions or a few key fixes.
- Do not write step-by-step work logs, terminal actions, or review narration into commit messages.
- If many bugs were fixed together, summarize only the most important ones.

## Default Delivery

- When a task changes behavior, summarize the outcome, verification, and any remaining edge cases.
- If a repository rule changes, update `AGENTS.md` and, when relevant, `CONTRIBUTING.md`.
