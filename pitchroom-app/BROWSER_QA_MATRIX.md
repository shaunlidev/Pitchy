# Browser QA matrix

Last run: 2026-10-14

Environment: isolated synthetic fixture, manually controlled Chromium plus a
repeatable Playwright 1.64 suite in system Chrome. No external model or user data
is used. Playwright retains screenshots and traces only when a test fails.

Status values are `PASS`, `FAIL`, `PARTIAL`, and `NOT RUN`. Functional browser
evidence does not substitute for visual review or human acceptance.

| Journey | Status | Evidence | Remaining boundary |
|---|---|---|---|
| Paste supported source, run, inspect citation, accept | PASS | Source inventory, stable chunk reference, exact quote, ordered trace, explicit acceptance, terminal stopped state, and production screenshots at three widths were inspected | Human comprehension judgment remains open |
| Upload `.md`, create conflicting sources, preserve conflict | PASS | Two local Markdown fixtures were uploaded; the agent read both chunks, produced one `conflicting` claim with two exact quotes, asked the user which source is current, and `Keep unknown` created a new version without selecting a winner | Human usefulness judgment remains open |
| Keep an unknown and create a version | PASS | `Keep unknown` created version 3 and retained the unresolved gap without inferred evidence | Human usefulness judgment remains open |
| Correct a claim and inspect attribution/history | PASS | Corrected claim became `user asserted`, source attribution was removed, and version history advanced | Expanded history presentation was not visually reviewed |
| Answer the open question | PASS | Answer created an attributed user claim while preserving the source-backed claim | Human usefulness judgment remains open |
| Repeated answer/correction submission | PASS after repair | Browser reproduced stale draft text creating duplicate versions; successful answer/correction now clear their drafts and disable their submit buttons | Covered by browser revalidation; static component tests separately cover disabled empty-draft actions |
| Malformed input and recovery | PASS | Playwright uploads a rejected `.json`, observes the actionable UTF-8 `.txt`/`.md` error, then uploads valid Markdown and reaches `materials_ready` | Fatal invalid-UTF-8 bytes remain covered deterministically rather than through the native picker |
| Disconnect/reconnect during a run | PASS for fixture boundary | Playwright aborts the event stream, completes the HTTP workflow, restores the stream, reloads, and recovers the reviewed proposal | A slow live-model mid-run disconnect remains a live-environment gate |
| Two-tab stale correction and approval | PASS | One tab advances to v2 while a second tab has SSE blocked at v1; the stale correction fails closed with an alert and reload recovers v2 | Stale approval remains additionally covered by API/PostgreSQL contracts |
| Agent timeout and retry | PARTIAL | Controller timeout/retry and UI failure/retry states have deterministic tests | Browser timeout journey was not executed |
| Keyboard and status semantics | PARTIAL | Actual Tab traversal moved from reset → answer → correction → keep-unknown → accept, correctly skipped disabled actions, and Enter activated acceptance. DOM inspection also found no duplicate IDs, bound labels, one `h1` followed by `h2`/`h3`, and a polite live project-state region | Native file-picker traversal and screen-reader output were not recorded |
| Console and warmed performance | PASS | No application errors were observed; warmed local load measured 322 ms TTFB, 342 ms DOM ready, and 980 ms total in development mode | These figures are diagnostic, not a production performance claim |
| Reset and terminal boundaries | PASS | Reset restored an empty synthetic project; accepted state removed review controls and stopped the agent | None for the functional fixture path |

## Defect disposition

### QA-001 — submitted review drafts remained actionable

- Severity: medium.
- Reproduction: submit an answer or correction, then click the still-enabled
  action again without editing.
- Expected: a successful submission clears the draft and disables its action.
- Actual before repair: another immutable version was created with duplicated
  user content.
- Repair: clear the corresponding draft only after the server commits a
  successful action; clear both drafts on synthetic reset.
- Verification: both browser paths were repeated after repair and now have
  Testing Library interaction regressions. The fields were empty, both buttons
  were disabled, the console stayed clean, 77 deterministic tests passed, all
  five Playwright journeys passed, and the production build passed.

## Unclosed gates

Full assistive-technology review, a live-model timeout/disconnect journey, and
human acceptance remain separate.
