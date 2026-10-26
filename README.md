# Pitchroom

Application source: [pitchroom-app](pitchroom-app/README.md). Read [AGENTS.md](AGENTS.md) and [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) before work.

This source-only repository excludes environment secrets, database contents, participant records, local runtime data, archived history and raw QA. Numbered database migrations contain application schema, not local database contents.

The 2026-10-26 migration and PR pilot remain Draft and unmerged. Only one task lane is authorized. Legacy direct-main snapshot uploads are being retired in the pilot; do not use them to integrate feature work. Review and QA must identify the exact task commit. Main integration, product acceptance and deployment remain separate decisions.
