# Tasks: add-grounded-review

## 1. copperhead-tools client

- [x] 1.1 `src/review/tools-client.ts`: resolve `--tools`, `COPPERHEAD_TOOLS`, or `copperhead-tools` on PATH; `run <tool>` with the request on stdin; not-run and error results become errors
- [x] 1.2 Tests use an injected client; no test spawns copperhead-tools

## 2. Passes

- [x] 2.1 `src/review/prompts.ts`: rules, the bundle digest (parts, every net, the sweep, what it did not examine, sources), eight domain scopes; templates hashed
- [x] 2.2 `src/review/pass.ts`: query tools (parts, nets, pins, sweep, sources, search, read, board, placement, routing, measure, calculators, calc), `propose` with a `review-verify` pre-check, `submit`; domain-prefixed ids; turn, time and per-turn timeout budgets; sample saved every turn
- [x] 2.3 Tests: a pass with a scripted provider (queries, a pre-checked proposal, submit); stall and turn exhaustion with the warning

## 3. Run, record and replay

- [x] 3.1 `src/review/run.ts`: sweep (with `--fab` and `--fab-profile`), bundle (fab files as sources), parallel passes, merged proposals, verify, report, lockfile
- [x] 3.2 `--replay`: refuse changed proposals; re-verify into `replay/`; byte comparison
- [x] 3.3 Tests: a two-domain run never writes the design, records samples and the lockfile, and replays identically; tampered proposals are refused; `--out` inside the design or not empty is refused
- [x] 3.4 `--resume`: reuse sweep and bundle, keep ended passes, rerun the rest (an interrupted sample kept aside); a timed-out turn retried once; tests for both

## 4. CLI and protocol

- [x] 4.1 `copperhead review` in `src/cli.ts`, lazily imported
- [x] 4.2 Text tool protocol reads `arguments`, `parameters`, `input` and flat arguments; protocol tests
- [x] 4.3 SPEC.md section 3 gains the `review` command
- [x] 4.4 Run typecheck, the test suite, the build and `openspec validate add-grounded-review --strict`
