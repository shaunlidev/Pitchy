# Browser QA matrix

Last run: 2026-10-14

Environment: isolated synthetic fixture at `127.0.0.1:3002`, Chromium controlled
without screenshots, video, trace recording, external model calls, or user data.

Status values are `PASS`, `FAIL`, `PARTIAL`, and `NOT RUN`. Functional browser
evidence does not substitute for visual review or human acceptance.

| Journey | Status | Evidence | Remaining boundary |
|---|---|---|---|
| Paste supported source, run, inspect citation, accept | PASS | Source inventory, stable chunk reference, exact quote, ordered trace, explicit acceptance, and terminal stopped state were observed | Pixel-level presentation not reviewed |
| Upload `.md`, create conflicting sources, preserve conflict | PASS | Two local Markdown fixtures were uploaded; the agent read both chunks, produced one `conflicting` claim with two exact quotes, asked the user which source is current, and `Keep unknown` created a new version without selecting a winner | Pixel-level presentation not reviewed |
| Keep an unknown and create a version | PASS | `Keep unknown` created version 3 and retained the unresolved gap without inferred evidence | Human usefulness judgment remains open |
| Correct a claim and inspect attribution/history | PASS | Corrected claim became `user asserted`, source attribution was removed, and version history advanced | Expanded history presentation was not visually reviewed |
| Answer the open question | PASS | Answer created an attributed user claim while preserving the source-backed claim | Human usefulness judgment remains open |
| Repeated answer/correction submission | PASS after repair | Browser reproduced stale draft text creating duplicate versions; successful answer/correction now clear their drafts and disable their submit buttons | Covered by browser revalidation; no component DOM runner is installed |
| Malformed input and recovery | PARTIAL | Empty submit is disabled and deterministic/API invalid-input tests pass | Browser file-decoding error recovery was not executed |
| Disconnect/reconnect during a run | NOT RUN | SSE reconnect contract tests pass | Synthetic browser run completes too quickly for a meaningful manual disconnect |
| Two-tab stale correction and approval | NOT RUN | PostgreSQL/API stale revision contracts pass | Browser two-tab race was not executed |
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
- Verification: both browser paths were repeated after repair. The fields were
  empty, both buttons were disabled, the console stayed clean, 67 deterministic
  tests passed, and the production build passed.

## Unclosed gates

Screenshot-based responsive/pixel review, full assistive-technology review,
the remaining browser journeys above, and user acceptance are intentionally not
reported as passed.
