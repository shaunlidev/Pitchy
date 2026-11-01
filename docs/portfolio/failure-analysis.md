# A completed model response can still be a rejected revision

This explanation uses three dated reports whose original bytes remain local. The [evidence index](evidence-index.json) records their hashes and versions. Their results are historical observations, not a fresh model run.

## The rejected response

On 25 October, a real-model Story revision returned HTTP 200 with provider status completed. Its fifth body contained 47 whitespace-separated words. The application contract allowed 45.

The candidate entered the failed state with the message `Generated story exceeded the concise title or body limit.` The report records that the adopted Story was preserved and the failed candidate was not adopted. That is a successful rejection boundary, although the requested revision failed.

The report identifies source commit `7187085`, Story fix commit `008590a`, and prompt `story-v4-local-references` for this stage. Those identifiers describe the original local engineering history. They are not claimed as ancestors of the migrated canonical Git history.

## What the follow-up changed

The current [response contract](../../pitchroom-app/packages/agent/src/story-reference-contract.ts) encodes a maximum of 45 whitespace-separated words for generated bodies. It permits exact saved human bodies through a separate schema alternative. The [domain validator](../../pitchroom-app/packages/domain/src/story.ts) continues to enforce reference, quotation, unknown, and wording rules.

The system does not shorten a response after generation to hide a failure. Truncation could remove a qualification or change a claim. Aligning the generation schema with the product rule reduces one mismatch while retaining rejection as a final check.

The response contract also distinguishes local Story basis IDs from external Understanding basis IDs. An allowed ID vocabulary helps the model refer to the right namespace. Domain validation still requires each referenced local ID to be defined. An enum alone cannot establish that relationship or prove semantic support.

## What the later observation established

The later report identifies source commit `62b81e2` and prompt `story-v5-body-budget`. It records body lengths of 24, 34, 41, 35, and 43 words. It also records exact candidate adoption, exact Deck transfer, retained history, unchanged sources and Understanding, and persistent HTTP readback.

The semantic reviewer was the assistant, and adoption was synthetic. The report explicitly excludes browser validation, target-user acceptance, a fresh-from-empty full loop, and a reliability sample. It supports a bounded continuation result only.

Its initial report also read a nonexistent `deck.version` field where the response used `number`. Only a read-only GET was repeated. That reporting mistake remains part of the record. It was not another provider request.

## A different failure stopped full-loop acceptance

On 26 October, a separate run at `182ceab6cbb284f4f8b4fcb78a89db73002696a5` stopped after Understanding. The verifier looked for `pitchroom-app/.artifacts/...` while its working directory was already `pitchroom-app`.

The material import and first Understanding structural stage had completed. The planned semantic checker did not run. A subsequent driver timed out before submitting feedback, and the worker never started. Positioning, Story, revision, and Deck were not run.

That run has status `STOPPED_FIRST_HARNESS_FAILURE`. It does not establish a model or product defect at that stage, and it does not establish a complete English-loop pass. The old stop condition is not lifted by this portfolio task.

## The engineering lesson to defend

Provider completion, structural validity, domain validity, semantic quality, and user adoption answer different questions. A useful review can trace each conclusion to its actual output and version.

For an interview, explain why a limit belongs in both the response contract and domain rules. Then explain what neither check can prove: whether the recommended positioning is useful and whether its evidence supports its meaning. Shaun's personal explanation of that distinction remains to be observed.
