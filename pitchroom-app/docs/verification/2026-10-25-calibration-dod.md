# Calibration repair and live acceptance — 2026-10-25

User-approved scope supersedes the earlier PDF/native-tool blocker. PDF export and assistive-technology checks are deferred, not passed. No commits. Existing history, raw runs, original eight Clarify cases and Core Message judging criteria remain unchanged.

## DoD (frozen before new live calls)
1. Shared Core Message schema/prompt/validation is used by web and standalone eval; one of each lens, <=12 English words, grounded citations, explicit comparison/recommendation and reconsideration conditions retained.
2. Two directions express substantively different leading judgments (product behavior versus supported human tension), reviewed on actual output; no forced winner or quota. Mechanism, source grounding and original framing remain in both.
3. An English project produces English generated prose through Understanding, Clarify, Positioning and Deck. Chinese original cases retain their language and grading. Literal quoted sources and saved user answers are preserved.
4. Deck has exactly five ordered pages, exact applied Core Message in its lead headline, <=45-word English body per page, concise titles, distinct page roles; longer qualifications in inspectable speaker notes/evidence; unknowns and attribution preserved. Human editing/history/undo remain possible.
5. Existing-project Add files -> invalid input -> reachable recovery -> valid file upload succeeds without reload, preserving saved project content.
6. Relevant new regressions, original tests/graders, typecheck, build and isolated PostgreSQL checks pass at their stated scopes; existing browser journeys plus new modal recovery pass.
7. Real deepseek-flash browser chain uses actual applied prior state: Materials -> Understanding -> saved Clarify answer -> review/Apply/Accept -> Positioning preview/choice/Apply -> explicit Deck generation -> all-page review/edit/history/restart. Capture actual responses, output hashes, usage and assistant semantic review locally. Never count a mock, replay or schema check as live semantic evidence.
8. Inspect desktop/mobile rendering and leave the live app open with the new artifact. State failures/limitations honestly. PDF and assistive technology do not block this round; customer/human rubric acceptance is not inferred.

## Files scoped for repair
Agent shared core-message contract + positioning runner; Clarify compiler/context; Deck runner/domain optional speaker notes; web Deck notes and upload modal; relevant tests and verification entries. No archived application or immutable prototype edits.

## Results
Completed for the user-approved five repairs and real-model synthetic-material engineering acceptance. PDF/assistive technology remain deferred. Original criteria were retained; automated keyword caveat is explicit below.

## Observed repairs and regression status
- Shared production/eval contract now enforces the original two lenses, <=12-word/100-character slogans, citations and explicit comparative recommendation. Inputs retain current summary grounding and unreviewed-user-edit cautions. Offline wire fixtures were upgraded to the new production protocol; original eight case criteria and judging regexes remain byte-identical.
- Compiler chooses generated language from the current question, while literal quotes and user answers remain unchanged. Detailed applicability is stored in grounding and inspectable separately; differences and evidence stances remain visible rather than hidden by the shorter summary.
- Deck carries optional persisted speakerNotes for backward compatibility; live generation requires notes, short body, exact applied headline, distinct page jobs and audience-facing prose. Human-edited/original headlines are preserved even when longer than generated-title limits.
- Upload Add files modal closes after a local file rejection. Actual live invalid-file -> Review -> valid Markdown passed without reload and preserved original material. New page regression and new seventh Chrome E2E both passed.
- Initial full regression: 384 tests/typechecks passed, build stopped on existing security notice; standalone retry passed. PostgreSQL 16/17 initially passed; the remaining old compiler test hard-coded Chinese for an English project. Its same post-activity/persistence assertions now use an English activity/expected phrase; targeted PostgreSQL suite 7/7 passed afterward. This changes a locale fixture, not the original case standards.
- First new live Understanding output was rejected for existing 1000-character publicSummary cap. Wire schema omitted that cap. Added identical maxLength and explicit concise-summary instruction, preserving local validation; targeted tests 11/11 passed. Failed response preserved.
- Original-eight live rerun first candidate set exposed a wording concern in case 6: source metadata correctly marked user report, but summary directly said procurement gave a standard. Calibration now explicitly requires visible reported-speech attribution in the summary. This candidate will not be counted as semantic acceptance; fresh same-standard revalidation required.

## Final acceptance
- Actual browser chain on `http://127.0.0.1:3003` used isolated PostgreSQL `calibration_qa`, real `deepseek-flash`, the same synthetic Atelier packet, and a saved English answer. Proposal review, Apply and Accept were separate. Pending Clarify did not overwrite accepted state.
- Mechanism headline: “Recommendations trace back to exact client interview quotes.” (8 words). Human-tension headline: “Defend recommendations with exact client interview quotes.” (7 words). The first leads with traceability; the second leads with defending a claim in a client meeting. Evidence, tradeoffs and reversal conditions remain inspectable. Model recommended mechanism for procurement fit; QA explicitly selected the nonrecommended human direction without rewriting its slogan.
- Real five-page Deck preserved that exact applied headline. Original body word counts: **13 / 20 / 25 / 21 / 19**, versus the previous wordy meta-prose. Presenter notes retain procurement fit uncertainty, sample limitations, review status, unsupported 50%, unagreed 20%, unknown baseline/budget/region/reviewer and four-week suggestion. All cited quotes match the uploaded source text. Exact accepted Understanding and applied Positioning IDs match Deck upstream IDs.
- Edited page 2 in the UI and saved Draft 2. Draft 1 remained read-only with its original body. Process restart plus reload returned an identical persisted workspace snapshot (including materials, answers, applied direction and both drafts). Hard reload opens Materials, not the previously viewed Deck page; reopening Deck restored both versions. No claim of persisted navigation selection.
- Chrome rendered all five pages at 1280×800 and 375×812. Full-page screenshots reviewed: no clipped text; 375px document scroll width is 375px and each article is 335px. Presenter notes expand on mobile. IAB override was ineffective (actual 555px), so dimension claims use Chrome evidence only. Overrides reset; local Deck tabs left open.
- Two additional real production-runner probes (local service and creator tool) returned distinct behavior/human-situation headlines. Both recommended mechanism with explicit reasons and counterconditions. This is limited cross-category evidence, not statistical proof of recommendation neutrality or a second full web journey.

## Original eight — standards unchanged
All eight final responses were inspected against the original semantic criteria, including literal source/user provenance, scope, unknowns, withdrawal and conflict. The original cases file SHA-256 is `bc5f3398aa1197297fbe36f1f1e396c09441bdc3412dda72c7a54db32ae47b5f`.

Final case 6 visibly says “用户转述采购负责人设定的试点成功标准…”, fixing the first candidate's direct-attribution wording. Final case 7 says “采购负责人并未答应，因此不作为试点成功标准…未确定”, and supersedes the earlier assertion while retaining history. Its original `required_meaning_markers` regex is **false** because it recognizes neither “并未答应” nor “未确定”. This false result is preserved, with no regex edit or resampling to chase keywords. Thus: eight assistant semantic reviews meet the criteria, **not eight automatically green cases**, and no human/customer acceptance is inferred.

## Verification at actual scope
- Latest typechecks and **385** deterministic tests passed: domain 26, testkit 3, agent 152, evals 128, web 76.
- PostgreSQL: 10 repository/clarification checks passed on isolated calibration DB; 7 structural checks passed on their required dedicated `clarify_qa` DB. An attempted structural run against calibration DB was rejected before tests by its isolation guard; preserved as such.
- Browser fixture regressions: **7/7** passed, including existing-project invalid-file modal recovery followed by valid upload. These prove UI mechanisms, not model quality.
- Production build standalone retry passed. Aggregate `pnpm check` ran typechecks/tests successfully, then stopped on an existing Next.js security notice; the aggregate command is **not reported green**. No dependency upgrade was included.
- `git diff --check` passed. No commit, push, deployment, archived-code restoration, prototype edit, grader weakening or raw-evidence deletion.

## Evidence and limits
Local raw evidence: `.artifacts/fullflow-calibration-20261025/`. `final-audit.json` contains input/output-linked reviews, actual invariants and usage; `provider.jsonl` retains 40 requests/40 responses, including rejected candidates and probes; `restart-state.json` and `deck-edited-live.json` are byte-content-equivalent parsed workspace states. Failed first Understanding/case candidates and command failures remain preserved. Screenshots: `deck-chrome-desktop.jpg`, `deck-chrome-mobile.jpg`, `deck-final-visible.jpg`.

Campaign usage: 262,506 input + 58,140 output = 320,646 tokens. Estimate at configured $0.30/$1.20 per million: **$0.14852**, not a provider invoice; includes rejected candidates and cross-category probes. Evidence-cap and key-byte scan results are in `safety-audit.json`; all raw QA stays local. PDF/native assistive technology are excluded/deferred. Synthetic material plus assistant review does not establish real-user demand, production readiness or human quality acceptance.
