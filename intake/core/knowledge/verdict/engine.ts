/**
 * The deterministic verdict engine (SPEC §14).
 *
 * APPROVE only when: inputs exist · readings admissible with sufficient
 * status · evidence conditions cover the requirement's · the qualifier
 * provides the needed guarantee · exact-decimal calculation satisfies the
 * requirement (boundaries inclusive). REFUSE only on admissible,
 * condition-compatible proof of violation. Everything else HOLDs with a
 * reason code. Pure functions over pinned snapshots — AC-8.6 determinism
 * and AC-8.8 provider-freedom hold by construction.
 */

import type {
  ConditionSet,
  Constraint,
  Decimal,
  Qualifier,
  Verdict,
  VerificationManifest,
} from "../types";
import {
  compareMeasurements,
  parseUnit,
  shift,
  siValue,
  subtract,
  sumMeasurements,
  toDecimalString,
} from "../decimal";
import { conditionsCover, effectiveRequirement } from "./coverage";
import type {
  CheckRequest,
  EngineContext,
  EngineResult,
  FactSnapshot,
  FactSnapshotEntry,
} from "./types";

export const ENGINE_VERSION = "1.0.0";

/** The qualifier that provides the needed guarantee (SPEC §14, AC-8.2). */
function guaranteeQualifiers(constraint: Constraint): Qualifier[] {
  if (constraint.policy.bound === "TYPICAL_OK") return ["TYP", "NOM"];
  switch (constraint.kind) {
    case "max":
    case "budget_sum":
      return ["MAX"]; // upper-bound checks need the worst-case high
    case "min":
      return ["MIN"];
    case "equality":
      return ["NOM"];
  }
}

interface TermSelection {
  entry?: FactSnapshotEntry;
  hold?: { reasonCodes: Verdict["reasonCodes"]; reason: string };
}

function selectTermFact(
  term: { part: string; key: string },
  constraint: Constraint,
  requirement: ConditionSet,
  snapshot: FactSnapshot,
  strictStatus: boolean,
): TermSelection {
  const candidates = snapshot.facts.filter(
    (f) => f.part === term.part && f.key === term.key,
  );
  if (candidates.length === 0) {
    return {
      hold: {
        reasonCodes: ["EVIDENCE_MISSING"],
        reason: `no fact for ${term.part}/${term.key}`,
      },
    };
  }

  const wanted = guaranteeQualifiers(constraint);
  const qualified = candidates.filter((f) => wanted.includes(f.qualifier));
  if (qualified.length === 0) {
    return {
      hold: {
        reasonCodes: ["GUARANTEE_UNAVAILABLE"],
        reason: `${term.part}/${term.key}: no ${wanted.join("/")} reading under ${constraint.policy.bound} policy (available: ${[...new Set(candidates.map((f) => f.qualifier))].join(", ")})`,
      },
    };
  }

  if (qualified.some((f) => f.frozen || f.status === "disputed")) {
    return {
      hold: {
        reasonCodes: ["FACT_CONFLICT"],
        reason: `${term.part}/${term.key}: fact is disputed and frozen`,
      },
    };
  }

  const revisions = new Set(
    qualified.map((f) => f.reading.evidence.document.revision ?? ""),
  );
  const values = new Set(qualified.map((f) => f.value.si_value_decimal));
  if (revisions.size > 1 && values.size > 1) {
    return {
      hold: {
        reasonCodes: ["REVISION_CONFLICT"],
        reason: `${term.part}/${term.key}: conflicting values across document revisions [${[...revisions].join(", ")}]`,
      },
    };
  }

  const covering = qualified.filter(
    (f) => conditionsCover(f.conditions, requirement).covered,
  );
  if (covering.length === 0) {
    const sample = conditionsCover(qualified[0]!.conditions, requirement);
    return {
      hold: {
        reasonCodes: ["CONDITION_NOT_COVERED"],
        reason: `${term.part}/${term.key}: ${sample.failures.join("; ")}`,
      },
    };
  }

  if (strictStatus && covering.every((f) => f.status === "extracted")) {
    return {
      hold: {
        reasonCodes: ["INSUFFICIENT_EVIDENCE"],
        reason: `${term.part}/${term.key}: only extracted-status evidence under strict-status policy (§11.4)`,
      },
    };
  }

  const chosen = [...covering].sort((a, b) =>
    a.sha256 < b.sha256 ? -1 : 1,
  )[0]!;
  return { entry: chosen };
}

function formatConditions(conditions: ConditionSet): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined || key === "notes") continue;
    if (typeof value === "string") parts.push(`${key}=${value}`);
    else if ("min" in (value as object)) {
      const range = value as { min: Decimal; max: Decimal };
      parts.push(
        `${key}=${range.min.value_decimal}..${range.max.value_decimal} ${range.min.unit}`,
      );
    } else {
      const d = value as Decimal;
      parts.push(`${key}=${d.value_decimal} ${d.unit}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "unconditioned";
}

/** Exact deviation of result beyond limit, expressed in the limit's unit. */
function deviation(result: Decimal, limit: Decimal): string {
  const diff = subtract(siValue(result), siValue(limit));
  const unit = parseUnit(limit.unit);
  return `${toDecimalString(shift(diff, -unit.powerToBase))} ${limit.unit}`;
}

export function evaluate(
  request: CheckRequest,
  snapshot: FactSnapshot,
  context: EngineContext,
): EngineResult {
  const constraint = request.constraint;
  const requirement = effectiveRequirement(
    constraint.conditions,
    request.requirementConditions,
  );

  const selections = request.terms.map((term) =>
    selectTermFact(
      term,
      constraint,
      requirement,
      snapshot,
      request.strictStatus ?? false,
    ),
  );

  const holds = selections.filter((s) => s.hold !== undefined);
  if (holds.length > 0 || request.terms.length === 0) {
    const reasonCodes = [
      ...new Set(holds.flatMap((s) => s.hold!.reasonCodes)),
    ];
    return finish(request, context, {
      decision: "HOLD",
      reason:
        holds.map((s) => s.hold!.reason).join("; ") ||
        "no terms to evaluate",
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["SCOPE_EMPTY"],
      citedReadings: [],
    }, []);
  }

  const chosen = selections.map((s) => s.entry!);
  const total =
    constraint.kind === "budget_sum"
      ? sumMeasurements(chosen.map((f) => f.value), constraint.limit.unit)
      : chosen[0]!.value;

  const comparison = compareMeasurements(total, constraint.limit);
  // Boundaries are inclusive (AC-8.1, AC-8.4).
  const satisfied =
    constraint.kind === "min"
      ? comparison >= 0
      : constraint.kind === "equality"
        ? comparison === 0
        : comparison <= 0;

  const computed: NonNullable<Verdict["computed"]> = {
    expression:
      chosen
        .map((f) => `${f.value.value_decimal} ${f.value.unit} [${f.part}/${f.key} ${f.qualifier}]`)
        .join(" + ") +
      ` ${constraint.kind === "min" ? "≥" : constraint.kind === "equality" ? "=" : "≤"} ${constraint.limit.value_decimal} ${constraint.limit.unit}`,
    terms: chosen.map((f) => ({
      term: `${f.part}/${f.key}`,
      value: f.value,
      readingRef: f.readingRef,
    })),
    result: total,
    limit: constraint.limit,
  };

  if (satisfied) {
    return finish(request, context, {
      decision: "APPROVE",
      reason: `${constraint.description}: ${total.value_decimal} ${total.unit} satisfies the ${constraint.limit.value_decimal} ${constraint.limit.unit} limit (${formatConditions(requirement)})`,
      reasonCodes: ["REQUIREMENT_SATISFIED"],
      computed,
      citedReadings: chosen.map((f) => f.reading),
    }, chosen);
  }

  // Admissible, condition-compatible proof of violation → cited REFUSE (AC-9.1).
  const over = deviation(total, constraint.limit);
  return finish(request, context, {
    decision: "REFUSE",
    reason: `${constraint.description}: computed ${total.value_decimal} ${total.unit} violates the ${constraint.limit.value_decimal} ${constraint.limit.unit} limit by ${over} under ${formatConditions(requirement)}`,
    reasonCodes: ["BUDGET_EXCEEDED"],
    computed,
    citedReadings: chosen.map((f) => f.reading),
    proposedFix: `reduce ${constraint.affects.join(" + ") || "the affected budget"} by at least ${over}`,
  }, chosen);
}

function finish(
  request: CheckRequest,
  context: EngineContext,
  verdictFields: Omit<Verdict, "change" | "ruleVersion" | "citedConstraint">,
  usedFacts: FactSnapshotEntry[],
): EngineResult {
  const verdict: Verdict = {
    change: request.change,
    ...verdictFields,
    citedConstraint: request.constraint,
    ruleVersion: context.ruleVersion,
  };
  const manifest: VerificationManifest = {
    timestampISO: context.timestampISO,
    part: request.part,
    change: request.change,
    checksRun: [request.constraint.id],
    verdict,
    factVersions: usedFacts.map((f) => ({
      key: f.key,
      qualifier: f.qualifier,
      sha256: f.sha256,
      status: f.status,
    })),
    providers: context.providers,
    decisionRunId: context.decisionRunId,
  };
  return { verdict, manifest };
}

/**
 * Operational HOLD (AC-8.7): when a dependency is down, callers emit this —
 * never an uncited answer. Kept in the engine so the shape and reason codes
 * stay canonical.
 */
export function operationalHold(
  request: CheckRequest,
  context: EngineContext,
  dependency: string,
): EngineResult {
  return finish(request, context, {
    decision: "HOLD",
    reason: `dependency unavailable: ${dependency} — refusing to answer without evidence`,
    reasonCodes: ["DEPENDENCY_UNAVAILABLE"],
    citedReadings: [],
  }, []);
}
