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

## Commit Message Guidelines

- Use a tagged commit title such as `feat(...)`, `fix(...)`, `refactor(...)`, `docs(...)`, or `chore(...)`.
- Keep the title focused on the main shipped outcome.
- If you add a commit body, list only core features or the most important fixes.
- Do not use step-by-step work logs or implementation narration in commit messages.
