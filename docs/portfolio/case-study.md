# Pitchroom: a positioning choice before a presentation

Status: portfolio draft, 1 November 2026. Product direction and review were led by Shaun. Coding agents assisted implementation. The repository alone does not establish which engineering work Shaun can perform independently. See the [contribution record](contribution-and-interview.md).

## The user problem

A brand strategy consultant can have interview notes, product claims, and a draft brief without a defensible story. The difficult decision is what the audience needs to understand and what to leave out. Generating more slides does not settle that decision.

Pitchroom's product hypothesis is that comparing grounded positioning choices can help a consultant express value that is difficult to articulate. The working artifact is a discussion draft. Consultant adoption and later client use require observation.

## The product decisions

The v6 design separates Materials, Clarify, Positioning, and Deck into revisitable destinations. The consultant can inspect sources and leave missing information unresolved. Navigation does not approve a proposal.

Positioning offers different judgments with tradeoffs. A recommendation explains why one direction wins and what would change that recommendation. The consultant can reject it, keep the original framing, or use exact wording. Preview and Apply are different actions.

The Story step develops the chosen direction into an argument. A proposed revision remains separate from the adopted story. Creating a new Deck copies the adopted Story rather than asking another model to reinterpret it. Manual edits produce another draft and retain history.

These choices add review steps. They also make it possible to inspect what changed and retain a previous decision. The design trades some speed for control over meaning and authorship.

## The implementation approach

The application uses Next.js for the web interface and HTTP routes. Shared domain contracts validate proposals and version transitions. An agent layer connects deterministic or live runners. Persistent modes use PostgreSQL repositories, and persistent Clarify tasks use a separate worker.

The [architecture explanation](architecture.md) follows one path from source material to an adopted Story and Deck V2. The portfolio demonstration uses the fixture runtime. It does not exercise PostgreSQL, a persistent worker, or a real provider.

## A failure that shaped the contract

A recorded real-model Story revision returned a 47-word body against a 45-word limit. The application rejected that candidate and preserved the adopted story. Provider completion was therefore different from an acceptable product result.

The follow-up added the body constraint to the model response schema while retaining domain validation. Exact saved human wording received a separate preservation path. The application did not truncate a model response to make it pass.

A later recorded revision passed a bounded continuation and exact Story-to-Deck transfer check. That observation does not show that the first attempt succeeds consistently. A separate full English-loop attempt stopped at a verification script path error. The [failure analysis](failure-analysis.md) preserves those distinctions.

## What the evidence supports

The current fixture walkthrough can demonstrate proposal review, an explicit choice that differs from the recommendation, Story adoption, and downstream version behavior. Its output is scripted and synthetic.

The dated reports provide evidence of specific real-model responses and recovery checks on their recorded versions. Their raw files stay local. They do not establish a current-version full English-loop pass.

There is no independent consultant-use result in this package. There is no supported claim about revenue, time saved, overall model reliability, or production operation. The next useful product evidence is an observed real task with a target consultant, including edits, rejection, assistance, and later use.

## What this project can contribute to an interview

The project provides concrete material for discussing proposal contracts, human approval, source attribution, and failure handling in an AI application. The strongest discussion starts with one actual failure and the checks that support its resolution.

Shaun still needs to explain that path and complete the personal exercise in the [interview review](contribution-and-interview.md). Until then, the documents describe project evidence and product direction rather than claiming independent engineering mastery.
