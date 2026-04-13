# Document Templates

Last updated: 2026-04-13

## Purpose

This file defines reusable templates for long-lived project documentation.

When adding a new formal document under `docs/`, prefer starting from one of these templates instead of writing from scratch.

## Shared Frontmatter Block

Every formal `docs/` file should begin with a small metadata block in prose form:

```md
# Title

Last updated: YYYY-MM-DD
Status: draft | active | deprecated
Owner: maintainers | backend | frontend | infra | community
```

Rules:

- `Last updated` is required
- `Status` is required
- `Owner` is recommended
- Keep metadata human-readable, not YAML frontmatter

## 1. Architecture Doc Template

Use for:

- system design
- module boundaries
- data flow
- runtime composition

Template:

```md
# Document Title

Last updated: YYYY-MM-DD
Status: active
Owner: backend

## Background

Why this area needs documentation.

## Goal

What this architecture is trying to achieve.

## Scope

What this document covers.

## Non-goals

What this document intentionally does not cover.

## Components

- Component A
- Component B
- Component C

## Boundaries

- What belongs here
- What must not be placed here

## Data / Control Flow

Describe the main request, event, or lifecycle flow.

## Key Invariants

- Invariant 1
- Invariant 2

## Extension Rules

How future contributors should extend this area safely.

## Verification

How to confirm the architecture still matches reality.

## Risks / Maintenance Notes

What tends to drift or break first.
```

## 2. Testing Strategy Template

Use for:

- testing philosophy
- test layers
- CI expectations

Template:

```md
# Testing Strategy

Last updated: YYYY-MM-DD
Status: active
Owner: maintainers

## Goal

What quality bar this strategy is designed to protect.

## Scope

Which parts of the project are covered.

## Test Layers

- Unit tests
- Integration tests
- End-to-end or smoke tests

## What Must Be Tested

- Critical user flows
- Security-sensitive behavior
- Regression-prone logic

## What Can Be Lightweight

- Low-risk glue code
- Cosmetic-only changes

## Required Checks Before Merge

- `npm run ...`
- `npm run ...`

## Regression Rules

When new tests are required.

## CI Rules

What runs in CI and what may remain local-only.

## Known Gaps

What is not yet covered.
```

## 3. Regression Plan Template

Use for:

- concrete regression matrix
- scenario-based coverage

Template:

```md
# Regression Plan

Last updated: YYYY-MM-DD
Status: active
Owner: backend

## Goal

What this regression plan is protecting.

## Executable Tests

- Test file / command
- Test file / command

## Critical Scenarios

- Scenario 1
- Scenario 2
- Scenario 3

## Change Triggers

If area X changes, run Y.

## Full Verification Gate

What must pass before the refactor or release is considered complete.

## Gaps To Fill

Remaining missing cases.
```

## 4. Refactoring Plan Template

Use for:

- medium/large refactors
- phased migration plans

Template:

```md
# Refactoring Plan

Last updated: YYYY-MM-DD
Status: draft
Owner: backend

## Background

What is wrong with the current state.

## Goal

What “done” looks like.

## Scope

What will be changed.

## Non-goals

What will not be changed in this refactor.

## Current Problems

- Problem 1
- Problem 2

## Target Structure

Describe the desired module/file layout.

## Phases

1. Phase 1
2. Phase 2
3. Phase 3

## Compatibility Rules

What external behavior must remain unchanged.

## Verification

Which tests/checks must pass after each phase.

## Risks

Main risks and rollback considerations.
```

## 5. Operations / Runbook Template

Use for:

- deployment
- service lifecycle
- incidents

Template:

```md
# Runbook Title

Last updated: YYYY-MM-DD
Status: active
Owner: infra

## Purpose

What operational task this runbook supports.

## Preconditions

What must be true before running these steps.

## Steps

1. Step one
2. Step two
3. Step three

## Verification

How to verify the task succeeded.

## Failure Handling

What to check first when it fails.

## Notes

Known caveats.
```

## 6. ADR Template

Use for:

- durable design decisions
- choices with meaningful tradeoffs

Template:

```md
# ADR 0001: Decision Title

Last updated: YYYY-MM-DD
Status: accepted
Owner: maintainers

## Context

What decision needed to be made.

## Decision

What was chosen.

## Consequences

- Positive consequence
- Negative consequence
- Follow-up consequence

## Alternatives Considered

- Alternative A
- Alternative B
```

## 7. `.harness/` Working Note Template

Use for:

- temporary plans
- execution notes
- in-progress agent coordination

Template:

```md
# Working Note Title

Created: YYYY-MM-DD
Status: temporary
Owner: maintainer or agent

## Context

Why this note exists.

## Current Plan

- Task 1
- Task 2

## Open Questions

- Question 1
- Question 2

## Exit Condition

When this note should be deleted, migrated, or formalized.
```

## Selection Rule

If the document should remain useful for future contributors, start from a `docs/` template.  
If the document only helps the current implementation phase, use the `.harness/` working note template instead.
