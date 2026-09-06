/**
 * copperhead-bench (implementation spec §12.4; RFC 11 §13.4, B0): the runner
 * goes through routeBoard, writes the record, two runs of one suite compare
 * byte-identical on the stable metric set, and compare refuses across
 * benchmark versions. Reference router, so the live cases skip without kicad-cli.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runSuite, loadSuite, type BenchReport } from '../src/bench/runner.js';
import { compareReports } from '../src/bench/compare.js';
import { renderHtml, summaryCsv } from '../src/bench/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

function fakeReport(over: Partial<BenchReport> = {}): BenchReport {
  const board = { id: 'completion', board: 'b', seed: 0, status: 'PASS', summary: '', selected: 'x', wallSeconds: 3, engineSeconds: 2, overheadSeconds: 1, candidates: [{ id: 'x', rank: 1, eligible: true, gateFailures: [], score: 0.1, metrics: { completion_rate: 1, total_wirelength_nm: 5, runtime_s: 2.1 } }], ineligible: [], errors: [], selectionRegret: 0, invalidOverValid: 0, runDir: 'r' };
  return { benchmarkVersion: '1', suite: 'microboards', corpus: 'golden', track: 'e', startedAt: 'a', finishedAt: 'b', harness: { copperhead: '0', commit: 'c', kicad: 'k', node: 'n', platform: 'p' }, engines: [], scoring: 's', mode: 'single', seeds: [0], budgetSeconds: 1, reproduce: 'cmd', boards: [board], summary: { boards: 1, runs: 1, byStatus: { PASS: 1 }, cleanPassRate: 1, meanCompletion: 1, selectionRegretTotal: 0, invalidOverValidCount: 0, meanOverheadSeconds: 1, meanEngineSeconds: 2, seedVariance: {} }, ...over };
}

describe('suites', () => {
  it('both committed suites load and name their corpus and tracks', async () => {
    const micro = await loadSuite(path.join(ROOT, 'bench/suites/microboards.json'));
    expect(micro.corpus).toBe('golden');
    expect(micro.cases!.length).toBe(10);
    for (const c of micro.cases!) expect(existsSync(path.join(ROOT, 'bench/golden', c, 'board.kicad_pcb')), c).toBe(true);
    const qual = await loadSuite(path.join(ROOT, 'bench/suites/pcbench-qual.json'));
    expect(qual.corpus).toBe('pcbench');
    expect(qual.boards!.length).toBe(20);
  });
});

describe('compare and report', () => {
  it('runtime differences do not break identity; a metric change does', () => {
    const a = fakeReport();
    const b = fakeReport();
    b.boards[0]!.candidates[0]!.metrics.runtime_s = 9;
    expect(compareReports(a, b).identicalMetrics).toBe(true);
    b.boards[0]!.candidates[0]!.metrics.via_count = 2;
    const c = compareReports(a, b);
    expect(c.identicalMetrics).toBe(false);
    expect(c.boards[0]!.deltas.via_count).toEqual([undefined, 2]);
  });
  it('refuses to compare across benchmark versions or suites', () => {
    expect(() => compareReports(fakeReport(), fakeReport({ benchmarkVersion: '2' }))).toThrow(/benchmark versions differ/);
    expect(() => compareReports(fakeReport(), fakeReport({ suite: 'other' }))).toThrow(/suites differ/);
  });
  it('the HTML carries the §13.4 record and the CSV one row per run', () => {
    const html = renderHtml(fakeReport({ engines: [{ id: 'router-x', version: '2.4.1', license: 'GPL-3.0-only', adopted: 'wrapped', executionMode: 'process', determinism: 'seeded' }] }));
    for (const s of ['router-x 2.4.1', 'GPL-3.0-only', 'wrapped', 'reproduce', 'cmd', 'built by copperhead', 'kicad-cli k']) expect(html).toContain(s);
    const csv = summaryCsv(fakeReport());
    expect(csv.split('\n').filter(Boolean)).toHaveLength(2);
    expect(csv).toMatch(/^board,seed,status,selected/);
  });
});

describe('runSuite (B0: byte-stable harness)', () => {
  it('runs two golden cases through routeBoard, writes the record, and repeats identically', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-bench-'));
    try {
      const base = { repoRoot: ROOT, suitePath: path.join(ROOT, 'bench/suites/microboards.json'), routers: ['router-reference'], mode: 'single' as const, boards: ['completion', 'short'], budgetSeconds: 120, allowHarnessEngines: true };
      const one = await runSuite({ ...base, outDir: path.join(dir, 'one') });
      const two = await runSuite({ ...base, outDir: path.join(dir, 'two') });
      for (const f of ['report.json', 'report.html', 'summary.csv']) expect(existsSync(path.join(one.dir, f)), f).toBe(true);
      expect(one.report.boards.map((b) => [b.id, b.status])).toEqual([['completion', 'PASS'], ['short', 'PARTIAL']]);
      expect(one.report.boards[1]!.expectedVerifyStatus).toBe('REFUSE');
      expect(one.report.engines[0]).toMatchObject({ id: 'router-reference', adopted: 'harness-only' });
      expect(one.report.summary.selectionRegretTotal).toBe(0);
      expect(one.report.summary.invalidOverValidCount).toBe(0);
      expect(one.report.summary.meanOverheadSeconds).toBeGreaterThan(0);
      expect(one.report.reproduce).toMatch(/^copperhead-bench run bench\/suites\/microboards\.json --routers router-reference/);
      const c = compareReports(one.report, two.report);
      expect(c.identicalMetrics, JSON.stringify(c.boards)).toBe(true);
      // the candidate boards are identical too, up to the uuids KiCad regenerates when it saves the refilled board
      const cand = async (r: { report: BenchReport }) => (await readFile(path.join(ROOT, r.report.boards[0]!.runDir, 'candidates', 'router-reference-0', 'candidate.kicad_pcb'), 'utf8')).replace(/\(uuid "[^"]+"\)/g, '');
      expect(await cand(one)).toBe(await cand(two));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it('the copperhead-bench CLI runs, compares, and re-renders', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-benchcli-'));
    try {
      const cli = ['tsx', 'src/bench/cli.ts', '--repo', ROOT];
      const run = await execa('npx', [...cli, '--json', 'run', 'bench/suites/microboards.json', '--routers', 'router-reference', '--allow-harness-engines', '--mode', 'single', '--boards', 'clearance', '--budget-seconds', '60', '--out', path.join(dir, 'a')], { cwd: ROOT, reject: false });
      expect(run.exitCode, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).boards[0].id).toBe('clearance');
      const cmp = await execa('npx', [...cli, 'compare', path.join(dir, 'a'), path.join(dir, 'a')], { cwd: ROOT, reject: false });
      expect(cmp.exitCode, cmp.stderr).toBe(0);
      expect(cmp.stdout).toMatch(/identical/);
      await writeFile(path.join(dir, 'a', 'report.html'), '', 'utf8');
      const rep = await execa('npx', [...cli, 'report', path.join(dir, 'a')], { cwd: ROOT, reject: false });
      expect(rep.exitCode, rep.stderr).toBe(0);
      expect((await readFile(path.join(dir, 'a', 'report.html'), 'utf8')).length).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
