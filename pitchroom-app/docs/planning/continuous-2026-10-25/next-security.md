# PIT-5 dependency investigation — 2026-10-25

## Current checkpoint (supersedes the initial investigation below)

The user authorized the upgrade, and commit `e87b780` changed Next and its required env/SWC companions to 16.4.1. The current installed package was re-read as 16.4.1. React/React DOM 19.3.0 and Sharp 0.35.5 were retained. The isolated upgrade verification passed 426 deterministic tests, types, production build and 16 bounded HTTP checks; the later Story repair checkpoint `008590a` passed 432 Vitest cases, 4 Node guard checks, types and a Next 16.4.1 production build. These are separate dated checkpoints, not a fresh security scan.

Local dependency remediation is implemented. Existing user services and deployments were not restarted. Real-browser file import verification and human acceptance remain open; no deployment or broad production-security clearance is claimed. See [execution checkpoints](execution.md).

## Initial investigation (historical, before upgrade authorization)

Installed `next/package.json`, the web manifest and pnpm lock agree on Next 16.4.0. A fresh QA dev startup also emitted the known-security-vulnerability notice and stopped; its supported unchanged retry started the fixture service. No suppression flag or dependency modification was used.

The [official October 14 update](https://nextjs.org/blog/nextjs-security-update-october-14-2026) identifies 16.4.1 as the patched active-LTS release. Its advisory list covers cache-component typed-array RCE, SVG image-optimization RCE on glibc Linux, and App Router Server Action DoS. Current app/config source has no `use cache`, `cacheComponents`, `use server`, `next/image`, `ImageResponse`, SVG opt-in or remote-image patterns. That scoped inspection does not clear the dependency or future hosting configurations. This local machine is macOS; production topology remains undecided.

Status: investigated, **not fixed**. Successful compilation is not security remediation. A separate approval request is pending for upgrading existing Next 16.4.0 to 16.4.1 and necessary lockfile companions. After approval: preserve unrelated work, inspect the exact dependency diff, run workspace checks and isolated synthetic browser regressions, retain failed output, and report the deployed version separately. No install, cloud resource change or deployment has occurred.
