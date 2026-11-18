# NOTICE

dsh-dynamic-workflow contains code from **ZCode** (Zhipu AI), licensed under the Apache License,
Version 2.0 (see `vendor/LICENSE-ZCode-Apache-2.0`):

- `vendor/dynamic-workflow/` and `vendor/dynamic-workflow-runtime/` — the dynamic-workflow
  compiler, analyzer, engine and sandbox runtime, vendored unchanged except for one patch:
  `vendor/dynamic-workflow-runtime/src/child-entry-file.ts` writes sandbox entry files under
  `.dsh/workflow-runs/` (fallback `dsh-workflow-runs/` in the OS temp dir) instead of `.zcode/…`.
- `src/journal/zcode/`, `src/service/import.ts`, `src/world/world-read.ts`,
  `src/world/git-world-read.ts`, `src/display/graph-*.ts`, `src/shared/runs/` — ported from the
  ZCode CLI / shared protocol with import paths and host types adapted.
- `src/service/quota-resume.ts` — port of ZCode's quota auto-resume.
- `src/client/model/` — ZCode's pure timeline and workflow-graph models (no React).
- `skills/dynamic-workflows/` — adapted from ZCode's dynamic-workflows skill (tool names, paths,
  DSH specifics).

All other code is original to this plugin and is licensed under Apache-2.0 as well.
