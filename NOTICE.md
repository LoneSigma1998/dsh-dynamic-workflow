# NOTICE

`@sigmacamellia/dsh-dynamic-workflow`
Copyright 2026 dsh-dynamic-workflow contributors
Licensed under the Apache License, Version 2.0 (see [`LICENSE`](./LICENSE)).

---

## 1. Upstream Attribution — ZCode (Apache-2.0)

This project includes vendored, ported, and adapted code from **[ZCode](https://github.com/zai-org/ZCode)**, Copyright 2026 Z.AI Co., Ltd, licensed under the Apache License, Version 2.0 (original license text preserved at [`vendor/LICENSE-ZCode-Apache-2.0`](./vendor/LICENSE-ZCode-Apache-2.0)):

- **`vendor/dynamic-workflow/` and `vendor/dynamic-workflow-runtime/`** — Dynamic workflow compiler, static analyzer, execution engine, and sandbox runtime, vendored verbatim except for one documented modification in `vendor/dynamic-workflow-runtime/src/child-entry-file.ts` (redirects sandbox entry files from `.zcode/workflow-runs/` to `.dsh/workflow-runs/`, fallback `dsh-workflow-runs/`; see [`vendor/PATCHES.md`](./vendor/PATCHES.md)).
- **`src/journal/zcode/`**, **`src/service/import.ts`**, **`src/service/quota-resume.ts`**, **`src/world/world-read.ts`**, **`src/world/git-world-read.ts`**, **`src/display/graph-*.ts`**, **`src/shared/runs/`** — Ported from ZCode CLI / shared protocol modules with import paths, storage backends, and host types adapted for DeepSeek Harness.
- **`src/client/model/`** (including `src/client/model/timeline/spine-layout.ts`) and **`src/client/RunSpine.tsx`** — Ported and adapted from ZCode's timeline, workflow graph, and vertical spine UI models.
- **`skills/dynamic-workflows/`** — Adapted from ZCode's `dynamic-workflows` skill with DSH tool names, paths, and conventions.

All other files in this repository are original to `dsh-dynamic-workflow` and are licensed under Apache-2.0.

### Relevant Operational Notices Retained from Upstream ZCode `NOTICE.md`

In accordance with Section 4(d) of the Apache License, Version 2.0, the following operational and safety disclosures from upstream ZCode's `NOTICE.md` that pertain to the workflow runtime are retained here:

- **AI Output & Execution Boundaries**: AI-generated workflow scripts, commands, files, and analyses may contain errors, omissions, or security issues. Always review the workflow script, target workspace, and side effects in the confirmation card before approving execution, and maintain recoverable backups.
- **Host Execution & Subagents**: Workflow scripts (`world.run`) and subagents execute under the permissions of the host OS user running DeepSeek Harness. Subagents and background workflow runs can continue issuing LLM requests, running commands, and producing workspace or external side effects; stopping a run or closing the UI does not roll back already-completed file writes or external operations.
- **Local Persistence & Credentials**: Workflow journals, drafts, sandbox entry files, and artifacts are stored locally under `<cwd>/.dsh/` and `$DSH_HOME/state/dynamic-workflow/` and may contain prompts, source code, and tool outputs. Never commit real credentials or private session exports to public repositories.
- **Third-Party Rights**: The Apache-2.0 license granted on first-party code does not add rights on behalf of third-party copyright holders and does not guarantee parity with official ZCode or DeepSeek Harness products.

---

## 2. Bundled Third-Party Components

The compiled distribution bundle (`lib/index.js`, full legal headers in `lib/index.js.LEGAL.txt`) bundles the following open-source libraries:

- **TypeScript** — Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
- **Zod** — Copyright (c) 2020 Colin McDonnell. Licensed under the MIT License.

---

## 3. Trademark & Non-Affiliation Notice

In accordance with Section 6 of the Apache License, Version 2.0, this project is an **independent, unofficial community plugin**. It is not affiliated with, sponsored by, or endorsed by **DeepSeek** (DeepSeek Harness) or **Z.AI Co., Ltd / Zhipu AI** (ZCode). All product names, logos, and trademarks are the property of their respective owners and are used solely to identify compatibility and upstream origin.
