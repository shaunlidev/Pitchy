# Pitchroom

Application source: [pitchroom-app](pitchroom-app/README.md). Read [AGENTS.md](AGENTS.md) and [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) before work.

Portfolio draft: [case study, local demonstration, architecture, and verification boundaries](docs/portfolio/README.md).

This source-only repository excludes environment secrets, database contents, participant records, local runtime data, archived history and raw QA. Numbered database migrations contain application schema, not local database contents.

Current delivery instructions and the single read-only state entry: [Pipeline](docs/development/PIPELINE.md). Controller and status use the same validated policy/runtime loader. Actual scheduling remains paused, new admission defaults to paused, and parallel operation is disabled. Engineering completion requires human-approved Squash and verified main checks; product acceptance and deployment are separate.
