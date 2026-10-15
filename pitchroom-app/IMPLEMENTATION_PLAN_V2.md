# Pitchroom V6 complete local loop plan

Status: implemented and locally verified on 2026-10-15

## Fixed scope

Deliver one durable local loop: `Materials -> Clarify -> Positioning -> Deck`.
The implementation remains single-project and supports UTF-8 `.txt` and `.md`.
Deck output is a five-page discussion draft: Positioning, Shift, Rationale,
Evidence, and Open questions. Browser Print / Save PDF is the only export in
scope. Authentication, multi-project UI, collaboration, billing, PPTX, and
complex file parsing remain production-track work.

## Non-negotiable behavior

- Preview, Apply, and Create Deck are separate user-controlled boundaries.
- Understanding, Positioning, and Deck generation expose pending, completed,
  failed, retry, stale, and committed states where applicable.
- Generated factual content remains source-linked; user corrections remain
  attributed user input; unknowns remain open.
- A new source or positioning choice never silently overwrites a saved deck.
- Deck page edits create a new draft version; prior versions are read-only.
- Fixture, deterministic tests, live model validation, browser QA, and human
  acceptance remain separate evidence gates.

## Delivery sequence

1. Reconcile implementation truth and maintain this file as the execution SOT.
2. Make Positioning runs observable and failures durable/retryable.
3. Complete Positioning compare/apply/undo and explicit Create Deck gate.
4. Add Deck domain, persistence, migrations, commands, and version history.
5. Add a bounded, grounded five-page Deck agent with deterministic and live runners.
6. Add Deck review, page editing, history, stale state, and print review UI.
7. Add contract, repository, agent, UI, eval, and complete-loop browser tests.
8. Reconcile audit/harness docs with only freshly verified results.

## Completion gate

The local loop is complete only when an isolated synthetic browser journey can
create material, accept an understanding, apply a positioning direction,
explicitly create a deck, review all five pages, edit one page into a new draft,
inspect the prior version, and observe a stale warning after upstream changes.
A separately authorized live smoke must validate Positioning and Deck model
adapters before either is called live-validated.

## Verified outcome

- PASS: type safety, 110 deterministic tests, 9 non-destructive PostgreSQL
  contracts, and the production Next.js build.
- PASS: a fresh non-recording synthetic browser journey completed the full
  gate above, including a positioning headline adjustment that forced a fresh
  Apply, five ordered pages, draft 2 editing/history, and a stale warning after
  new material. Browser console warnings/errors: 0.
- IMPLEMENTED, NOT RUN: the repeatable Playwright journey. Its configuration
  records artifacts on failure, so it was not executed without fresh recording
  authorization.
- IMPLEMENTED, MOCK-VALIDATED, NOT LIVE-VALIDATED: Positioning and Deck model
  adapters. No external model call was made in this verification.
- NOT RUN: human acceptance of usefulness and real customer material.

