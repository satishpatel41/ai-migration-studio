---
name: setup
description: Set up ai-migration-studio for development and verify it. Use when cloning fresh, installing dependencies, or checking that tests and the studio run.
---

# Setup

1. Node 20+ and npm.
2. `npm install`
3. Verify: `npm run typecheck && npm test && npm run build`. All must pass before committing.
4. Studio: `npx tsx src/cli.ts studio` then open http://localhost:4100.
5. Optional AI refinement: export `ANTHROPIC_API_KEY` (and `AMS_MODEL` to override the default). Never commit keys; `.env` is ignored.
6. Try it: `npx tsx src/cli.ts migrate test/fixtures/sample-app --out migrated-out` and read `migrated-out/MIGRATION_REPORT.md`.
