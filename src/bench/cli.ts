#!/usr/bin/env node
/**
 * `copperbench run|compare|report` (implementation spec §12.4).
 */
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runSuite, writeReport, type BenchReport } from './runner.js';
import { compareReports } from './compare.js';

const program = new Command();
program.name('copperbench').description('run, compare, and report copperhead layout benchmarks').option('--repo <path>', 'repository root', process.cwd()).option('--json', 'machine-readable output', false);

program
  .command('run')
  .description('run a suite through the same routing path as copperhead pcb route')
  .argument('<suite>', 'suite file (bench/suites/*.json)')
  .option('--kind <kind>', 'routing | placement | verify | layout (default: the suite file, else routing)')
  .option('--routers <ids>', 'comma-separated router ids (routing suites)')
  .option('--placers <ids>', 'comma-separated placer ids (placement suites)')
  .option('--probe-router <id>', 'router used by the routability probe (placement suites)')
  .option('--mode <mode>', 'single | race | ensemble | staged')
  .option('--seeds <list>', 'comma-separated seeds')
  .option('--budget-seconds <n>', 'per-board engine and wall budget')
  .option('--boards <ids>', 'comma-separated board ids to run')
  .option('--track <t>', 'benchmark track letter (e|d|f|a|b|c)')
  .option('--out <dir>', 'run directory (default: bench/var/runs/<ts>-<suite>)')
  .option('--allow-harness-engines', 'let the reference router compete (fixtures only)', false)
  .option('--max-parallel <n>', 'engines in flight at once')
  .option('--max-repair-cycles <n>', 'layout suites: repair cycles after the first pass')
  .option('--no-kicad', 'skip kicad-cli (no DRC, no upgrade)')
  .action(async (suite: string, opts: { kind?: string; routers?: string; placers?: string; probeRouter?: string; mode?: string; seeds?: string; budgetSeconds?: string; boards?: string; track?: string; out?: string; allowHarnessEngines: boolean; maxParallel?: string; maxRepairCycles?: string; kicad: boolean }) => {
    const repoRoot = path.resolve(program.opts().repo as string);
    const json = Boolean(program.opts().json);
    try {
      const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
      const { report, dir } = await runSuite({
        repoRoot, suitePath: path.resolve(repoRoot, suite),
        ...(opts.kind ? { kind: opts.kind as 'routing' | 'placement' | 'verify' | 'layout' } : {}), ...(list(opts.routers) ? { routers: list(opts.routers)! } : {}), ...(list(opts.placers) ? { placers: list(opts.placers)! } : {}), ...(opts.probeRouter ? { probeRouter: opts.probeRouter } : {}), ...(opts.mode ? { mode: opts.mode as 'single' | 'race' | 'ensemble' | 'staged' } : {}),
        ...(opts.seeds ? { seeds: list(opts.seeds)!.map(Number) } : {}), ...(opts.budgetSeconds ? { budgetSeconds: Number(opts.budgetSeconds) } : {}),
        ...(list(opts.boards) ? { boards: list(opts.boards)! } : {}), ...(opts.track ? { track: opts.track } : {}), ...(opts.out ? { outDir: path.resolve(repoRoot, opts.out) } : {}),
        allowHarnessEngines: opts.allowHarnessEngines, ...(opts.maxParallel ? { maxParallel: Number(opts.maxParallel) } : {}), ...(opts.maxRepairCycles ? { maxRepairCycles: Number(opts.maxRepairCycles) } : {}), ...(opts.kicad ? {} : { noKicad: true }),
        log: json ? () => {} : (l) => console.error(l),
      });
      if (json) console.log(JSON.stringify({ dir, summary: report.summary, boards: report.boards.map((b) => ({ id: b.id, seed: b.seed, status: b.status, selected: b.selected })) }, null, 2));
      else {
        const s = report.summary;
        console.log(`${report.suite} (${report.kind}): ${s.runs} run(s), ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}; clean-pass ${(s.cleanPassRate * 100).toFixed(0)}%, regret ${s.selectionRegretTotal.toFixed(3)}, invalid-over-valid ${s.invalidOverValidCount}, overhead ${s.meanOverheadSeconds.toFixed(1)} s/board${s.hpwlVsRoutability ? `; HPWL vs routability r=${s.hpwlVsRoutability.r === null ? 'n/a' : s.hpwlVsRoutability.r.toFixed(2)} over ${s.hpwlVsRoutability.candidates} candidate(s)` : ''}${s.intent ? `; hard intent ${s.intent.hardPassed}/${s.intent.hardApplicable} passed (${(s.intent.passRate * 100).toFixed(0)}%), expected status matched ${s.intent.expectedMatched}/${s.intent.expectedTotal}` : ''}${s.repair ? `; repair needed on ${s.repair.needed}, fixed ${s.repair.fixed}, ${s.repair.meanCycles.toFixed(1)} cycle(s)/board, ${s.repair.holds} hold(s)` : ''}`);
        console.log(`report: ${path.relative(repoRoot, path.join(dir, 'report.html'))}`);
      }
      process.exit(report.boards.some((b) => b.status === 'ENGINE_ERROR' || b.status === 'INVALID_OUTPUT') ? 1 : 0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('compare')
  .description('diff two run directories (or report.json files) of the same suite')
  .argument('<a>')
  .argument('<b>')
  .action(async (a: string, b: string) => {
    try {
      const load = async (p: string) => JSON.parse(await readFile(p.endsWith('.json') ? p : path.join(p, 'report.json'), 'utf8')) as BenchReport;
      const c = compareReports(await load(a), await load(b));
      if (Boolean(program.opts().json)) console.log(JSON.stringify(c, null, 2));
      else {
        console.log(`${c.suite}: ${c.a.commit} (${c.a.startedAt}) vs ${c.b.commit} (${c.b.startedAt}); selected-candidate metrics ${c.identicalMetrics ? 'identical' : 'differ'}`);
        for (const x of c.boards) {
          const d = Object.entries(x.deltas).map(([k, [p, q]]) => `${k} ${p} → ${q}`).join(', ');
          if (x.status[0] !== x.status[1] || x.selected[0] !== x.selected[1] || d) console.log(`  ${x.id} s${x.seed}: ${x.status[0]}/${x.selected[0] ?? '—'} → ${x.status[1]}/${x.selected[1] ?? '—'}${d ? `; ${d}` : ''}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('report')
  .description('re-render report.html and summary.csv from a run directory')
  .argument('<dir>')
  .action(async (dir: string) => {
    try {
      const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')) as BenchReport;
      await writeReport(dir, report);
      console.log(path.join(dir, 'report.html'));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
