# Security and privacy boundary

## Trust model

- Pasted and uploaded material is hostile data. Text that resembles system or
  developer instructions is never promoted into the agent instruction channel.
- The model proposes an understanding. Deterministic code validates its schema,
  exact-quote provenance, budgets, state transition, and approval boundary.
- User corrections remain `user_asserted`; they are never relabelled as source
  evidence.
- Only the current `review_required` revision may be accepted.

## Implemented controls

- Accepted inputs are UTF-8 text and Markdown with explicit size limits.
- Source and chunk access is scoped by project in repository queries and tools.
- Exact quotes must occur in the referenced chunk.
- Model steps, tool calls, repeated calls, failures, and wall time have bounded
  contracts.
- Command receipts prevent idempotency keys from being reused for different
  material.
- Logs/artifacts redact fields resembling keys, authorization headers, tokens,
  secrets, and passwords.
- API responses are non-cacheable and carry request IDs.
- Live mode fails readiness checks without a database URL, API key, and pinned
  model.

## Deployment blockers

Fixture mode uses one synthetic local actor and is not an authentication system.
Before deployment with real users, the following are mandatory:

1. authenticated actor identity and per-project authorization;
2. CSRF/origin policy appropriate to the chosen authentication mechanism;
3. provider data-transfer, retention, and deletion policy;
4. encrypted secret management and database transport;
5. rate limits and cost ceilings at the ingress and model boundaries;
6. security review of the selected hosting topology;
7. tested account/project deletion and backup retention behavior.

No current check or fixture result clears these blockers.
