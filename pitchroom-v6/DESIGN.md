# Pitchroom v6 design reference and rationale

Scope: [v6 standalone HTML](prototype/index.html), unchanged by this documentation task. Updated: 2026-10-11.

[Entry](README.md) · [Product requirements](PRD.md) · [Screenshots](EVIDENCE.md) · [How to verify](HARNESS.md)

## Design intent

The user liked the black/orange version's strong headings, clear regions and brand-strategy-tool character. The problem was not just styling: Materials combined upload, interpretation, theme inspection and questions, so the page asked the user to do too much at once.

The answer is four **revisitable destinations**, with progressive disclosure inside each. Themes and their questions stay together in Clarify. Upload management gets its own stable home. Positioning and Deck share the same light paper treatment, so the work does not jump between unrelated preview styles.

## Decision record

| Decision | Reason | Trade-off |
|---|---|---|
| D-01: Four peer navigation items, no step numbers | Materials always returns to files; Clarify resumes thinking. Neither means starting over. | One more destination than v5; mitigated by clear names and direct return links. |
| D-02: Compact topic map + one question | Show available context without making users read a large theme dashboard before answering. | Less at-a-glance detail; excerpts and rationale open on demand. |
| D-03: Large persistent paper + focused task in Positioning | The judgment's effect should be visible, not buried in a chat transcript. | Long text needs a reading layout and vertical scrolling. |
| D-04: Preview, apply, then create a draft | Users decide what changes and keep control over existing work. | Additional explicit actions; avoids accidental deck replacement. |
| D-05: Uncertainty is allowed | A useful presentation can still contain open questions. Evidence supports expression rather than becoming the product's main axis. | Some claims remain hypotheses; attribution must remain visible. |

V3 combined the preferred visual language and interaction logic. V4 added coverage and contextual upload but overloaded Materials. V5 reduced density yet made the Materials destination ambiguous. V6 separates Materials from Clarify while preserving their shared state. All earlier HTML files remain available.

## Visual reference

These are the **v6 baseline's** roles for the fresh implementation. The former application's root DESIGN.md is archived and does not constrain the new design.

| Role | Value / behavior |
|---|---|
| Workspace / task surface | `#0d0d0f` / `#171719` |
| Primary text / muted text / divider | `#f5f3ee` / `#aaa8a6` / `#343436` |
| Primary action and active accent | `#ff5c35` |
| Artifact paper / ink | `#f7f4ee` / `#272b24` |
| Typeface | Embedded IBM Plex Sans, regular and bold, internal family `Pitch Sans`; no remote font requests |
| Base text | 15px / 1.5; headings bold with tighter spacing |
| Shape | Main controls/panels use 8px radius; paper is 3px, not a rounded dashboard card |
| Desktop frame | Max width 1384px; main padding 32px 40px 48px; header 68px; navigation 54px |
| Working paper | Normally 16:9, minimum height 400px; longer content switches to natural-height reading layout |
| Mobile | At ≤760px, single-column tasks, 20px side padding and on-demand overview/artifact |

Orange marks action or focus, not every paragraph. Warm paper is the client-facing work. Dark surfaces are the workspace. Do not add a third preview color, decorative metrics or permanent explanatory cards.

<a id="materials"></a>
## MAT: intake and material library

```text
[ Brand / project                                           ]
[ Materials | Clarify | Positioning | Deck                   ]

Fresh project                     Existing project
Start with what you have.         Your project materials. [+ Add files]
[ one drop zone           ]       [ file / status / remove            ]
Or paste what you know            [ linked topic when applicable      ]
Open sample project              > Written brief
                                  [ Back to Clarify                   ]
```

The initial screen has one dominant intake action, an optional paste area and a clearly separate sample entry. After intake, Materials becomes a narrow inventory (maximum 960px), not a repeated welcome screen or a coverage dashboard.

Show each file as an independent row. A topic attachment has a direct link back to its Clarify question. The written brief is collapsed until needed; its saved/unsaved state is explicit. Keep Add files and Back to Clarify easy to find. Do not embed the topic map or all questions here.

States: empty, file list, paste draft, inline file error, saved/dirty brief. Errors retain valid items. Clearing and saving the brief removes it from the saved context. File removal may downgrade coverage and make an existing deck stale.

Reference: [MAT screenshots](EVIDENCE.md#materials), requirements `MAT-01`–`MAT-03`.

<a id="clarify"></a>
## CLR: contextual understanding

```text
[ compact project map ]  [ What we understand so far  / Correct this ]
[ Customer needs      ]  [ one current topic and question            ]
[ Product & offer     ]  > Why this matters / source excerpts
[ Alternatives        ]  [ free-text answer                         ]
[ Buying moment       ]  > Add related material
[ Reasons to believe  ]  [ Not sure yet ]                [ Save context ]
[ Manage materials    ]  [ Go straight to positioning                ]
```

The map is orientation, not a second task list. Selecting a covered topic shows its supporting details; selecting a gap opens its question. Use short status labels, not a completeness score. Pending attachments remain **Needs review**, even when written context exists.

Save replaces the question with **Before / Now** feedback and one next action. This feedback says the context was recorded; it does not claim the sample positioning has been regenerated. The user may revise, answer the next useful question or move to Positioning with open topics.

Rationale, source excerpts and scoped upload are disclosed only when needed. “Correct this” edits the system's current understanding without pretending the correction is verified evidence. On mobile the project overview is collapsed by default and closes after selecting a topic.

Navigation to Materials retains the active topic, answer draft and correction/feedback state. Top-level Clarify resumes that state. Entering Positioning checks unsaved notes/brief/correction first. Do not turn the four destinations into a mandatory questionnaire.

Reference: [CLR screenshots](EVIDENCE.md#clarify), requirements `CLR-01`–`CLR-04`.

<a id="positioning"></a>
## POS: judgment beside the work

```text
MAKE THE CALL.                                [Compare directions]
[ working paper / proposed wording        ] [ current strategic question ]
[                                        ] [ finding + source access    ]
[                                        ] [ judgment / preview / apply ]
[ From being seen as | To understood as   ] [ next action                ]
[ Sources / Keep original / Undo          ]
```

The large left paper remains the visual reference. The right side has one current job: answer, inspect a proposed change, or continue after applying it. The three strategic tabs are The promise, The price and The proof. They are revisitable, not all mandatory.

The explicit From/To comparison expresses the change in audience understanding. Three direction cards compare strategic choices and trade-offs, not three decorative headline styles. Opening or previewing a direction does not apply it. Original client wording stays available.

Custom text follows an honest fork: preserve it as a judgment, or use the exact words as a headline. No polished sample is silently substituted for arbitrary input. Price/performance boundaries remain visible when relevant.

On mobile, Current question / Working story switches views without changing the underlying choice. Longer text uses natural-height paper rather than clipping or shrinking it into unreadability. Desktop screenshots may be taller than one viewport; they are not evidence that every action fits above the fold.

Reference: [POS screenshots](EVIDENCE.md#positioning), requirements `POS-01`–`POS-03`.

<a id="deck"></a>
## DCK: reviewable discussion draft

```text
Northwind / Discussion deck                   [Revisit positioning]
[ same light paper, current page          ] [ Edit this page         ]
[                                        ] [ Review complete deck   ]
[                                        ] [ Print / save PDF       ]
[ 1 Positioning | 2 Shift | 3 Rationale | 4 Evidence | 5 Open questions ]
                                           [ Draft history           ]
```

The work stays on the same paper treatment; the right panel now offers deck actions. Page navigation, complete review and revision number identify what is being viewed. Older versions are read-only. Manual editing creates a new draft, not an invisible overwrite.

If material or positioning changes, show a stale warning: the saved deck is unchanged. Regeneration is an explicit action from Positioning. Print opens full review first; the existence of a print button does not establish export fidelity.

Reference: [DCK screenshots](EVIDENCE.md#deck), requirements `DCK-01`–`DCK-02`.

## State contract for the mockup

This is a description of the HTML's state, not a new server API or migration plan.

| State group | Key fields / behavior |
|---|---|
| Destination | `stage`: `source`, `context`, `positioning`, `deck`; nav labels differ from internal names |
| Material | `files`, `briefDraft`, `brief`, `sourceVersion`, `intakeReady` |
| Context | `gap`, `contextDrafts`, `contextNotes`, `contextOpen`, `summaryDraft`, `summaryOverride`, `contextPanel` |
| Positioning | `answers`, `saved`, `direction`, `pending`, `revision`, `undo`; undo retains up to 12 positioning snapshots |
| Deck | `versions`, `viewVersion`, `page`; draft records include `revision`, `sourceVersion` and five `pages` |

`pending` affects only the proposal. Applying changes the working direction/revision. Generating copies it into a new deck version. A deck whose recorded source/revision differs from current state is stale, not overwritten. All state is in memory and disappears on reload.

## Preserve during later implementation

Keep the four destinations, optional unknowns, provenance labels, direct source access, explicit preview/apply boundary, original-framing option, manual revision/history and visible before/after. Design production approval, data isolation and storage safeguards for the fresh implementation; v6's lightweight state does not demonstrate them, and the archived app's implementation is not prescribed.

Verification coverage and omissions are in [Evidence](EVIDENCE.md); execution limits and retrieval recipes are in [Harness](HARNESS.md).
