# Contributing

Thanks for contributing.

## Development Setup

1. Install Node.js 22+.
2. Copy `.env.example` to `.env`.
3. Set `ACCESS_TOKEN` in `.env`.
4. Install dependencies:

```bash
npm install
```

5. Start development servers (backend watch + web HMR):

```bash
npm run dev:up
```

## Checks Before PR

Run:

```bash
npm run check
npm test
```

`check` validates syntax and builds the frontend. `npm test` runs all regression tests,
including HTTP, WebSocket, thread state, and frontend runtime contracts. CI runs both.

## Documentation Rules

- Use root docs for entry-level repository guidance only:
  - `README.md`
  - `README.zh-CN.md`
  - `AGENTS.md`
  - `CONTRIBUTING.md`
- Put formal long-term project documentation in `docs/`.
- Use `.harness/` only for lightweight execution notes, temporary plans, or agent-oriented coordination material.
- Do not add new long-lived project standards to `.harness/`.
- Follow [documentation-standards.md](./docs/contributing/documentation-standards.md) when creating or moving docs.
- Prefer the templates in [document-templates.md](./docs/contributing/document-templates.md) when adding formal docs.
- Keep `docs/README.md` updated when a new formal documentation area is added.
- Follow [change-scope-rules.md](./docs/contributing/change-scope-rules.md) to avoid out-of-scope edits.
- Follow [verification-matrix.md](./docs/contributing/verification-matrix.md) for minimum required checks.
- Follow [sync-checklists.md](./docs/contributing/sync-checklists.md) when a change requires docs or rule synchronization.

## Scope Guidelines

- Prefer minimal, local changes.
- Every code change should consider architecture boundaries, maintainability, file size, and reuse up front; do not keep expanding already oversized files with patch-on-patch logic.
- Keep frontend and backend code modular by default: if logic is reusable or independently testable, extract it into a focused component, helper, service, or route module instead of growing one large file.
- If a file is already clearly oversized or mixes multiple responsibilities, prefer splitting it before adding more behavior.
- Treat tests as contracts. Add or extend unit tests for behavior changes, and do not casually rewrite existing test cases just to fit an implementation; only update them when the intended behavior truly changed.
- Do not include secrets, personal paths, or local debug artifacts in commits.
- Keep `web/dist/` out of git history (already ignored).

## Commit And Tag Guidelines

- Keep commit titles focused on the main shipped outcome.
- If you add a commit body, list only core features or the most important fixes.
- Do not use step-by-step work logs or implementation narration in commit messages.
- Use Git tags for releases or important feature milestones.
- Prefer version-style tag names such as `v0.1.0`.
- Write tag annotations in Chinese.
- Tag annotations should summarize the recent core work of that release or milestone.
- Before pushing code to the remote, add the user-visible additions and fixes in that push to the Changelog in both `README.md` and `README.zh-CN.md`. Do not push until both entries exist.
- Keep one push in one version section. If that section was already published, open the next version section.
- Write `README.md` in English only and `README.zh-CN.md` in Chinese only. Keep commands, configuration keys, URLs, package names, filenames, and user-facing error text literal inside code. The detailed rule is in [documentation-standards.md](./docs/contributing/documentation-standards.md).
