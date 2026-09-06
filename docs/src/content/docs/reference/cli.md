---
title: CLI reference
description: Every copperhead command, flag, and exit code.
sidebar:
  order: 1
---

```text
copperhead [global options] [<command>]
```

With no subcommand, `copperhead` starts the interactive agent shell. Every command probes `kicad-cli` before doing anything and exits 1 if it cannot be found. Resolution order: `COPPERHEAD_KICAD_CLI` when set, then `kicad-cli` on your `PATH`, then the macOS KiCad.app bundle locations. Setting `COPPERHEAD_KICAD_CLI` to a path that does not exist is an error naming that path, not a silent fall back to `PATH`. A `.env` in the working directory is loaded before any command resolves a model or a provider; a real environment variable always beats the file.

## Commands at a glance

| Command | Flow | LLM? | What it does |
| --- | --- | --- | --- |
| `repl` (default) | [Edit an existing board](/workflows/edit-existing-board/) | Yes | Interactive agent shell; each prompt is one `do`-equivalent run. |
| `demo` | [Simple demo](/getting-started/demo/) | Tour no / pipeline yes | Tour of what copperhead does, or run the USB-C breakout create pipeline. |
| `init` | Setup | No | Scaffolds `docs/` from an existing schematic. |
| `check` (`verify`) | Either | No | ERC, DRC, drift, constraints, spec validation. CI-safe. |
| `do` | [Edit an existing board](/workflows/edit-existing-board/) | Yes | One change: propose, edit, verify, propagate, commit. |
| `create` | [Design from a brief](/workflows/create-from-brief/) | Yes | Full pipeline from a markdown brief to an output package. |
| `sync` | Either | Verify phase no, resolve phase yes | Reconciles docs, files, and constraints. |
| `draft` | [Design from a brief](/workflows/create-from-brief/) | No | Deterministically draws the schematic from `schematic.intent.json`. |
| `score` | Either | No | Quantitative legibility score for the schematic (0-100, advisory). |
| `pcb` | Layout | No | Board layout harness: `import`, `route`, `verify`, `score`, `render` (RFC 11). Engines run locally; no model. |

## Global options

| Option | Description |
| --- | --- |
| `--repo <path>` | Target repository. Defaults to the current directory. |
| `--json` | Machine-readable output on stdout. |
| `-V, --version` | Print the version. |

Global options go before the subcommand: `copperhead --json check`.

## `copperhead` / `copperhead repl`

Interactive agent shell (default when no command is given). On a TTY it takes over the full window (alternate screen, restored on exit): banner on top, input pinned at the bottom, each line runs the same gated loop as `copperhead do`, then returns to the prompt. Ctrl+C twice exits; PgUp/PgDn scroll the session history; Esc dismisses the slash menu; a pasted multi-line request arrives as one request instead of submitting at its first newline. Every session mirrors its log to `.copperhead/runs/repl-<timestamp>.log` (ANSI stripped, secrets redacted with the same write-time redactor as the run transcripts).

```bash
copperhead
copperhead "add reverse-polarity protection on VIN"   # seed request, then stay in the shell
copperhead repl --model claude-code
```

| Option | Description |
| --- | --- |
| `--model <model>` | Model / provider selection (same as `do`). When no model is configured anywhere (flag, `COPPERHEAD_MODEL`, config, `.env` API keys), the shell offers an interactive picker instead of refusing to start. |
| `--max-turns <n>` | Turn budget per request. |
| `--allow-dirty` | Permit a dirty working tree, same meaning and same default (off) as on `do`. |
| `--interactive` | Pause for approval after each proposal validates. |

Slash commands inside the shell: `/help`, `/demo`, `/examples`, `/status`, `/check`, `/parts`, `/nets`, `/bom`, `/sync`, `/drift`, `/constraints`, `/openspec`, `/config`, `/git`, `/runs`, `/last`, `/model`, `/version`, `/clear`, `/quit` (`/exit`, `/q`). Type `/` to see live filtered suggestions immediately; ↑/↓ + Enter picks one, Tab completes. `/model` opens an arrow-key picker and switches the session model in place. Requires a TTY (or a seed request for a one-shot non-TTY run). `--json` is refused; use `copperhead do … --json` instead.

## `copperhead demo`

Tour of what the agent does, or an end-to-end create pipeline against the packaged USB-C power breakout brief (same as `npm run demo:simple`).

```bash
copperhead demo --tour                 # overview only (no LLM)
copperhead demo --model cursor         # scaffold + create pipeline
copperhead demo --dir /tmp/my-demo     # custom demo repo path
```

| Option | Description |
| --- | --- |
| `--tour` | Print the overview and exit. Honours the global `--json`, which emits `{ "tour": [...lines] }`. |
| `--model <model>` | Model for the create pipeline. |
| `--interactive` | Re-enable human gates during create. |
| `--dir <path>` | Demo repo directory. Default `demo-runs/usb-c-breakout` (or `COPPERHEAD_DEMO_DIR`). |

## `copperhead init`

Scaffolds design docs from an existing schematic. Idempotent.

```bash
copperhead init [--path <dir>] [--force] [--no-hooks]
```

| Option | Description |
| --- | --- |
| `--path <dir>` | Where to look for KiCad files. Default `.`. |
| `--force` | Overwrite generated docs that have been hand-edited. |
| `--no-hooks` | Skip installing the git pre-commit hook. |

Reports each file as `created`, `unchanged`, or `REFUSED`. Exits 1 if anything was refused, 0 otherwise.

## `copperhead do`

The core loop: propose, edit, verify, propagate, commit.

```bash
copperhead do "<change request>" [options]
```

| Option | Description |
| --- | --- |
| `--model <model>` | `codex`, `cursor`, `gpt-5`, `claude`, `claude-code`, or a provider-specific model id. Saved-login providers: `codex` (Codex CLI), `cursor` (Cursor Agent CLI), `claude-code` (Claude Code). |
| `--max-turns <n>` | Turn budget for this run. Overrides `maxTurns` from config. |
| `--allow-dirty` | Permit a dirty working tree. The snapshot keeps tracked changes as a `git stash create` object and untracked files as a tree object, so a rollback restores both. |
| `--dry-run` | Propose the diff and write nothing. |
| `--interactive` | Pause for approval once the proposal validates. |

Exits 1 if the run ends in failure, 0 otherwise.

## `copperhead check`

Alias: `copperhead verify`.

```bash
copperhead check
```

Runs ERC, DRC, doc-drift detection, constraint checks, and OpenSpec validation. Makes **no LLM calls and no network requests**, which is a contract, not a tendency: this is what makes it safe to run in CI and in a pre-commit hook.

ERC and DRC are skipped when no schematic or board is configured, rather than failing.

| Exit code | Meaning |
| --- | --- |
| `0` | Everything agrees. |
| `1` | At least one check failed, or `kicad-cli` is missing. |

With `--json`, prints a result object with `ok` plus per-check detail for `erc`, `drc`, `drift`, `openspec`, `constraints`, `legibility` (findings, counts, skipped and disabled families, and the advisory `score`), and `layout`. Legibility findings never affect the exit code.

**Layout track.** When `docs/LAYOUT.md` carries layout evidence (written by `create` after it routes the board, or by `copperhead pcb route --apply`), `check` re-verifies the committed board with the harness checkers: pre-flight, geometry, connectivity, return path, layout intent (the board's own rules plus the intent file), and KiCad DRC as one voter. No engine runs and nothing is routed. The track fails when the board changed after the evidence was written (`STALE`: re-run `copperhead pcb route` or `create`) or when a hard gate fails on the board as committed. `layout` is `null` when there is no evidence.

## `copperhead draft schematic`

```bash
copperhead draft schematic
copperhead draft schematic --intent hardware/schematic.intent.json
```

Regenerates the configured schematic deterministically from the netlist-intent IR. The verb takes the artifact as a noun (`draft pcb` is reserved for layout drafting), so `draft` alone never has to guess what it applies to: parts, nets, groups, and no-connects in; placement, wires, labels, power symbols, and captioned group boxes out. Same intent, same bytes, every run. Makes no LLM calls and no network requests. See [How schematics are drafted](/reference/schematic-drafting/).

| Exit code | Meaning |
| --- | --- |
| `0` | Drafted and written (also writes the vendored `sym-lib-cache/`, `sym-lib-table`, and a minimal `.kicad_pro` when absent). |
| `1` | Intent validation failed; the numbered findings are printed and the previous schematic is untouched. |

## `copperhead score schematic`

```bash
copperhead score schematic
```

Prints the quantitative legibility score: a 0-100 composite with the per-metric breakdown (crossings, bends, wire length, alignment, spacing uniformity, symmetry, balance, and more). Error-severity legibility findings cap the composite. Advisory by design: the exit code never depends on the score. Makes no LLM calls and no network requests.

## `copperhead doctor`

```bash
copperhead doctor [--model <model>]
```

Environment preflight: checks whether this machine can actually run a copperhead command, **before** you start one. Unlike `check`, it looks at the model provider, the one thing `check` cannot, since `check` is contractually LLM-free. Makes **no LLM calls and no network requests**; the credential check is presence-only (it verifies a required API key is set, not that it authenticates). If a compat endpoint or key is actually wrong, the real run surfaces that directly.

Checks, in order:

- **node** — at least the version copperhead requires.
- **kicad-cli** — present on PATH (a missing binary is reported, not thrown).
- **git** — present on PATH (copperhead snapshots and commits its work).
- **provider** — resolves the model the same way a run does (`--model` > `COPPERHEAD_MODEL` > config > available key) and checks its credential. Saved-login providers (`codex`, `cursor`, `claude-code`) need no key and report `info`. For `compat:<id>` it checks the variable named by `apiKeyEnv`; a local endpoint needs no key.
- **privacy** — `compat` only. `[warn]` when the endpoint's host is documented as training on submitted prompts; `[info]` naming the host when a remote endpoint has no known policy on record. Neither ever fails the check. A true loopback endpoint (`localhost`/`127.0.0.1`/`::1`) skips this line entirely; a `.local`/LAN host does not, since that traffic still leaves the machine.
- **project** — informational: whether `.copperhead/config.json` exists and what it wires. Never blocks.

| Option | Description |
| --- | --- |
| `--model <model>` | Check the credential for this model instead of the resolved default. |

| Exit code | Meaning |
| --- | --- |
| `0` | Ready — no critical check failed. `[warn]` and `[info]` do not block. |
| `1` | Not ready — a `[FAIL]` item needs fixing. |

With `--json`, prints `{ ok, checks: [{ name, status, detail, hint? }] }`.

## `copperhead pcb`

The board layout harness ([RFC 11](https://github.com/animesh-chouhan/copperhead-rfcs)): copperhead imports the board into its own IR, runs wrapped routing engines behind one fail-closed contract, verifies every candidate independently of the engine (geometry, connectivity, return path, KiCad DRC), ranks the valid ones, and writes an evidence bundle. It never routes a board itself and never calls a model; only local engines run.

```bash
copperhead pcb import [--board <path>]
copperhead pcb verify [board] [--no-kicad] [--intent <path>]
copperhead pcb place  [--board <path>] [--placers <ids>] [--mode <mode>] [--movable <refs>] [--seed <n>]
                      [--budget-seconds <n>] [--no-probe] [--probe-router <id>] [--blocks] [--references]
                      [--allow-harness-engines] [--apply] [--run-dir <path>]
copperhead pcb references [--board <path>] [--refresh] [--approve <id>] [--approver <who>]
copperhead pcb infer-intent [--board <path>] [--model <model>] [--intent <path>] [--run-dir <path>] [--dry-run]
copperhead pcb route  [--board <path>] [--routers <ids>] [--mode <mode>] [--nets <names>]
                      [--critical-nets <names>] [--layer-pref <specs>] [--preserve] [--seed <n>]
                      [--budget-seconds <n>] [--allow-harness-engines] [--apply] [--run-dir <path>]
copperhead pcb score  <run-dir> [--scoring <profile>]
copperhead pcb render [board] [--out <svg>] [--plain] [--scale <n>]
```

- **`import`** parses the board (and its `.kicad_pro` when present) into the IR and prints what it found: layers, components, nets, existing copper, and anything the import could not carry (`lossy`).
- **`verify`** runs the harness checkers on one board file and prints the diagnostics, metrics, gates, and any disagreement between checkers. Zones are refilled on a copy, so the file is never touched. Layout intent is checked too: the board's own rules (net classes, locked parts, keepout areas) are always in force, and an intent file (`--intent`, `pcb.intentPath`, `<board dir>/intent.yaml`, or `docs/LAYOUT.intent.yaml`) adds fixed positions, edges, attachments, groups, separations, and keepouts in the RFC 11 §7.3 language. An unknown key in the file, or a hand entry that contradicts the board's own rules, ends in `HOLD`. Exit codes are the layout statuses below.
- **`place`** snapshots the board with its movable set (every part not locked in KiCad, or `--movable`), runs the eligible placers, materializes each candidate (ripping up copper a moved part invalidated), verifies it, measures HPWL and a congestion proxy, probes routability by routing the candidate once with a fixed configuration, and ranks under `default-placement-2-layer` (overlaps and off-board parts are gates; routability first, then wirelength). Built-in placers: `placer-kicad-tools-physics` and `-evolutionary` (MIT, `kct`), `placer-pyplacer` (BSD-3, vendored, needs Python with numpy), `placer-fixed` (the control), `placer-reference` (harness only). With `--blocks`, the run follows the staged plan: functional blocks are derived from `docs/SUBSYSTEMS.md` and `schematic.intent.json` (one block per subsystem, its IC as anchor, a left-to-right signal-flow slot from the edge connectors it touches), each anchor is placed at its slot's centroid and locked, and the wrapped placers place the remainder; `plan.json` in the run records the stages and blocks. With `--references`, the best approved (or permissively licensed) cached reference block per anchor is copied around it as stage 3, with the block's stated distances as attachments; a block that hangs over the edge is shifted back inside as a whole.
- **`infer-intent`** compiles layout intent (RFC 11 §7.4) into `.copperhead/constraints.json`: functional blocks from `docs/SUBSYSTEMS.md` and `schematic.intent.json`, the intent file's explicit requirements unmodified, the board's own rules, and, with `--model`, part roles and datasheet-derived rules (every proposal must cite a BOM row or cached datasheet, is validated through the intent language, is never hard on its own, and loses to a user entry). Conflicts resolve by authority (user, then board rules, then datasheet, then compiler) and priority; anything uncertain is listed under holds and the command exits `HOLD`; a hard requirement is never downgraded. `intent-report.md` in the run directory is the human-readable explanation. The agent has the same step as the `pcb_infer_intent` tool, deterministic, since the agent is the model.
- **`references`** finds reference layouts for each block anchor in the local sources: the user's own boards (`pcb.referenceDesigns`, applied without approval), the repo's reference boards, the PCBench qualification boards (their recorded license), the KiCad demos (license unknown), and RFC 1 teardown outputs (`pcb.teardownCorpus`). Each hit is cut to the parts sharing a net with the matching anchor within 15 mm, mapped onto the block's members by footprint and value, scored (part number 1.0, family and footprint 0.7, pattern 0.5, plus connectors and board class), and cached under `.copperhead/layout-refs/`. A permissive license applies automatically; copyleft, share-alike, and unknown licenses hold until `--approve <id>` records an approver. No model, no network.
- **`route`** snapshots the board, runs the eligible routers, materializes and verifies each result as a candidate, ranks them, and reports one outcome. Nothing is written to the board unless `--apply`; the run directory holds every candidate with its provenance.
- **`score`** re-ranks the candidates of an existing run directory under a scoring profile.
- **`render`** draws the board to SVG with the verify diagnostics numbered on it (`--plain` for a bare thumbnail).

| `route` option | Description |
| --- | --- |
| `--routers <ids>` | Engine ids in preference order. Built in: `router-freerouting` (GPL, out of process, needs a JRE 25 and the jar), `router-kicad-tools` (MIT, needs `kct`), `router-reference` (harness fixtures only). |
| `--mode <mode>` | `single` (first eligible engine), `race` and `ensemble` (every eligible engine, best candidate wins), `staged` (power and ground first at their class width, then `--critical-nets`, then the bulk by race). |
| `--nets <names>` | Route only these nets; every other net's copper stays and acts as an obstacle. |
| `--layer-pref <specs>` | `F.Cu=horizontal,B.Cu=vertical`, or `<layer>=any` and `<layer>=off`; mapped onto the engine's own layer settings. |
| `--preserve` | Keep the copper already on the board instead of ripping it up. |
| `--budget-seconds <n>` | Engine-second and wall-clock budget per run (default: config or 600). |
| `--allow-harness-engines` | Let `router-reference` compete. It exists to test the harness, not to route boards. |
| `--apply` | Copy the selected candidate over the board file. |
| `--run-dir <path>` | Where the evidence bundle goes (default `.copperhead/runs/<ts>/layout`). |

| Exit code | Status | Meaning |
| --- | --- | --- |
| `0` | `PASS` / `PARTIAL` | A valid candidate was selected; `PARTIAL` still owes connections or no candidate passed a hard gate (the board is unchanged). |
| `2` | `HOLD` | Waiting on a user decision. |
| `3` | `REFUSE` | The board failed pre-flight or the placement gate; no engine ran. |
| `4` | `UNSUPPORTED` | No registered engine is eligible for this board and policy. |
| `5` | `TIMEOUT` | Every engine ran out of budget. |
| `6` | `ENGINE_ERROR` | No engine produced a candidate. |
| `7` | `INVALID_OUTPUT` | An engine modified its input snapshot; its output was discarded. |

The run directory: `snapshot.json` (the immutable input, hashed), `plan.json` (staged mode), `candidates/<engine>-<n>/` with `job.json`, `result.json`, `provenance.json` (binary, arguments, versions, seed, exit code), `candidate.kicad_pcb`, `diagnostics.json`, `metrics.json`, and `ranking.json`, `outcome.json`, `events.jsonl` at the top. Engines get a scrubbed environment (no `*_KEY`, `*_TOKEN`, `*_SECRET`, `PASSWORD`).

`copperbench run|compare|report` (a second bin) drives the same `route` or `place` path over a suite (`bench/suites/*.json`; `--kind routing|placement|verify`, `--routers`, `--placers`, `--probe-router`; `verify` runs no engine and reports the hard-intent pass rate and expected-status agreement, tracks E and F) and writes JSON, HTML, and CSV reports with the RFC 11 §13.4 record. Placement reports add the HPWL-versus-probe-completion correlation over every eligible candidate. `compare` refuses to diff runs of different benchmark versions.

## `copperhead sync`

Verifies the whole design state and resolves drift. Two phases: a deterministic verify phase, then an LLM resolve phase.

```bash
copperhead sync [--model <model>] [--dry-run]
```

| Option | Description |
| --- | --- |
| `--model <model>` | Model for the resolve phase. |
| `--dry-run` | Print the inconsistency report and write nothing. |

| Exit code | Meaning |
| --- | --- |
| `0` | Clean, or drift resolved successfully. |
| `1` | The resolve phase failed. |
| `2` | Requirement violations found. |

Exit code 2 is the important one. A requirement violation means the as-built design contradicts a stated requirement, and copperhead will **never** auto-resolve that: the fix is an engineering decision. Drift, where the docs disagree with the files, is resolvable and gets resolved.

## `copperhead create`

The full pipeline from a product brief to the output package.

```bash
copperhead create --brief brief.md [--model <model>] [--interactive]
```

| Option | Description |
| --- | --- |
| `--brief <file>` | **Required.** The product brief, in markdown. |
| `--model <model>` | `codex`, `cursor`, `gpt-5`, `claude`, or `claude-code` (saved-login; no model API key for those three). |
| `--interactive` | Re-enable the human gates: spec approval, and a pause before export. |

Exits 1 if any stage fails to complete, 0 when the pipeline finishes.

### Pipeline stages

Each stage is a full `do` loop with its own prompt and gate. Stage completion is inferred from repo state, so the pipeline is resumable: rerun the same command after a failure and it skips what is done and resumes at the first incomplete stage.

| # | Stage | Produces |
| --- | --- | --- |
| 1 | `spec` | `docs/SPEC.md`, plus every budget recorded as a constraint |
| 2 | `architecture` | `docs/SUBSYSTEMS.md` |
| 3 | `parts` | `docs/BOM.md`, MPNs flagged `UNVERIFIED` |
| 4 | `schematic` | The `.kicad_sch`, ERC clean after each sheet |
| 5 | `layout` | The model places the parts (DRC clean); copperhead then routes the board through its wrapped engines, writes the selected candidate to the board, and records the evidence in `LAYOUT.md` next to the model's `## Draft quality` section. The stage is complete only when the evidence is for the board as committed and routing ended `PASS`, `PARTIAL`, or `UNSUPPORTED` (no engine installed, said so); a placement-gate `REFUSE` sends the findings back to the model |
| 6 | `outputs` | `outputs/`: gerbers, drill, DXF, STEP, SVG, `BOM.csv` |
| 7 | `firmware` | `firmware/` scaffold, `pins.h` generated from `PINOUT.md` |
| 8 | `devplan` | `docs/DEVPLAN.md` |

Stages build on each other's uncommitted state, so `create` runs them as if `--allow-dirty` were set.

## Repo scripts

These are npm scripts in a copperhead checkout, not installed CLI commands.

| Script | What it does |
| --- | --- |
| `npm run demo:simple` | Runs the create pipeline against `examples/simple/usb-c-breakout.md` in `demo-runs/usb-c-breakout/`. See [Simple demo](/getting-started/demo/). |
| `npm run docs:dev` | Serves this documentation locally. |
| `npm run docs:build` | Builds the documentation site. |
| `npm test` | Runs the vitest suite. LLM-touching tests skip unless their provider is explicitly configured. |
| `npm run typecheck` | Type-checks without emitting. |
| `npm run build` | Compiles to `dist/`. |

Pass `create` flags through after `--`, for example `npm run demo:simple -- --model claude`. Override the target directory with `COPPERHEAD_DEMO_DIR`.
