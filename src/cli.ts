#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { loadConfig, resolveModel, type ModelSource } from './config.js';
import { pickModel } from './util/select.js';
import { runInit, InitError } from './memory/scaffold.js';
import { runCheck } from './commands/check.js';
import { runDoctor, formatDoctor } from './commands/doctor.js';
import { syncVerify, syncResolve, formatSyncReport } from './commands/sync.js';
import { runCreate } from './commands/create.js';
import { runDemo, demoTourText } from './commands/demo.js';
import { runRepl } from './commands/repl.js';
import {
  runExportBom,
  parseSupplier,
  parseBoards,
  parseSpares,
  ExportError,
} from './commands/export.js';
import { DEFAULT_BOARDS, DEFAULT_SPARES } from './kicad/bom-export.js';
import { runAgentLoop, type BudgetExhaustedStats } from './agent/loop.js';
import { makeRenderer } from './agent/render.js';
import { kicadCliVersion } from './kicad/cli.js';
import { loadEnvFile } from './util/env.js';
import { budgetExtraTurns, budgetPromptText, parseMaxTurns, repoOf } from './util/cli-args.js';

// Read .env from the working directory before any command resolves a model or a
// provider. Loaded here rather than per-command so `check` behaves identically,
// though check never reads a key: it stays LLM-free and network-free either way.
// A real environment variable always beats the file.
loadEnvFile(process.cwd());

// Single source of truth for the version. Both src/cli.ts (via tsx) and
// dist/cli.js sit one level below the package root, so the path holds either
// way, and a release can never ship a version string that disagrees with the
// package it was published as.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command();

async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Attended runs get a decision point instead of a rollback when the turn
 * budget runs out (issue #15). Non-TTY (CI, pipes) keeps fail-and-restore.
 */
function budgetContinuePrompt(): ((stats: BudgetExhaustedStats) => Promise<number>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (stats) =>
    (await confirmTty(budgetPromptText(stats))) ? budgetExtraTurns(stats) : 0;
}

program
  .name('copperhead')
  .description('Cursor for circuit boards: an AI agent for real KiCad repositories')
  .version(version)
  .option('--repo <path>', 'target repository (default: cwd)')
  .option('--json', 'machine-readable output')
  .option('--plain', 'plain log-style output (no interactive status line)');

const rendererOf = () =>
  makeRenderer({ json: Boolean(program.opts().json), plain: Boolean(program.opts().plain) });

program
  .command('repl', { isDefault: true })
  .description('interactive agent shell (default when no command is given)')
  .argument('[request...]', 'optional first change request before the prompt loop')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--max-turns <n>', 'turn budget per request')
  .option('--allow-dirty', 'let turns run on a dirty working tree')
  .option('--interactive', 'pause for approval after each proposal validates')
  .action(
    async (
      requestParts: string[],
      opts: { model?: string; maxTurns?: string; allowDirty?: boolean; interactive?: boolean },
    ) => {
      const repo = repoOf(program.opts());
      if (program.opts().json) {
        console.error(
          'copperhead: --json is not supported with the interactive shell. Use `copperhead do "<request>" --json`.',
        );
        process.exit(1);
      }
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const renderer = rendererOf();
        let model: string;
        let source: ModelSource;
        try {
          ({ model, source } = resolveModel(opts.model, config));
        } catch (err) {
          // No model anywhere (flag, COPPERHEAD_MODEL, config, .env keys):
          // on a TTY, offer an interactive pick instead of refusing to start.
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw err;
          console.log('No model configured for this session, pick one:');
          const chosen = await pickModel();
          if (!chosen) throw err;
          model = chosen;
          source = 'picker';
        }
        const continuePrompt = budgetContinuePrompt();
        const seed = requestParts.length ? requestParts.join(' ') : undefined;
        const res = await runRepl({
          repoRoot: repo,
          model,
          modelSource: source,
          version,
          kicadCliVersion: kicadVer,
          ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
          allowDirty: opts.allowDirty ?? false,
          interactive: opts.interactive ?? false,
          ...(seed ? { seed } : {}),
          confirm: confirmTty,
          ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
          renderer,
        });
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command('init')
  .description('scaffold docs/ from an existing schematic; idempotent')
  .option('--path <dir>', 'where to look for KiCad files', '.')
  .option('--force', 'overwrite hand-edited generated docs')
  .option('--no-hooks', 'skip git pre-commit hook installation')
  .action(async (opts: { path: string; force?: boolean; hooks: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      await kicadCliVersion();
      const res = await runInit({
        repoRoot: repo,
        searchPath: opts.path,
        force: opts.force ?? false,
        installHooks: opts.hooks,
      });
      if (program.opts().json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        for (const f of res.created) console.log(`created ${f}`);
        for (const f of res.skipped) console.log(`unchanged ${f}`);
        for (const f of res.refused) console.log(`REFUSED (hand-edited; use --force): ${f}`);
      }
      process.exit(res.refused.length ? 1 : 0);
    } catch (err) {
      console.error(err instanceof InitError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

const checkAction = async (): Promise<void> => {
  const repo = repoOf(program.opts());
  const json = Boolean(program.opts().json);
  try {
    await kicadCliVersion();
    const res = await runCheck(repo, json ? () => {} : (s) => console.log(s));
    if (json) console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
};

program
  .command('check')
  .alias('verify')
  .description('ERC + DRC + doc-drift + spec validation; no LLM calls; CI-safe')
  .action(checkAction);

// `draft` and `score` are command groups taking the artifact as a noun
// (`draft schematic` today, `draft pcb` when layout drafting exists), so the
// verb alone never has to guess what it applies to.
const draftGroup = program
  .command('draft')
  .description('deterministically draft an artifact from its declared intent; no LLM, no network');
draftGroup
  .command('schematic')
  .description('draft the schematic from schematic.intent.json')
  .option('--intent <path>', 'repo-relative intent file (default: schematic.intent.json beside the schematic)')
  .action(async (opts: { intent?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { loadConfig } = await import('./config.js');
      const { draftSchematic, defaultIntentPath, formatSchematicDraftReport } = await import('./kicad/draft/draft.js');
      const config = await loadConfig(repo);
      if (!config.schematic) {
        console.error('no schematic configured in .copperhead/config.json');
        process.exit(1);
      }
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: config.schematic,
        intentPath: opts.intent ?? defaultIntentPath(config.schematic),
        docsDir: config.docs,
      });
      if (!res.ok) {
        if (json) console.log(JSON.stringify({ ok: false, findings: res.findings }, null, 2));
        else console.error(res.message);
        process.exit(1);
      }
      if (json) console.log(JSON.stringify({ ok: true, report: res.report }, null, 2));
      else console.log(formatSchematicDraftReport(res.report));
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const scoreGroup = program
  .command('score')
  .description('quantitative quality score for an artifact; advisory exit code; no LLM, no network');
scoreGroup
  .command('schematic')
  .description('legibility and layout score for the schematic')
  .action(async () => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { loadConfig } = await import('./config.js');
      const { scoreSchematic, formatScore } = await import('./kicad/score.js');
      const path = await import('node:path');
      const config = await loadConfig(repo);
      if (!config.schematic) {
        console.error('no schematic configured in .copperhead/config.json');
        process.exit(1);
      }
      const report = await scoreSchematic(path.join(repo, config.schematic), {
        docsDir: path.join(repo, config.docs),
        ...(config.legibility ? { config: config.legibility } : {}),
      });
      console.log(json ? JSON.stringify(report, null, 2) : formatScore(report));
      process.exit(0); // the exit code never depends on the composite (AC-16.26 family)
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// `pcb` is the layout framework's command group (RFC 11 §14.2). import,
// route, verify, and score make no model or network call; only local engines
// run, and every command ends in one of the eight layout statuses.
const pcbGroup = program.command('pcb').description('PCB layout framework: import, route, verify, score (RFC 11); no LLM, no network');
const pcbExit = (status: string): never => {
  const codes: Record<string, number> = { PASS: 0, PARTIAL: 0, HOLD: 2, REFUSE: 3, UNSUPPORTED: 4, TIMEOUT: 5, ENGINE_ERROR: 6, INVALID_OUTPUT: 7 };
  process.exit(codes[status] ?? 1);
};
const pcbBoard = async (repo: string, boardOpt?: string): Promise<{ boardPath: string; config: Awaited<ReturnType<typeof import('./config.js')['loadConfig']>> }> => {
  const { loadConfig } = await import('./config.js');
  const path = await import('node:path');
  const config = await loadConfig(repo);
  const rel = boardOpt ?? config.board;
  if (!rel) {
    console.error('no board configured; pass --board or set "board" in .copperhead/config.json');
    process.exit(1);
  }
  return { boardPath: path.resolve(repo, rel), config };
};
pcbGroup
  .command('import')
  .description('read the board into the canonical IR and report what it holds')
  .option('--board <path>', 'board to import (default: the configured board)')
  .action(async (opts: { board?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath } = await pcbBoard(repo, opts.board);
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const { design, ecad, warnings } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath, ...(existsSync(proPath) ? { projectText: await readFile(proPath, 'utf8') } : {}) });
      const copper = design.board.layers.filter((l) => l.kind === 'copper').map((l) => l.id);
      const summary = { hash: design.source.contentHash, fileVersion: design.source.boardFileVersion, netDialect: design.source.netDialect, components: design.components.length, nets: design.nets.length, copperLayers: copper, segments: design.routing.segments.length, vias: design.routing.vias.length, zones: design.routing.zones.length, keepouts: design.board.keepouts.length, netClasses: ecad.netClasses.map((c) => c.name), druRules: ecad.druRules.length, lossy: design.lossy, warnings };
      if (json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`imported ${design.components.length} component(s), ${design.nets.length} net(s), ${copper.join('/')} copper, ${design.routing.segments.length} segment(s), ${design.routing.vias.length} via(s), ${design.routing.zones.length} zone(s); file version ${design.source.boardFileVersion} (${design.source.netDialect} nets); hash ${design.source.contentHash.slice(0, 12)}`);
        for (const l of design.lossy) console.log(`  lossy: ${l}`);
        for (const w of warnings) console.log(`  warning: ${w}`);
      }
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('route')
  .description('route the board with local engines, verify every candidate, and select one')
  .option('--board <path>', 'board to route (default: the configured board)')
  .option('--routers <ids>', 'comma-separated engine ids in preference order (default: config or every built-in router)')
  .option('--mode <mode>', 'single | race | ensemble | staged (default: config or single)')
  .option('--critical-nets <names>', 'staged mode: comma-separated nets routed after power and before the bulk')
  .option('--layer-pref <specs>', 'comma-separated <layer>=<horizontal|vertical|any|off>, e.g. F.Cu=horizontal,B.Cu=vertical')
  .option('--nets <names>', 'comma-separated net names to route (default: all)')
  .option('--preserve', 'keep the copper already on the board', false)
  .option('--seed <n>', 'seed for seeded engines', '0')
  .option('--budget-seconds <n>', 'engine-second and wall-clock budget')
  .option('--allow-harness-engines', 'let the reference router compete (harness fixtures only)', false)
  .option('--apply', 'write the selected candidate over the board file', false)
  .option('--run-dir <path>', 'where to write the run (default: .copperhead/runs/<ts>/layout)')
  .action(async (opts: { board?: string; routers?: string; mode?: string; nets?: string; criticalNets?: string; layerPref?: string; preserve: boolean; seed: string; budgetSeconds?: string; allowHarnessEngines: boolean; apply: boolean; runDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const { routeBoard } = await import('./pcb/engines/route.js');
      const path = await import('node:path');
      const { copyFile } = await import('node:fs/promises');
      const pcb = config.pcb ?? {};
      const budget = Number(opts.budgetSeconds ?? pcb.budgetSeconds ?? 600);
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'layout');
      const routers = opts.routers?.split(',').map((s) => s.trim()).filter(Boolean) ?? pcb.routers;
      const mode = (opts.mode ?? pcb.mode ?? 'single') as 'single' | 'race' | 'ensemble' | 'staged';
      const layerPreferences = (opts.layerPref ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
        const [layerId, m] = spec.split('=');
        if (!layerId || !['horizontal', 'vertical', 'any', 'off'].includes(m ?? '')) throw new Error(`--layer-pref: expected <layer>=<horizontal|vertical|any|off>, got "${spec}"`);
        return { layerId, mode: m as 'horizontal' | 'vertical' | 'any' | 'off' };
      });
      const res = await routeBoard({
        repoRoot: repo, boardPath, runDir, ...(routers ? { routers } : {}), mode, ...(opts.nets ? { netNames: opts.nets.split(',').map((s) => s.trim()) } : {}), ...(opts.criticalNets ? { criticalNetNames: opts.criticalNets.split(',').map((s) => s.trim()) } : {}), ...(layerPreferences.length ? { layerPreferences } : {}), preserveExistingRoutes: opts.preserve, seed: Number(opts.seed), limits: { engineSeconds: budget, wallSeconds: budget }, ...(pcb.profile ? { profile: pcb.profile } : {}), ...(pcb.scoring ? { scoring: pcb.scoring } : {}), ...(pcb.maxParallelEngines ? { maxParallel: pcb.maxParallelEngines } : {}),
        policy: { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: opts.allowHarnessEngines, denyLicenses: [] },
        log: json ? () => {} : (l) => console.error(l),
      });
      if (opts.apply) {
        const sel = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
        if (sel && (res.outcome.status === 'PASS' || res.outcome.status === 'PARTIAL')) {
          await copyFile(sel.pcbPath, boardPath);
          res.outcome.detail.push(`applied ${res.ranking.selected} to ${path.relative(repo, boardPath)}`);
        } else res.outcome.detail.push('nothing applied; the board is unchanged');
        // the evidence in docs/LAYOUT.md is what `check` re-verifies against (ADR 0009); a refusal is evidence too
        const { evidenceFromRun, recordEvidence } = await import('./pcb/layout-stage.js');
        const verdict = await recordEvidence(repo, config.docs, boardPath, await evidenceFromRun(repo, boardPath, res));
        res.outcome.detail.push(`evidence recorded in ${path.join(config.docs, 'LAYOUT.md')}${verdict.ok ? '' : ` (${verdict.reason})`}`);
      }
      if (json) console.log(JSON.stringify({ ...res.outcome, diagnostics: res.outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })), runDir: res.runDir, ranking: res.ranking, ineligible: res.ineligible }, null, 2));
      else {
        console.log(`${res.outcome.status}: ${res.outcome.summary}`);
        for (const d of res.outcome.detail) console.log(`  ${d}`);
        console.log(`  run: ${path.relative(repo, res.runDir)}`);
      }
      pcbExit(res.outcome.status);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('place')
  .description('place the board through the wrapped placers, verify every candidate, and rank them (no model)')
  .option('--board <path>', 'board to place (default: the configured board)')
  .option('--placers <ids>', 'comma-separated engine ids in preference order (default: config or every built-in placer)')
  .option('--mode <mode>', 'single | race | ensemble (default: config or single)')
  .option('--movable <refs>', 'comma-separated refdes to move (default: every part not locked in KiCad)')
  .option('--seed <n>', 'seed for seeded engines', '0')
  .option('--budget-seconds <n>', 'engine-second and wall-clock budget')
  .option('--no-probe', 'skip the routability probe on each candidate')
  .option('--probe-router <id>', 'router for the probe', 'router-freerouting')
  .option('--allow-harness-engines', 'let the reference placer and router compete (harness fixtures only)', false)
  .option('--blocks', 'staged plan: derive functional blocks from docs/SUBSYSTEMS.md and schematic.intent.json, place each block anchor in its signal-flow slot first', false)
  .option('--apply', 'write the selected candidate over the board file', false)
  .option('--run-dir <path>', 'where to write the run (default: .copperhead/runs/<ts>/placement)')
  .action(async (opts: { board?: string; placers?: string; mode?: string; movable?: string; seed: string; budgetSeconds?: string; probe: boolean; probeRouter: string; allowHarnessEngines: boolean; blocks: boolean; apply: boolean; runDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const { placeBoard } = await import('./pcb/engines/place.js');
      const path = await import('node:path');
      const { copyFile } = await import('node:fs/promises');
      const pcb = config.pcb ?? {};
      const budget = Number(opts.budgetSeconds ?? pcb.budgetSeconds ?? 600);
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'placement');
      const placers = opts.placers?.split(',').map((s) => s.trim()).filter(Boolean) ?? pcb.placers;
      const mode = (opts.mode ?? (pcb.mode === 'staged' ? 'single' : pcb.mode) ?? 'single') as 'single' | 'race' | 'ensemble';
      let blocks;
      if (opts.blocks) {
        const { readFile } = await import('node:fs/promises');
        const { existsSync } = await import('node:fs');
        const { importBoard } = await import('./pcb/ir/kicad/import.js');
        const { deriveBlocks } = await import('./pcb/intent/blocks.js');
        const subsystems = path.join(repo, config.docs, 'SUBSYSTEMS.md');
        const intentPath = config.schematic ? path.join(path.dirname(path.join(repo, config.schematic)), 'schematic.intent.json') : null;
        const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath });
        blocks = deriveBlocks({ design, subsystemsMd: existsSync(subsystems) ? await readFile(subsystems, 'utf8') : null, schematicIntent: intentPath && existsSync(intentPath) ? JSON.parse(await readFile(intentPath, 'utf8')) : null });
        if (!json) for (const b of blocks) console.error(`block ${b.id}: ${b.members.length} part(s), anchor ${b.anchor ? design.components.find((c) => c.id === b.anchor)!.reference : 'none'}, region ${b.region ? 'assigned' : 'none'}${b.notes.length ? ` (${b.notes.join('; ')})` : ''}`);
      }
      let reuse: import('./pcb/engines/placers/layout-reuse/adapter.js').LayoutBlockSpec[] | undefined;
      if (pcb.layoutBlocks?.length) {
        const { specFromBoard } = await import('./pcb/engines/placers/layout-reuse/adapter.js');
        reuse = await Promise.all(pcb.layoutBlocks.map((b) => specFromBoard(b, repo)));
        if (!json) for (const r of reuse) console.error(`layout block ${r.id}: ${r.members.length} member(s) around ${r.anchor} from ${r.source}`);
      }
      const res = await placeBoard({
        repoRoot: repo, boardPath, runDir, ...(placers ? { placers } : {}), mode, ...(opts.movable ? { movableReferences: opts.movable.split(',').map((s) => s.trim()) } : {}), ...(reuse?.length ? { reuse } : {}), seed: Number(opts.seed), limits: { engineSeconds: budget, wallSeconds: budget }, ...(pcb.profile ? { profile: pcb.profile } : {}), ...(pcb.maxParallelEngines ? { maxParallel: pcb.maxParallelEngines } : {}),
        policy: { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: opts.allowHarnessEngines || (pcb.allowHarnessEngines ?? false), denyLicenses: [] },
        probe: opts.probe ? { routerId: opts.probeRouter } : false,
        ...(blocks ? { blocks } : {}),
        log: json ? () => {} : (l) => console.error(l),
      });
      if (opts.apply) {
        const sel = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
        if (sel && (res.outcome.status === 'PASS' || res.outcome.status === 'PARTIAL')) {
          await copyFile(sel.pcbPath, boardPath);
          res.outcome.detail.push(`applied ${res.ranking.selected} to ${path.relative(repo, boardPath)}`);
        } else res.outcome.detail.push('nothing applied; the board is unchanged');
      }
      if (json) console.log(JSON.stringify({ ...res.outcome, diagnostics: res.outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })), runDir: res.runDir, ranking: res.ranking, ineligible: res.ineligible, movable: res.movableIds.length, ...(res.plan ? { plan: { stages: res.plan.stages.map((st) => ({ name: st.name, engineId: st.engineId, parts: st.componentIds.length })), blocks: res.plan.blocks.map((b) => ({ id: b.id, members: b.members.length, region: !!b.region })) } } : {}) }, null, 2));
      else {
        console.log(`${res.outcome.status}: ${res.outcome.summary}`);
        for (const d of res.outcome.detail) console.log(`  ${d}`);
        console.log(`  run: ${path.relative(repo, res.runDir)}`);
      }
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      process.exit(EXIT_CODE[res.outcome.status]);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('verify')
  .description('verify one board file: pre-flight, geometry, connectivity, return path, KiCad DRC')
  .argument('[board]', 'board file (default: the configured board)')
  .option('--no-kicad', 'skip kicad-cli (no DRC, no zone refill)')
  .action(async (board: string | undefined, opts: { kicad: boolean }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath } = await pcbBoard(repo, board);
      const path = await import('node:path');
      const { readFile, mkdtemp, cp, rm } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { refillZones, extractFills } = await import('./pcb/ir/kicad/zones.js');
      const { verifyDesign } = await import('./pcb/verify/index.js');
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
      let text = await readFile(boardPath, 'utf8');
      let drc;
      if (opts.kicad) {
        // refill on a copy so verify never mutates the user's file
        const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-verify-'));
        try {
          await cp(path.dirname(boardPath), dir, { recursive: true });
          const copy = path.join(dir, path.basename(boardPath));
          drc = await refillZones(copy);
          text = await readFile(copy, 'utf8');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      const { design } = importBoard({ boardText: text, boardPath, ...(projectText ? { projectText } : {}) });
      const v = verifyDesign({ design, fills: extractFills(text), ...(drc ? { drc } : {}) });
      const errors = v.diagnostics.filter((d) => d.severity === 'error');
      const status = !v.gates.preflight.passed ? 'REFUSE' : errors.length ? 'PARTIAL' : (v.metrics.unrouted_count ?? 0) > 0 ? 'PARTIAL' : 'PASS';
      if (json) console.log(JSON.stringify({ status, metrics: v.metrics, gates: { preflight: v.gates.preflight.passed, placement: v.gates.placement.passed, routing: v.gates.routing.passed }, disagreements: v.disagreements, diagnostics: v.diagnostics.map((d) => ({ code: d.code, severity: d.severity, entityReferences: d.entityReferences, message: d.message })) }, null, 2));
      else {
        console.log(`${status}: ${v.metrics.routed_nets ?? 0} net(s) routed, ${v.metrics.unrouted_count ?? 0} owed, ${v.metrics.shorts ?? 0} short(s), ${v.metrics.drc_error_count ?? 0} KiCad error(s); gates preflight ${v.gates.preflight.passed ? 'pass' : 'FAIL'}, placement ${v.gates.placement.passed ? 'pass' : 'FAIL'}, routing ${v.gates.routing.passed ? 'pass' : 'FAIL'}`);
        for (const d of v.diagnostics.filter((d) => d.severity !== 'info')) console.log(`  ${d.severity} ${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`);
        for (const x of v.disagreements) console.log(`  disagreement ${x.code}: ${x.a.checker} says ${x.a.says}; ${x.b.checker} says ${x.b.says}`);
      }
      process.exit(EXIT_CODE[status]);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('render')
  .description('render one board file to SVG (with the verify diagnostics marked unless --plain)')
  .argument('[board]', 'board file (default: the configured board)')
  .option('--out <path>', 'output .svg (default: beside the board)')
  .option('--plain', 'no diagnostics, no legend (thumbnail mode)', false)
  .option('--no-legend', 'keep the diagnostic markers on the board but drop the legend under it')
  .option('--scale <n>', 'pixels per millimetre', '14')
  .action(async (board: string | undefined, opts: { out?: string; plain: boolean; legend: boolean; scale: string }) => {
    const repo = repoOf(program.opts());
    try {
      const { boardPath } = await pcbBoard(repo, board);
      const path = await import('node:path');
      const { readFile, writeFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { extractFills } = await import('./pcb/ir/kicad/zones.js');
      const { verifyDesign } = await import('./pcb/verify/index.js');
      const { renderSvg } = await import('./pcb/ir/svg.js');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
      const text = await readFile(boardPath, 'utf8');
      const { design } = importBoard({ boardText: text, boardPath, ...(projectText ? { projectText } : {}) });
      const plain = opts.plain || Boolean(program.opts().plain); // the global --plain (log style) swallows the flag when it precedes the subcommand
      const diagnostics = plain ? [] : verifyDesign({ design, fills: extractFills(text) }).diagnostics;
      const out = opts.out ? path.resolve(repo, opts.out) : boardPath.replace(/\.kicad_pcb$/, '.svg');
      await writeFile(out, renderSvg(design, { diagnostics, scale: Number(opts.scale), legend: !plain && opts.legend !== false }), 'utf8');
      if (Boolean(program.opts().json)) console.log(JSON.stringify({ out, diagnostics: diagnostics.filter((d) => d.severity !== 'info').length }));
      else console.log(out);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('score')
  .description('re-rank the candidates of a run directory')
  .argument('<run-dir>', 'a run directory written by pcb route')
  .option('--scoring <profile>', 'scoring profile', 'default-low-speed-2-layer')
  .action(async (runDir: string, opts: { scoring: string }) => {
    const json = Boolean(program.opts().json);
    try {
      const path = await import('node:path');
      const { readFile, readdir, writeFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { rank } = await import('./pcb/verify/scoring.js');
      const { loadScoringProfile } = await import('./pcb/verify/profiles/scoring/index.js');
      const dir = path.resolve(runDir);
      const candidates = path.join(dir, 'candidates');
      const inputs = [];
      for (const d of existsSync(candidates) ? await readdir(candidates) : []) {
        const mp = path.join(candidates, d, 'metrics.json');
        const dp = path.join(candidates, d, 'diagnostics.json');
        if (!existsSync(mp)) continue;
        const metrics = JSON.parse(await readFile(mp, 'utf8'));
        const diags = existsSync(dp) ? (JSON.parse(await readFile(dp, 'utf8')) as { code: string; severity: string }[]) : [];
        const gateFailures = diags.filter((x) => x.severity === 'error' && !x.code.startsWith('conn.unrouted') && !x.code.startsWith('drc.') && !x.code.startsWith('quality.')).map((x) => x.code);
        inputs.push({ id: d.replace(/-\d+$/, ''), metrics, gatesPassed: gateFailures.length === 0 && (metrics.drc_critical_count ?? 0) === 0, gateFailures });
      }
      const ranking = rank(inputs, loadScoringProfile(opts.scoring));
      await writeFile(path.join(dir, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
      if (json) console.log(JSON.stringify(ranking, null, 2));
      else for (const c of ranking.candidates) console.log(`${c.rank}. ${c.id}${c.eligible ? '' : ' (ineligible)'}: ${c.reason}`);
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('env preflight: kicad-cli, git, node, and the model provider credential; no LLM, no network')
  .option('--model <model>', 'model to check the provider credential for (default: resolved like a run)')
  .action(async (opts: { model?: string }) => {
    const repo = repoOf(program.opts());
    // Unlike other commands, doctor never gates on kicad-cli being present:
    // runDoctor probes it and reports a failure instead of throwing, so a user
    // with a missing tool still gets the full report.
    const report = await runDoctor({ repoRoot: repo, model: opts.model });
    if (program.opts().json) console.log(JSON.stringify(report, null, 2));
    else {
      const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
      // || not ??: some non-interactive ptys report columns as 0.
      for (const line of formatDoctor(report, process.stdout.columns || 80, color)) console.log(line);
    }
    process.exit(report.ok ? 0 : 1);
  });

program
  .command('do')
  .description('the core loop: propose, edit, verify, propagate, commit')
  .argument('<request>', 'the change request in natural language')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code | compat:<id> (or a provider-specific model id)')
  .option('--max-turns <n>', 'turn budget for this run')
  .option('--allow-dirty', 'allow a dirty tree (snapshot via git stash create)')
  .option('--dry-run', 'propose the diff, write nothing')
  .option('--interactive', 'pause for approval after the proposal validates')
  .action(
    async (
      request: string,
      opts: { model?: string; maxTurns?: string; allowDirty?: boolean; dryRun?: boolean; interactive?: boolean },
    ) => {
      const repo = repoOf(program.opts());
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const { model, source } = resolveModel(opts.model, config);
        const continuePrompt = budgetContinuePrompt();
        const res = await runAgentLoop({
          repoRoot: repo,
          request,
          model,
          ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
          allowDirty: opts.allowDirty ?? false,
          dryRun: opts.dryRun ?? false,
          interactive: opts.interactive ?? false,
          confirm: confirmTty,
          ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
          renderer: rendererOf(),
          meta: { command: 'do', modelSource: source, version, kicadCliVersion: kicadVer },
        });
        if (program.opts().json) console.log(JSON.stringify(res, null, 2));
        process.exit(res.outcome === 'failure' ? 1 : 0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command('sync')
  .description('verify the whole design state for inconsistencies and resolve drift')
  .option('--model <model>', 'model for the resolve phase')
  .option('--dry-run', 'print the inconsistency report, write nothing')
  .action(async (opts: { model?: string; dryRun?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const report = await syncVerify(repo);
      const json = Boolean(program.opts().json);
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatSyncReport(report));
      if (opts.dryRun) {
        process.exit(report.violations.length ? 2 : 0);
      }
      if (report.violations.length) {
        // requirement violations are never auto-resolved (AC-7.3)
        process.exit(2);
      }
      if (!report.resolvable.length) {
        process.exit(0);
      }
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const res = await syncResolve(repo, report, model, json ? () => {} : (s) => console.log(s), {
        renderer: rendererOf(),
        meta: { command: 'sync', modelSource: source, version, kicadCliVersion: kicadVer },
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('demo')
  .description('tour of what copperhead does, or run the USB-C breakout create pipeline')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .option('--dir <path>', 'demo repo directory (default: demo-runs/usb-c-breakout)')
  .option('--tour', 'print the overview only; do not run the pipeline')
  .action(async (opts: { model?: string; interactive?: boolean; dir?: string; tour?: boolean }) => {
    if (opts.tour) {
      const { setColorEnabled } = await import('./agent/theme.js');
      if (program.opts().json) {
        // --json is a contract, not a suggestion: a script that passes it
        // unconditionally must never get prose back. Plain lines, no SGR.
        setColorEnabled(false);
        console.log(JSON.stringify({ tour: demoTourText().split('\n') }, null, 2));
        process.exit(0);
      }
      // Color on for attended TTY tours even without a renderer.
      setColorEnabled(Boolean(process.stdout.isTTY) && !program.opts().plain && !process.env.NO_COLOR);
      console.log(demoTourText());
      process.exit(0);
    }
    try {
      const kicadVer = await kicadCliVersion();
      // Resolve model from the caller's cwd config / env / flag; the demo repo
      // is scaffolded next and typically has no model of its own yet.
      const config = await loadConfig(repoOf(program.opts()));
      const { model, source } = resolveModel(opts.model, config);
      const continuePrompt = budgetContinuePrompt();
      const res = await runDemo({
        model,
        modelSource: source,
        version,
        kicadCliVersion: kicadVer,
        interactive: opts.interactive ?? false,
        ...(opts.dir ? { demoDir: opts.dir } : {}),
        ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
        log: (s) => console.log(s),
        renderer: rendererOf(),
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('create')
  .description('Mode A: full pipeline from a product brief to the output package')
  .requiredOption('--brief <file>', 'product brief (markdown)')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code | compat:<id> (or a provider-specific model id)')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .action(async (opts: { brief: string; model?: string; interactive?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const continuePrompt = budgetContinuePrompt();
      const res = await runCreate({
        repoRoot: repo,
        briefPath: opts.brief,
        model,
        interactive: opts.interactive ?? false,
        ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
        log: (s) => console.log(s),
        renderer: rendererOf(),
        meta: { command: 'create', modelSource: source, version, kicadCliVersion: kicadVer },
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const exportCmd = program
  .command('export')
  .description('emit supplier-ready files from repo state (deterministic; no LLM, no network)');

exportCmd
  .command('bom')
  .description('write a supplier-format BOM (jlcpcb | digikey | mouser) from docs/BOM.md')
  .requiredOption('--supplier <name>', 'jlcpcb | digikey | mouser')
  .option('--boards <n>', 'number of boards to order', String(DEFAULT_BOARDS))
  .option('--spares <percent>', 'spare parts percentage', String(DEFAULT_SPARES))
  .option('--include-unverified', 'include UNVERIFIED rows that carry an MPN (never MPN-less rows)')
  .action(async (opts: { supplier: string; boards: string; spares: string; includeUnverified?: boolean }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const supplier = parseSupplier(opts.supplier);
      const boards = parseBoards(opts.boards);
      const spares = parseSpares(opts.spares);
      const res = await runExportBom({
        repoRoot: repo,
        supplier,
        boards,
        spares,
        includeUnverified: opts.includeUnverified ?? false,
      });
      // Warnings go to stderr so a `> file` redirect of stdout stays clean and
      // the excluded-rows report is still seen.
      for (const w of res.warnings) console.error(w);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`wrote ${res.outPath} (${res.included.length} part(s), ${res.excluded.length} excluded)`);
      }
      process.exit(0);
    } catch (err) {
      // ExportError carries an actionable message (bad flag, missing BOM, drift);
      // anything else is unexpected. Both exit non-zero with no stack trace.
      console.error(err instanceof ExportError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
