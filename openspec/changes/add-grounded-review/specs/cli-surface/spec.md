# cli-surface: Delta Spec

## ADDED Requirements

### Requirement: `review` command
The CLI SHALL provide `copperhead review [design] --out <dir>`, marked experimental, with `--source`, `--fab`, `--fab-profile`, `--model`, `--domains`, `--max-turns`, `--max-minutes`, `--parallel`, `--label`, `--sweep`, `--tools`, `--replay` and `--resume`. It SHALL refuse an `--out` that is not empty or lies inside the design, and SHALL never write the design. It SHALL exit non-zero with a message, without a stack trace, when copperhead-tools cannot be found or a step fails.

#### Scenario: Record outside the design
- **WHEN** `copperhead review ./board --out ./board/review` is run
- **THEN** it exits non-zero naming the rule that the record lies outside the design, and writes nothing

#### Scenario: Replay
- **WHEN** `copperhead review --replay <record>` is run on an unchanged record
- **THEN** it re-verifies the stored proposals with no model, reports the replay identical, and exits 0

### Requirement: Text tool protocol argument shapes
A text-protocol tool call SHALL take its arguments from `args`, else from `arguments`, `parameters` or `input` when that key holds an object, else from the keys beside `tool`.

#### Scenario: Flat arguments
- **WHEN** a model replies `{"tool": "search", "pattern": "SDO"}` for an advertised `search` tool
- **THEN** the call's arguments are `{"pattern": "SDO"}`

### Requirement: Resuming a killed run
`copperhead review --resume --out <dir>` SHALL reuse the record's sweep and bundle, keep every pass whose sample records an end (submitted, turns or time exhausted, stalled), keep an interrupted sample beside a fresh rerun of its pass, and then verify and record as a fresh run would.

#### Scenario: One pass failed
- **WHEN** a record holds seven submitted passes and one that failed, and `--resume` is run
- **THEN** only the failed domain's pass runs, and the bundle is not rebuilt
