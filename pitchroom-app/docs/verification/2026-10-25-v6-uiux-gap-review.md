# Pitchroom V6 UIUX gap review after the first implemented loop

Reviewed on 2026-10-25 against the current uncommitted application and the isolated synthetic project at `http://127.0.0.1:3004/`.

## Current conclusion

The first loop now lets a consultant revise the audience, express a judgment, inspect actual story changes, explicitly adopt them, and trace the resulting Deck back to that work. These are implemented product behaviors with persisted state and real DeepSeek evidence.

The seven product problems are not all resolved. The largest remaining gaps are Clarify's attention design and topic behavior, continuity between destinations, guided strategic comparison, the meaning of Original framing, and a useful client-discussion finish. The work has improved most in Positioning and its connection to Deck. Materials and Clarify have not received an equivalent redesign.

The latest language rejection also remains open. The current demonstration contains Chinese narrative inside an English interface. The implementation infers output language from accepted Understanding instead of recording the user's intended artifact language. The earlier scoped engineering PASS does not establish acceptance of this English-language product experience.

## Scope and evidence rules

This document reconciles the user's seven-point UIUX critique and the attached earlier V6 requirement audit with the implementation after the first-loop work. It records current state, rather than authorizing another implementation batch.

Status labels have these meanings:

| Status | Meaning |
|---|---|
| Implemented and evidenced | The bounded behavior exists, with current source support and recorded execution evidence. This does not imply target-user acceptance. |
| Partial | A useful part exists, but the stated product outcome remains incomplete. |
| Not implemented | The inspected current path does not provide the behavior. |
| Not validated | Existing functionality or outputs do not establish the claimed user outcome. |
| Excluded | Explicitly outside this round's DoD. |

This review freshly inspected Materials, accepted Clarify, topic selection, return from Materials, the Story workspace, direction comparison, and Deck. Navigation and disclosure controls were used without submitting changes. No new model call, application repair, commit, recording, or target-user study was performed. Prior runtime evidence is identified separately below. The inspected project contains synthetic Atelier material, not real customer data.

V6 remains the product authority. Its unchanged HTML demonstrates an interaction direction, not an implementation specification for every internal object or a fixed five-page production contract. The current application has both a Story path and a legacy Positioning path. A capability in one must not be assumed to exist in the other.

## The seven product problems

### 1. The consultant's decision must organize the work

**Status: partial, with the main judgment-to-artifact mechanism implemented.**

The Story workspace now places the working narrative beside **What should change?**. A free-text judgment generates a complete candidate, not merely a stored note or a new title. The preview compares real audience, message, rationale, block wording, emphasis, and order changes. Apply adopts the reviewed candidate exactly. Keep preserves the prior work.

Recorded evidence shows a substantive judgment changing six candidate bodies relative to the previous story, including a newly separated trial invitation. Later human judgments corrected an overclaimed mechanism, drafting instructions, and shortened direct quotations. These failures and corrections remain in the evidence.

The broader workflow still requires the consultant to connect multiple operations. A background correction goes through a Clarify proposal, Apply, acceptance, direction generation or selection, Story development, Story adoption, and Deck creation. The application does not yet present that whole sequence as one continuous response to the consultant's intention. The Story panel also exposes saved-version identifiers and system roles such as `promise`, `mechanism`, and `rationale`.

The earlier claim that consultant input only becomes a note is outdated for the Story path. The wider claim that the consultant still manages parts of the processing flow remains valid.

Evidence: [Story workspace source](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/story-panel.tsx:15), [actual judgment preview](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/story-preview.json), [mechanical acceptance](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/mechanical-acceptance.json).

### 2. Four destinations must preserve one continuous task

**Status: partial. The return-and-revise capability exists, but thinking position is not preserved completely.**

Accepted Understanding now has a visible revision input. A proposal preserves the accepted version until Apply. Applying creates a reviewable version that requires separate acceptance. Revised context can inform new directions and a new Story. Deck can return to Positioning. Old Story and Deck versions remain available, and upstream changes mark saved work stale instead of overwriting it.

The latest inspection reproduced two remaining continuity failures. Selecting the governance topic did not change the global current question, which still asked about trial success. After navigating to Materials and back, selection reset to the first topic. The selected theme is local component state. Ordinary Deck page selection is also local state, rather than a saved reading position. Saved data surviving restart does not mean the user resumes the same destination, question, or page.

An accepted Clarify page now shows **Changes applied · understanding accepted**, so the old contradictory heading is fixed. However, the displayed historical explanation still says the proposal is waiting to be reviewed and applied. Current status and historical model explanation are not fully separated.

Evidence: [Clarify selection and task source](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:136), [Deck reading state](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:240), [accepted revision evidence](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/audience-accepted.json), [restart readback](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/restart-state.json).

### 3. Clarify must focus attention on understanding and one useful question

**Status: largely unresolved. Revision access improved; information architecture did not.**

The page still displays the previous clarification feedback, a summary formed by joining all theme summaries, the selected theme summary, the global next question, and all theme claims and quotations. The source-evidence disclosure is open by default. In the current project, five themes and six open questions appear in the overview before the consultant addresses the current task.

Selecting a theme changes its explanatory card and source anchor. It does not select that theme's question or answer task. Selecting a gap changes its description, while the same global `nextQuestion` remains below it. This preserves the original mismatch between the control's apparent purpose and its behavior.

The accepted version can now be revised, and the user's saved answer and proposed changes are attributed. These are useful fixes, but the compact overview, task-specific focus, progressive source disclosure, topic drafts, local attachments, and mobile-collapsed map are not complete. **Not sure yet** is still disabled in the accepted state.

Evidence: [current Clarify rendering](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:147), [always-open evidence disclosure](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:170), [V6 contextual-understanding design](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-v6/DESIGN.md:68).

### 4. Positioning must help the consultant choose how to tell the story

**Status: partial, with substantial improvement in the Story path.**

The current Story path defaults to the working artifact and the consultant's judgment. AI recommendation is behind a disclosure instead of leading the screen. **Compare directions** shows the original option and two alternatives together on desktop, including core messages, trade-offs, and expandable source support. The consultant can propose a substantive revision or preserve exact words separately.

The current sample distinguishes a suggestion-to-source mechanism from the moment of being challenged by a client. That is evidence of one interpretable comparison, not proof that generated strategic alternatives are consistently distinct across projects.

The current task is still the broad **What should change?** input. There is no contextual strategic question organized around the promise, price, or proof. Comparison cards do not show a concise shared From/To comparison, counter-evidence, or a shared current Context & gaps view. They leave the consultant to construct the comparison across separate texts. The old detailed Positioning path remains as a fallback, with different emphasis and controls.

**Original framing remains incorrect as a product label.** The converter joins accepted theme summaries and calls that the original expression. The current comparison renders this long summary as one option. It is neither a concise comparison baseline nor a faithful copy of the client's original wording. This gap is unchanged by adding a Keep button.

Evidence: [current direction comparison](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/story-panel.tsx:32), [legacy fallback routing](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:221), [Original framing construction](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/packages/agent/src/positioning-runner.ts:75).

### 5. The working artifact must be central, and judgment must visibly change it

**Status: the causal mechanism is implemented and evidenced; presentation remains partial.**

The Story paper now contains audience-facing narrative blocks rather than the former full direction analysis. Basis, rationale, and unknown details are available through disclosures. The preview shows actual before/proposed text, emphasis, page movement, additions, and removals. A fresh Deck deterministically copies the adopted Story's titles, bodies, emphasis, and order. A second model call cannot silently rewrite the adopted wording during Deck creation.

In the recorded example, the consultant's judgment led to a client-question opening and a separate final real-project invitation. Claim boundaries stayed visible. The final quote correction changed exactly two bodies while preserving all other content, eighteen bases, and six unknowns. The final saved Story content matches the reviewed candidate after local restoration.

The product still displays all Story blocks on one long paper, exposes internal role names, and repeats an exact-edit action per block. The preview can become a long list rather than a short explanation of the consequential changes. Mobile navigation now jumps to **Working story** or **Your judgment**, but it is not the V6 question/story view switch. Whether consultants can identify the important effect without explanation remains unvalidated.

Evidence: [Story paper and preview](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/story-panel.tsx:34), [exact Story-to-Deck projection](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/packages/domain/src/deck.ts:41), [semantic review](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/semantic-review-final.json), [final independent recorded-state audit](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/closing-audit.json).

### 6. Control must come from understandable consequences and recovery

**Status: safety and recovery implemented; action hierarchy remains partial.**

Apply preserves the reviewed Story exactly. Keep leaves the adopted Story and Deck unchanged. Undo restores the prior Story with a new generation. History can restore a saved version through another explicit local preview without another paid call. Deck creation states that title, body, emphasis, and order will be copied. Manual page edits create a new draft and do not inherit a claim of evidence approval. Stale command rejection and idempotent decision replay have recorded checks.

These are concrete improvements to control. The UI still requires **Preview story changes → Apply this story → Review deck inputs → Confirm adopted story & create deck**. After a context revision, earlier review and acceptance steps add to that chain. The creation checkpoint includes an internal version ID and generation. The consultant must understand which actions change the story and which only create another representation of it.

The separate boundaries should remain. Their hierarchy, explanations, and presentation have not yet been shown to make the sequence easy to understand. Repeated confirmation must not be counted as a usability improvement by itself.

Evidence: [Apply, Keep, Undo, and creation controls](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/story-panel.tsx:37), [replay and stale-write result](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/replay-and-stale.json), [Undo preserves the edited Deck](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/after-upstream-revision.json).

### 7. Deck must finish a useful client-discussion task

**Status: deliverable mechanics improved; intended-use finish and client usefulness remain unvalidated.**

New Story decks support three to eight pages, rather than the historical fixed five-page format. The inspected result has six pages, a concrete opening, a mechanism with limits, evidence boundaries, open questions, and a trial invitation. Each page can trace to the saved Story block, accepted Understanding, material, and attributed consultant judgment. Complete review, manual editing, read-only old drafts, and stale-state preservation work in the recorded loop.

The interface still ends at **Draft 4**, page navigation, edit controls, and history. It does not summarize the intended client decision, distinguish the few places needing consultant attention, or connect unresolved questions to the next discussion. A trial invitation in this sample's final page is useful content, but it is not a general completion experience.

No target consultant has established that the structure needs only minor edits before a client meeting. Output concision and exact source quotations cannot prove that outcome. The current Chinese result was also rejected as the intended language experience.

Evidence: [Deck interface](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:240), [saved final Deck](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/delivery-state.json), [visible trace evidence](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/final-deck-trace.txt), [V6 first-use outcome](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-v6/PRD.md:8).

## V6 requirement reconciliation

This table updates the attached earlier audit. It does not give the whole application a completion percentage.

| Requirement | Current status | What changed or remains missing |
|---|---|---|
| MAT-01 · File intake and inventory | Partial | TXT, Markdown, pasted material, inventory, removal, and recovery exist. The chooser still consumes one file. Broad consulting formats and extraction diagnostics are absent. |
| MAT-02 · Written brief | Partial | A paste draft survives destination changes and has a save boundary. Saved notes become another source, not one maintainable brief with direct edit and clear behavior. |
| MAT-03 · Topic and global material access | Not implemented for the topic relationship | Global inventory exists. No question-level attachment, topic association, or reciprocal link is present. Returning to Clarify loses the selected topic. |
| CLR-01 · Inspectable theme map | Partial | Actual themes and quotations exist. The full Context added, Left open, and pending topic-review model is not provided. |
| CLR-02 · Useful strategic questions | Partial | A grounded global next question and gaps exist. Clicking a theme does not select its task. No coherent revisitable set of three to five strategic questions is presented. |
| CLR-03 · Add context without blocking | Partial, improved | Accepted Understanding can now receive a proposed revision. Proposal review and Apply exist. Topic attachments, accepted-state Not sure, and full applied Before/Now recall remain missing. |
| CLR-04 · Preserve thinking continuity | Partial | Some parent-owned drafts survive destination navigation. Topic-specific drafts, selected topic, reading position, and reload destination continuity remain incomplete. |
| POS-01 · Distinct directions and original framing | Partial | Alternatives, trade-offs, source support, and a desktop comparison exist. Original framing is still an accepted-summary concatenation. Cross-project strategic quality is unvalidated. |
| POS-02 · Concrete effect of judgment | Core behavior implemented and evidenced; guided UX partial | Free judgment changes real narrative blocks, emphasis, and sequence. The current strategic-question structure, compact From/To, and shared Context & gaps are missing. |
| POS-03 · User control | Implemented and evidenced in the Story path | Preview, Apply, Keep, exact edits, Undo, history restoration, and Deck preservation exist. Original-wording semantics and action clarity remain broader product gaps. |
| DCK-01 · Direction-consistent discussion draft | Exact carry implemented; client utility not validated | Fresh V2 Deck copies the adopted Story exactly. Three-to-eight-page content is supported. A six-page synthetic result does not establish client readiness or general page-structure quality. |
| DCK-02 · Basic iteration | Core behavior implemented and evidenced | Page title/body edits create a new draft. Prior drafts are read-only and survive upstream change. Presenter-note and open-question editing, and ordinary reading-position continuity, remain limited. |
| X-01 · Preserve uncertainty and attribution | Implemented safeguards; semantic reliability partial | Source quotes, attributed human input, open gaps, review, and trace exist. Actual model runs still needed human correction of an overclaim and shortened body quotations. |
| X-02 · Four revisitable destinations | Partial, improved | Accepted context can now be revised. Saved downstream work survives. Re-entry still requires several manual transitions, and destination/task continuity is incomplete. |
| X-03 · Progressive disclosure and mobile readability | Partial | Story and Deck disclosures, responsive layout, and mobile Story jump links exist. Clarify still expands all evidence and does not provide the intended collapsed mobile map. |
| X-04 · Capability and lifetime boundaries | Partial | Runtime and text-format boundaries are indicated. Privacy, retention, provider-transfer explanation, export limits, and current documentation navigation remain incomplete. |

Requirement sources: [Materials and Clarify](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-v6/PRD.md:29), [Positioning and Deck](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-v6/PRD.md:64), [cross-section rules](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-v6/PRD.md:95). Current implementation sources are [workspace views](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/workspace-view.tsx:117), [Story controls](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/apps/web/lib/story-panel.tsx:15), and [Deck contracts](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/packages/domain/src/deck.ts:18).

## Language remains an open product defect

The current interface labels are English. The latest generated direction, Understanding, and Deck prose are Chinese. No artifact-language choice is exposed in the inspected Story or Deck flow.

The code does not literally use the chat language as its output setting. Positioning detects Han characters in the accepted Understanding's `nextQuestion`; Story instructions use that same question's language. This implicit heuristic failed to represent the user's intended English artifact. It must not be described as a completed language requirement merely because the Chinese output is internally consistent.

The product still needs a clear artifact-language contract that is independent of interface language and chat language. Evidence must then show the intended English story and Deck end to end, while retaining exact source quotations in their source language. This has not been rerun in this review.

Evidence: [Positioning language inference](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/packages/agent/src/positioning-runner.ts:95), [Story language instruction](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/packages/agent/src/story-runner.ts:18), and the user's explicit rejection after the previous acceptance report.

## Evidence boundaries and prior claims

| Claim | Current evidence and limit |
|---|---|
| Real AI and persistence exist | The previous campaign used 17 real DeepSeek provider requests on synthetic material. This review read those records and performed no new calls. |
| Judgment changes the artifact | Actual preview, exact adoption, and Story-to-Deck comparisons passed for the recorded loop. This is more than a prototype transformation. |
| Recovery protects work | Keep, Undo, old-draft preservation, stale state, restart readback, replay, and stale-write rejection have recorded checks. Fresh inspection in this review was read-only. |
| Engineering checks passed | The previous campaign recorded 408 tests, 23 PostgreSQL checks, typecheck, and seven browser regressions. Those counts are prior verification, not tests rerun for this document. |
| AI output is reliably good on first attempt | Not established. Retained outputs include overclaiming, drafting instructions, shortened quotations, and a format failure. Human judgments and retries were required. |
| The requested English experience is accepted | No. The user rejected the Chinese demonstration. The earlier semantic PASS covered that Chinese candidate, not the desired English product experience. |
| V6 UIUX is complete | No. The seven findings and requirement table above retain substantial partial and missing work. |
| Consultants will use the Deck with clients | Not validated by target-user observation or actual client use. |
| Production is ready | Not established. Identity, authorization, retention, backup, operational limits, and deployment readiness have not been accepted. The recorded Next.js security advisory remains open. |
| PDF or native assistive technology blocks this round | Excluded from this round's DoD. PDF import support is a separate Materials-format gap. |

The [previous campaign report](/Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/.artifacts/first-loop-20261025/acceptance-report.json) remains evidence of a repaired, scoped loop. Its PASS must not be reused as whole-product or English-language acceptance. The prior semantic and closing reviews used GPT-family models, not independent vendors.

## Remaining work, ordered by the user's task

These are proposed acceptance outcomes for a subsequent scoped implementation request. This review does not modify the application.

| Priority | Remaining outcome | Observable completion signal |
|---|---|---|
| First | Establish the intended artifact language | The consultant can understand which language will be used. An English-material or explicitly English project stays English through revision, Story adoption, and Deck creation. Source quotations retain their original wording. |
| Next | Make Clarify a focused understanding task | One short overview and one selected task lead the page. A topic selection opens that topic's question. Evidence opens on demand. Returning from Materials restores the topic and its draft. |
| Next | Help the consultant compare strategic choices | A shared comparison states what the audience remembers, what the consultant sacrifices, and the evidence or gap that could change the decision. Original client wording is genuinely preserved and distinguished from accepted interpretation. |
| Next | Make revision and return understandable | A consultant can start from a weak Deck page, revise the relevant understanding or judgment, see the impact, and return to a clearly identified new draft without reconstructing the processing sequence. Old work remains available. |
| Then | Give Deck a purpose-based finish | The artifact identifies the intended client decision and the few unresolved items requiring judgment. A target consultant can name necessary edits and explain how the structure will support the discussion. |
| Evidence-led expansion | Close the actual material and user-validation gaps | Support only the necessary agreed file formats, inspect extraction failures, and observe a consultant using authorized real material. Record what they keep, remove, rewrite, and later use. |

PPTX export, billing, team collaboration, multi-project management, and broad AI chat remain deferred directions under V6. They are not added to the current UIUX repair scope.

## Review provenance

The latest evidence source is the current dirty workspace, not HEAD. Existing uncommitted work and immutable V6 prototype evidence were preserved. Only this Markdown report was added for this request.

The document follows the technical-writing skill. The Prove It Works principle keeps current UI observations, source-supported behavior, prior recorded execution, and target-user acceptance separate. No completion percentage is assigned because these are different evidence levels.
