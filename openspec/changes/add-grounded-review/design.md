# add-grounded-review: Design

## Context

copperhead calls models; copperhead-tools never does, and copperhead never imports it: the JSON
protocol is the only coupling. RFC 13 Section 18.4 makes the set of tools a review runs data, not a
model's choice; RFC 17 Section 4.1 lets a model pass call read-only queries over its bundle and
records each call. The agent loop (`runAgentLoop`) snapshots the repository, restores it with
`git reset --hard` on failure and commits on success; none of that belongs in a review, which must
leave the design untouched.

## Decisions

- **D1. The sweep is fixed.** The command always runs the copperhead-tools `review` composite first,
  over the design and every fabrication output given; the model never decides whether a check runs.
  Alternative: let the model call deterministic checks as it sees fit. Lost: "not flagged" would
  then mean "not called", and RFC 13 Section 18.4 forbids it.
- **D2. Model-initiated calls are queries.** A pass's tools are `review-query` operations, a
  `propose` call that runs `review-verify` over the pass's proposals as a pre-check, and `submit`.
  None writes. Their results are inputs to proposals and never findings themselves.
- **D3. Own loop, not `runAgentLoop`.** A pass is a small loop over `Provider.chat`: no git preflight,
  snapshot, restore, commit, obligations ledger or repair cycles. Alternative: a skill sub-run. Lost:
  skills share the parent's context and run sequentially, and a review has no parent run.
- **D4. Domain prefixes.** A pass's proposal ids, premises and calculation origins are prefixed with
  its domain letter, so eight passes' proposals merge without collision and a finding can only rest on
  its own pass's premises.
- **D5. Samples saved every turn.** A pass writes its record after every turn. A run killed by a
  session restart or a suspend leaves every proposal it had made. Alternative: write at the end.
  Lost: the first full run on the target board was killed at about 30 turns per pass and left
  nothing.
- **D6. Replay compares bytes.** `--replay` re-verifies the stored proposals into `replay/` and
  compares the report with the recorded one and with the lockfile's hash; a changed proposals file is
  refused before verifying.
- **D7. Lenient argument parsing.** The text protocol reads `args`, then `arguments`, `parameters`,
  `input`, then the remaining top-level keys. A schema-shaped call is unaffected.
- **D8. Resume and timeouts.** Samples record `running` until a pass ends; `--resume` keeps ended passes and reruns the rest from scratch (an interrupted conversation is not continued: its transcript is kept beside the rerun). A turn that exceeds its timeout is retried once; two in a row end the pass `failed`. Alternative: fail the pass on the first timeout. Lost: the first full run lost its MCU pass to one slow turn.

## Risks

- **Cost and time.** Eight passes of up to 40 turns each, one tool call per turn on text-protocol
  providers. Budgets are per pass (turns and minutes) and `--parallel` bounds concurrency.
- **Anchoring.** The digest puts what the sweep did not examine before the source index, and each
  domain task names its scope, so a pass starts from the gaps rather than from the sweep's findings.
- **Provider pinning.** The claude-code provider cannot pin decoding or an exact model version; the
  lockfile records that, and replay does not depend on it.
