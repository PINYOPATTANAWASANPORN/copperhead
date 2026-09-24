/**
 * `copperhead pcb reuse` (add-reuse-placer, RFC 14 §12): place a board by
 * copying a reference board's placement and adapting it. The run screens every
 * variant in memory, materialises the survivors, verifies and probes them, and
 * ends with options the user chooses between — not one answer.
 *
 * The artifacts are the point of the command: `options.md` says what each
 * option traded away, `delta.md` says what changed against the reference, and
 * every option keeps its own render beside its board.
 */
import path from 'node:path';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { reuseRun, type ReuseRun, type ReuseRunOptions } from '../pcb/engines/reuse/run.js';
import { planPlacement } from '../pcb/agent/place/planner.js';
import type { Provider } from '../agent/types.js';
import { writeBoardRender } from '../pcb/engines/render.js';
import type { Outcome } from '../pcb/ir/status.js';
import type { Diagnostic } from '../pcb/verify/diagnostic.js';

export interface PcbReuseOptions extends ReuseRunOptions {
  /** The model that writes the plan; without it the rules plan and the run is network-free. */
  provider?: Provider | null;
  /** Write the chosen option over the board file. */
  apply?: boolean;
  /** Which option to apply; the ranked winner when absent. */
  option?: string;
}

export interface PcbReuseResult {
  outcome: Outcome<Diagnostic>;
  run: ReuseRun;
  /** Per option: where its board and render live. */
  options: { id: string; engineId: string; dir: string; rank: number | null; selected: boolean }[];
  applied: string | null;
}

const mm = (nm: number) => (nm / 1e6).toFixed(1);

function optionsMarkdown(run: ReuseRun, ranked: Map<string, { rank: number; reason: string }>): string {
  const lines: string[] = [];
  lines.push('# Placement options', '');
  lines.push(`Reference matched ${(run.match.coverage * 100).toFixed(0)} % of the parts; the plan came from the ${run.planSource}.`, '');
  lines.push('| Option | What it did | Legal | Unplaced | HPWL | Intent | Score | Rank |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const v of run.screened) {
    if (v.sameAs) continue;
    const r = ranked.get(`placer-reuse-${v.id}`);
    const m = v.metrics;
    lines.push(`| ${v.id} | ${v.note} | ${m.legal ? 'yes' : 'no'} | ${m.unplaced} | ${mm(m.hpwlNm)} mm | ${m.intentHard} hard | ${v.score.toFixed(1)} | ${r ? r.rank : v.kept ? '-' : 'not materialised'} |`);
  }
  const same = run.screened.filter((v) => v.sameAs);
  if (same.length) lines.push('', `Identical placements, kept once: ${same.map((v) => `${v.id} = ${v.sameAs}`).join(', ')}.`);
  if (run.place) {
    lines.push('', '## After materialising', '');
    lines.push('| Option | Gates | DRC | Critical nets | Routability | Why |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of (run.ranking ?? run.place.ranking).candidates) {
      const cand = run.place.candidates.find((x) => x.engineId === c.id);
      const drc = cand?.verify.metrics.drc_critical_count;
      const completion = c.metrics?.routability_completion;
      const cr = run.criticalRoutes.get(c.id);
      const critical = cr
        ? cr.unavailable
          ? 'router unavailable'
          : `${cr.nets.length - cr.unrouted.length}/${cr.nets.length} routed, ${(Object.values(cr.lengthNm).reduce((a, b) => a + b, 0) / 1e6).toFixed(0)} mm, ${cr.drcCritical} DRC`
        : 'not routed';
      lines.push(`| ${c.id.replace('placer-reuse-', '')} | ${cand ? (cand.verify.gates.placement.passed ? 'pass' : 'fail') : '-'} | ${drc === undefined ? '-' : `${drc} critical`} | ${critical} | ${completion === undefined ? 'not probed' : `${(completion * 100).toFixed(0)} %`} | ${c.reason} |`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function pcbReuse(opts: PcbReuseOptions): Promise<PcbReuseResult> {
  const log = opts.log ?? (() => {});
  const provider = opts.provider ?? null;
  const run = await reuseRun({
    ...opts,
    ...(provider
      ? {
          planner: async (input) => {
            const outcome = await planPlacement({ ...input, provider, log });
            return { plan: outcome.plan, fromModel: outcome.fromModel, reason: outcome.reason, problems: outcome.problems };
          },
        }
      : {}),
  });
  const finalRanking = run.ranking ?? run.place?.ranking ?? null;
  const ranked = new Map((finalRanking?.candidates ?? []).map((c) => [c.id, { rank: c.rank, reason: c.reason }]));
  const selected = finalRanking?.selected ?? null;

  const options: PcbReuseResult['options'] = [];
  for (const cand of run.place?.candidates ?? []) {
    const id = cand.engineId.replace('placer-reuse-', '');
    const dir = path.join(opts.runDir, 'variants', id);
    await mkdir(dir, { recursive: true });
    await writeBoardRender(dir, cand.design, cand.verify.diagnostics, log);
    await copyFile(cand.pcbPath, path.join(dir, 'board.kicad_pcb'));
    options.push({ id, engineId: cand.engineId, dir, rank: ranked.get(cand.engineId)?.rank ?? null, selected: cand.engineId === selected });
  }
  await writeFile(path.join(opts.runDir, 'options.md'), optionsMarkdown(run, ranked), 'utf8');

  let applied: string | null = null;
  if (opts.apply) {
    const wanted = opts.option ? `placer-reuse-${opts.option}` : selected;
    const cand = run.place?.candidates.find((c) => c.engineId === wanted);
    if (cand && run.place && (run.place.outcome.status === 'PASS' || run.place.outcome.status === 'PARTIAL')) {
      await copyFile(cand.pcbPath, opts.boardPath);
      applied = cand.engineId.replace('placer-reuse-', '');
    }
  }

  const legal = run.screened.filter((v) => v.metrics.legal).length;
  const base = run.place?.outcome;
  const outcome: Outcome<Diagnostic> = base
    ? {
        ...base,
        summary: `${base.summary}; ${legal}/${run.screened.length} variant(s) legal before materialising`,
        detail: [
          `matched ${(run.match.coverage * 100).toFixed(0)} % of the parts against the reference (${Object.entries(run.match.byTier).filter(([, n]) => n > 0).map(([t, n]) => `T${t}:${n}`).join(' ')})`,
          `plan from the ${run.planSource}: ${run.plan.subsystems.length} subsystem(s), ${run.plan.critical.length} critical relationship(s), ${run.plan.phases.length} phase(s)`,
          ...(applied ? [`applied option ${applied}`] : []),
          ...base.detail,
        ],
      }
    : { status: 'PARTIAL', summary: 'no variant was worth materialising', detail: run.screened.map((v) => `${v.id}: ${v.metrics.legal ? 'legal' : 'illegal'}, score ${v.score.toFixed(1)}`), diagnostics: [] };
  return { outcome, run, options, applied };
}
