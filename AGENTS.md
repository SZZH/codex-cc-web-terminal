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

## Commit Rules

- This is an open-source project. Every commit message must use a clear tag prefix such as `feat(...)`, `fix(...)`, `refactor(...)`, `docs(...)`, `chore(...)`.
- The commit title must describe the main user-facing or maintainer-facing outcome, not the implementation process.
- The commit body should list only the core additions or the most important fixes.
- Do not write step-by-step work logs, terminal actions, or review narration into commit messages.
- If many bugs were fixed together, summarize only the few most important ones.
- Prefer messages that remain readable in release notes and GitHub history.

## Default Delivery

- When a task changes behavior, summarize the outcome, verification, and any remaining edge cases.
- If a repository rule changes, update `AGENTS.md` and, when relevant, `CONTRIBUTING.md`.
