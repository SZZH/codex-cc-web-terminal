# Harness

This directory stores lightweight project orchestration notes for `codex-cc-web-terminal`.

## Purpose

- Keep project-level execution context close to the repo.
- Pair with `AGENTS.md` as the repo guardrail entry.
- Avoid putting secrets or machine-specific artifacts here.
- Keep execution materials separated by lifecycle state so active and obsolete notes do not mix.

## Storage Rules

- Default location for agent-generated project notes is `.harness/`.
- This includes roadmap, implementation plan, task breakdown, audit notes, review notes, migration notes, and other execution-support files.
- Do not add new agent-generated markdown files to the repo root unless the user explicitly asks for that location or the file is meant to be user-facing repository documentation.
- Keep notes lightweight, repo-specific, and easy to prune.
- When adding a new note type, prefer a short descriptive filename in kebab-case.
- `.harness/` is for temporary or execution-oriented collaboration material, not the project’s formal long-term documentation home.
- If a note becomes a stable team or community rule, migrate it into `docs/` and keep `.harness/` for the lightweight working copy only when needed.

## Directory Model

Use the following structure:

```text
.harness/
  README.md
  inbox/
  roadmaps/
    active/
  plans/
    active/
  audits/
    active/
  archive/
    completed/
    superseded/
    abandoned/
```

Rules:

- Do not keep long-lived markdown files directly under `.harness/` root, except `README.md`.
- New execution materials must go into a lifecycle-aware subdirectory.
- `active/` means the file is still valid input for current execution.
- `archive/` means the file is not current execution input anymore.

## Status Rules

Every non-trivial markdown file under `.harness/` should include:

- `Created`
- `Status`
- `Owner`
- `Source`
- `Exit Condition`
- `Supersedes`
- `Superseded By`

Allowed status values:

- `inbox`
- `active`
- `completed`
- `superseded`
- `abandoned`

## Lifecycle

- New unprocessed ideas go to `inbox/`
- Valid current roadmap files go to `roadmaps/active/`
- Valid current implementation plans go to `plans/active/`
- Valid current audit/review notes go to `audits/active/`
- Finished plans move to `archive/completed/`
- Replaced plans move to `archive/superseded/`
- Explicitly dropped plans move to `archive/abandoned/`

Archived files should not be used as default execution input unless explicitly reopened.

## Boundary

- Put long-lived architecture, testing, refactoring, operations, and contributor-facing standards into `docs/`.
- Put project entry rules into root documents such as `README.md`, `AGENTS.md`, and `CONTRIBUTING.md`.
- Treat `.harness/` as a working layer for maintainers and agents, not as the default community documentation entry point.

## Current Notes

- Commit messages for this open-source repo must use explicit tags and summarize only core shipped functionality or key fixes.
- Product roadmap is stored in `roadmaps/active/product-roadmap.zh-CN.md`.
