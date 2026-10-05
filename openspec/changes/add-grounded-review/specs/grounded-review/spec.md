# grounded-review: Delta Spec

## ADDED Requirements

### Requirement: Fixed deterministic sweep first
A review SHALL run the copperhead-tools `review` composite over the design and every fabrication output given, before any model pass, unless `--sweep` names an existing review record. The model SHALL NOT choose which deterministic checks the sweep runs.

#### Scenario: Fabrication outputs are swept
- **WHEN** `--fab` names a Gerber directory, a BOM and a placement file
- **THEN** the sweep's input holds the design and all three, and they are also retained sources of the bundle

### Requirement: Read-only model passes
Each domain pass SHALL offer the model only read-only queries over the bundle, `propose` and `submit`. Every call, its arguments and its result SHALL be recorded in the pass's sample, and the sample SHALL be written after every turn. A pass SHALL end on `submit`, on its turn budget, on its time budget, after three turns with no tool call, after two consecutive turns that exceed the turn timeout (one timed-out turn is retried), or on a provider failure, and SHALL record which. A sample written mid-pass SHALL record the outcome `running`.

#### Scenario: Proposals are pre-checked
- **WHEN** a pass proposes a fact and a citation
- **THEN** it receives each one's outcome, verifier and reason from `review-verify` in the same turn

#### Scenario: A killed pass leaves its work
- **WHEN** the process running a pass is killed after its tenth turn
- **THEN** the pass's sample on disk holds every proposal made up to that turn

### Requirement: Report from verification only
The review's report SHALL be the one `review-verify` renders from every pass's proposals; the model's own text SHALL NOT appear in it except as the labelled, unverified suggested fix of a verified finding.

#### Scenario: A pass's prose is not presented
- **WHEN** a pass submits with a summary claiming findings it never proposed
- **THEN** the report holds none of them

### Requirement: Lockfile and replay
The record SHALL hold a lockfile with the model id, the template hashes, the domains, the budgets, the fabrication inputs, and the sha256 of the bundle, the merged proposals and the report. Replay SHALL refuse a record whose proposals no longer match the lockfile, and SHALL succeed only when the re-rendered report is byte-identical.

#### Scenario: Tampered proposals
- **WHEN** `model/proposals.json` is edited after the run and replay is requested
- **THEN** replay fails, naming the proposals file
