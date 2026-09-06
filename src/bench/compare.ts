/**
 * Diff two benchmark reports of the same benchmark version and suite;
 * refuses otherwise so a comparison never spans a changed protocol.
 */
import type { BenchReport } from './runner.js';

export interface Comparison {
  suite: string;
  a: { startedAt: string; commit: string };
  b: { startedAt: string; commit: string };
  /** Every selected-candidate metric byte-identical across the two runs (B0's byte-stable claim). */
  identicalMetrics: boolean;
  boards: { id: string; seed: number; status: [string, string]; selected: [string | null, string | null]; deltas: Record<string, [number | undefined, number | undefined]> }[];
  summary: { cleanPassRate: [number, number]; meanCompletion: [number, number]; meanOverheadSeconds: [number, number] };
}

export function compareReports(a: BenchReport, b: BenchReport): Comparison {
  if (a.benchmarkVersion !== b.benchmarkVersion) throw new Error(`benchmark versions differ (${a.benchmarkVersion} vs ${b.benchmarkVersion}); a comparison must span one protocol`);
  if (a.suite !== b.suite) throw new Error(`suites differ (${a.suite} vs ${b.suite})`);
  const key = (x: { id: string; seed: number }) => `${x.id}#${x.seed}`;
  const bIndex = new Map(b.boards.map((x) => [key(x), x]));
  let identical = true;
  const boards: Comparison['boards'] = [];
  for (const x of a.boards) {
    const y = bIndex.get(key(x));
    if (!y) {
      identical = false;
      continue;
    }
    const mx = x.candidates.find((c) => c.id === x.selected)?.metrics ?? {};
    const my = y.candidates.find((c) => c.id === y.selected)?.metrics ?? {};
    const deltas: Record<string, [number | undefined, number | undefined]> = {};
    for (const k of new Set([...Object.keys(mx), ...Object.keys(my)])) {
      if (k === 'runtime_s' || k.startsWith('pcbworld.time')) continue; // wall-clock is not part of the stable set
      if (mx[k] !== my[k]) {
        identical = false;
        deltas[k] = [mx[k], my[k]];
      }
    }
    if (x.status !== y.status || x.selected !== y.selected) identical = false;
    boards.push({ id: x.id, seed: x.seed, status: [x.status, y.status], selected: [x.selected, y.selected], deltas });
  }
  if (b.boards.length !== a.boards.length) identical = false;
  return {
    suite: a.suite,
    a: { startedAt: a.startedAt, commit: a.harness.commit },
    b: { startedAt: b.startedAt, commit: b.harness.commit },
    identicalMetrics: identical,
    boards,
    summary: { cleanPassRate: [a.summary.cleanPassRate, b.summary.cleanPassRate], meanCompletion: [a.summary.meanCompletion, b.summary.meanCompletion], meanOverheadSeconds: [a.summary.meanOverheadSeconds, b.summary.meanOverheadSeconds] },
  };
}
