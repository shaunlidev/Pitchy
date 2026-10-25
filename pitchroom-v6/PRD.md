# Pitchroom PRD: positioning-to-deck loop

Document: `0.4-v6` · Target release: `0.1` · Updated: 2026-10-11.
Status: prototype baseline, provisionally accepted for now; sole starting point for a fresh implementation per the user's 2026-10-11 approval. Owner/reviewers: not assigned.

[Entry](README.md) · [Design](DESIGN.md) · [Evidence](EVIDENCE.md) · [Harness](HARNESS.md)

## Objective and audience

Help brand strategy consultants and consulting project leads turn scattered client material into a clear positioning decision, then a client-discussion presentation. Clients know their business but may not know what the audience needs to hear. Consultants need to externalize their judgment, compare alternatives, and translate the chosen story efficiently.

The desired first-use reaction is: **“This structure is ready to discuss with the client; I only need to refine it.”** The product should make existing strengths easier to understand. It does not guarantee investment, sales, or audience agreement.

The MVP centers on professional judgment plus a tangible deliverable. It is not a generic slide generator, an evidence-audit dashboard, or a full presentation editor. Multiple-project use is a retention hypothesis, not a validated subscription model.

## Core journey

Bring material → inspect understanding and fill useful gaps → compare and choose a positioning direction → generate, review and refine a discussion deck.

These are revisitable destinations, not a compulsory wizard. **Materials** owns intake and inventory. **Clarify** combines a compact theme map with one contextual question. **Positioning** turns judgment into a visible choice. **Deck** owns the generated deliverable and its revisions.

Status vocabulary below:

- **Demonstrated:** interactive behavior exists in the standalone mockup; not a production implementation claim.
- **Simulated:** curated sample data or transformations illustrate the intended experience.
- **Target only:** requirement retained from the user-authored PRD but not implemented here.

<a id="materials"></a>
## MAT: Materials

User story: “I want to bring my existing files and notes, see what is attached, and add or remove material without restarting.” Original PRD priority: **1**.

| Requirement | Acceptance criteria | v6 status |
|---|---|---|
| MAT-01: File intake and inventory | Select multiple files; see accepted items; remove and re-add them; show understandable errors without losing other items. Returning through Materials reaches the current inventory, not a new onboarding screen. | Demonstrated for file names and metadata. Upload/parsing is target only. |
| MAT-02: Written brief | Paste/edit/save/clear notes. Retain an unsaved draft when switching destinations. Ask the user to save before using changed notes in Positioning. | Demonstrated, tab-local. |
| MAT-03: Local and global material access | A file attached to a Clarify topic also appears in Materials and links back to that topic. Back to Clarify resumes the ongoing task. | Demonstrated. |

Target formats include PDFs, decks, documents, spreadsheets, notes, research and briefs. “Any file type” is an intake ambition, **not** a promise of universal parsing. Production format support, extraction diagnostics, limits and secure retention need a separate implementation decision.

Mockup-specific constraints: maximum 20 file names; each selected file must be non-empty and at most `20 × 1024 × 1024` bytes; duplicate names require removal before re-addition. No file contents are read. These are demo limits, not a released upload policy.

Design: [MAT](DESIGN.md#materials). Evidence: [MAT gallery](EVIDENCE.md#materials). Checks: `V6-C1`, `V6-C7`, `V6-C8`.

<a id="clarify"></a>
## CLR: Clarify

User story: “Show me what the material says, what is unclear, and the next useful question. Let me add context or leave it open.” Original priorities: **2** (clustering), **3** (questions).

| Requirement | Acceptance criteria | v6 status |
|---|---|---|
| CLR-01: Inspectable theme map | Group actual material into useful themes. Each theme links to supporting excerpts/references; an excerpt can support multiple themes. Do not fabricate coverage or treat a new attachment as reviewed. | Map and source access demonstrated with five fixed sample topics; automatic clustering is target only. |
| CLR-02: Useful questions | Target 3–5 project-grounded strategic questions from contradictions, gaps or unresolved choices. Explain why each matters; accept free text. Exclude ungrounded generic discovery questions. Show one current task, not an obligatory questionnaire. | Curated topic prompts in Clarify and three fixed strategic prompts in Positioning. No dynamic question generation. |
| CLR-03: Add context without blocking | Answer, correct the current understanding, optionally attach relevant material next to the question, or choose Not sure yet. Missing information does not block positioning. Show saved Before/Now feedback. | Demonstrated. Literal notes and corrections are attributed, not verified. |
| CLR-04: Preserve continuity | Keep topic drafts when navigating away. Resume the question, correction or feedback state on return. Prompt before carrying unsaved text forward. Preserve notes when restoring sample sources. | Demonstrated within the tab. |

Coverage labels distinguish **Material available**, **Needs context**, **Not provided**, **Context added**, **Needs review**, and **Left open**. They are not quality scores or completion percentages. An attachment awaiting review takes precedence over a reassuring status.

The sample starts with three covered topics, one partial topic and one missing topic. Clarify's contextual questions and Positioning's decision questions serve different jobs; the product's 3–5 question target does not mean the user must finish both screens as separate forms.

Design: [CLR](DESIGN.md#clarify). Evidence: [CLR gallery](EVIDENCE.md#clarify). Checks: `V6-C2`, `V6-C4`, `V6-C5`, `V6-C6`, `V6-C8`.

<a id="positioning"></a>
## POS: Positioning

User story: “Help me compare defensible choices and see how my judgment changes the story, without taking the decision away from me.” Original priority: **4**.

| Requirement | Acceptance criteria | v6 status |
|---|---|---|
| POS-01: Distinct directions | Offer 2–3 materially different directions, each with a core message, supporting material/input and a stated trade-off or exclusion. Retain the client's original framing as an option. | Three curated alternatives plus the original. Real synthesis is target only. |
| POS-02: Concrete effect | Show what the business was being understood as and what the proposed expression changes. Keep the working artifact visible while making a judgment. A headline rewrite alone is insufficient if the strategic choice is unclear. | Demonstrated for sample choices; no automatic transformation of arbitrary context. |
| POS-03: User control | Separate preview from applying a change. Allow adjustment, keeping original wording, and undoing the latest applied positioning change. Do not silently replace a saved deck. | Demonstrated. Custom text can be a judgment note or an exact headline, never mislabeled as AI rewriting. |

Directions remain proposals, not verified market facts. Supporting excerpts, consultant interpretation and generated wording must remain distinguishable. Context & gaps stays accessible while comparing choices. Selecting a preview is not approval; **Use this change** applies it, and **Use direction & create deck** creates a separate draft.

Design: [POS](DESIGN.md#positioning). Evidence: [POS gallery](EVIDENCE.md#positioning). Checks: `V6-C3`, `V6-C6`, `DOC-POS`, `DOC-COMPARE`.

<a id="deck"></a>
## DCK: Deck

User story: “Turn my selected direction into a coherent first deck, then let me review and refine it before using it with a client.” Original priority: **5**.

| Requirement | Acceptance criteria | v6 status |
|---|---|---|
| DCK-01: Direction-consistent output | Generate a fixed-format deck from the explicitly chosen working direction. Include positioning, rationale, evidence and open questions. Review the complete deck before sharing/exporting. | Five prestructured pages demonstrated. Real AI generation and portable export quality are not validated. |
| DCK-02: Basic iteration | Edit a page, save a new draft, inspect prior versions read-only and return to the current draft. New source/positioning changes warn that the old deck is unchanged. | Demonstrated; not durable storage or a full editor. |

Sample page order: **Positioning → Shift → Rationale → Evidence → Open questions**. Five pages is a mockup choice, not a settled production page count. User context/corrections appear as attributed input; unreviewed attachment names and unresolved claims remain visible rather than invented away.

The mockup offers browser Print / save PDF after review. PDF pagination/fidelity is unverified. No PPTX export, hosted sharing, or cloud-drive integration exists in this artifact.

Design: [DCK](DESIGN.md#deck). Evidence: [DCK gallery](EVIDENCE.md#deck). Checks: `V6-C3`, `V6-C4`, `DOC-DECK`.

<a id="boundaries"></a>
## Cross-section requirements and boundaries

| ID | Rule |
|---|---|
| X-01 | Never turn missing evidence, a file name, a consultant opinion or a generated claim into a verified fact. Unknowns may remain open. |
| X-02 | Keep Materials, Clarify, Positioning and Deck independently reachable. Deck is unavailable until a draft exists. Navigating is not resetting. |
| X-03 | Keep work readable on desktop and mobile; use progressive disclosure instead of stacking all content. Preserve inputs while changing view. |
| X-04 | Mark simulation, local-session lifetime and export limitations in the interface. No real client data or external AI call is needed to evaluate this mockup. |

Current runtime: self-contained HTML, embedded fonts, deterministic fictional Northwind sample, JavaScript in-memory state. Reload resets everything. There is no backend, real file upload, parsing, AI model, account, multi-project persistence or payment flow in v6.

Deferred beyond this loop: broad AI chat editing, durable preference memory, team collaboration, extra output formats, billing and multi-project workspace management. They remain possible directions, not requirements to implement as part of this documentation task. Capabilities in the archived application are not automatically requirements for the rebuild.

## Success measures and validation

The user-authored PRD targets remain **hypotheses**, with no measured results in this package:

| Target | Measurement definition to agree before testing |
|---|---|
| 70% complete the workflow | Proposed: target users who reach a reviewable deck / target users who start a project in the observed cohort. Record assistance and abandonment separately. |
| 50% would use it again on a real project | Proposed: ask participants after trying the loop; report all respondents and nonresponses. Intent is not actual reuse. |
| 10 paying users within 3 months | Agree the clock start, unique customer definition, payment evidence and refund treatment. No pricing or acquisition model is validated. |

First-use review should observe: can the consultant explain the strategic difference, retain a direction, identify necessary edits, and use the deck structure for a client discussion? Record what they changed and where they needed help. Treat actual later client use and second-project return as separate evidence, not inferred from a saved deck.

Milestone sequence: interaction baseline → real-material ingestion/synthesis decisions → one complete implemented loop → observed consultant test → private beta decision. The earlier week-by-week PRD schedule was illustrative; there is no newly committed launch date here.

<a id="open-decisions"></a>
## Decisions required before production implementation

1. Design a new implementation for v6's four destinations and black/orange interaction baseline. Choose architecture, persistence, source lineage and approval behavior explicitly; reuse of the archived code or data model is not required.
2. Choose the production deck structure and length from the client-discussion goal. Five pages is the mockup example; the archived eight-slide contract is not a constraint.
3. Choose supported file formats, extraction failure states, AI/provider authorization and retention policy. The mockup does not settle them.
4. Validate synthesis quality on authorized real material. Curated sample attractiveness cannot establish generated positioning quality.
5. Assign product owner/reviewers and approve measurement cohort, thresholds and launch gates.

These are recorded gaps, not permission to implement or expand scope. Next changes need an explicit target and applicable acceptance criteria.
