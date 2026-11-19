# Vendor Patches

`vendor/dynamic-workflow/` and `vendor/dynamic-workflow-runtime/` are vendored verbatim from [ZCode](https://github.com/zai-org/ZCode) (Copyright 2026 Z.AI Co., Ltd, Apache License 2.0), with a single intentional modification:

1. **`vendor/dynamic-workflow-runtime/src/child-entry-file.ts`**
   - `workflowRunsDir(cwd)` writes sandbox entry files under `<cwd>/.dsh/workflow-runs/` instead of `<cwd>/.zcode/workflow-runs/`.
   - `fallbackWorkflowRunsDir()` falls back to `os.tmpdir()/dsh-workflow-runs/` instead of `os.tmpdir()/zcode-workflow-runs/`.
