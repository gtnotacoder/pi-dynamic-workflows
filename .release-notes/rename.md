# /maxeffort command rename

- Renamed the registered maximal-effort command in src/effort-command.ts to /maxeffort.
- Updated user-facing strings ("Max effort ON/off") and the README commands table row.
- Updated tests/effort-command.test.ts and the extensions/workflow.ts comment.
- Kept the EffortLevel "ultra" tier value unchanged (that is /effort, not the command).
- Checks pass: biome clean, 1385 tests pass (baseline-matched).