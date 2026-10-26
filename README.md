# Pitchroom

Application source: [pitchroom-app](pitchroom-app/README.md). Read [AGENTS.md](AGENTS.md) and [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) before work.

This source-only repository excludes environment secrets, database contents, participant records, local runtime data, archived history and raw QA. Numbered database migrations contain application schema, not local database contents.

Current delivery policy and inspection commands: [Pipeline](docs/development/PIPELINE.md), [machine policy](tooling/pipeline/policy.json). Foundation migration is integrated. Domain-free polling and one-lane runtime are governed by explicit local activation after independent verification; scheduled dispatch stays paused until activated. Follow the explicit migration sequence; engineering completion requires integration checks after approved merge. Product acceptance and deployment are separate.
