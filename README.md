# Pitchroom

Application source is in [`pitchroom-app/`](pitchroom-app/README.md).

```sh
cd pitchroom-app
pnpm install --frozen-lockfile
pnpm dev
```

The default fixture runtime works without provider credentials. Configure your own local environment for PostgreSQL or live model use; `.env.example` contains local development placeholders only.

This repository starts from a source snapshot dated 2026-10-26. It includes application code, tests, synthetic fixtures, schema migrations and dependency locks. It excludes prior Git history, local environment files, database contents, runtime artifacts, raw QA evidence, participant records, internal planning records, and the real-material eval configuration. Schema migrations describe structure, not database contents. The local v6 product/design baseline referenced by app documentation is maintained separately and is not included here. Historical verification links may point to excluded local records; this upload makes no new test or deployment claim.
