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
```

## Scope Guidelines

- Prefer minimal, local changes.
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
