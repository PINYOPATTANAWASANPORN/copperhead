/**
 * `copperhead review`: a grounded design review (RFC 17 over RFC 13).
 *
 *   1. sweep    copperhead-tools review: every applicable deterministic check, no model
 *   2. bundle   copperhead-tools review-bundle: the closed context, every input by hash
 *   3. passes   one model pass per domain, read-only queries, proposals pre-checked as they come
 *   4. verify   copperhead-tools review-verify over every pass's sample: the report is rendered
 *               from what the verifiers decided, never from the model's prose
 *   5. record   samples, passes, verifications, report and a lockfile; `--replay` re-verifies the
 *               stored samples without a model and must reproduce the report byte for byte
 *
 * Nothing here writes the design: the design directory is an input, the record goes to --out.
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../agent/types.js';
import { DOMAINS, digest, domainTask, sha256, systemPrompt, TEMPLATE_VERSION, RULES } from './prompts.js';
import { type PassRecord, PASS_TOOLS, runPass } from './pass.js';
import { resolveTools, type ToolsClient } from './tools-client.js';

export interface ReviewOptions {
  design: string;
  out: string;
  sources: string[];
  model: string;
  domains: string[];
  maxTurns: number;
  maxMinutes: number;
  parallel: number;
  label?: string;
  sweep?: string;
  /** Fabrication outputs (Gerber and drill directories or zips, BOM and placement files): swept, and retained as sources. */
  fab?: string[];
  /** A manufacturer capability profile for fab-rules. */
  fabProfile?: string;
  tools?: string;
  /** Continue a record a killed run left: reuse its sweep and bundle, keep every pass that ended, rerun the rest. */
  resume?: boolean;
  /** A copperhead-tools client to use instead of resolving one (tests). */
  client?: ToolsClient;
  makeProvider: (model: string) => Promise<Provider>;
  log: (line: string) => void;
}

export interface ReviewOutcome {
  out: string;
  report: string;
  summary: Record<string, unknown>;
  passes: { domain: string; outcome: string; turns: number; proposals: number; seconds: number; error: string | null }[];
}

/** Outcomes of a pass that ran to an end; any other sample is a pass a killed run interrupted. */
const ENDED = new Set(['submitted', 'turns-exhausted', 'time-exhausted', 'stalled']);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function emptyOrAbsent(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function verify(tools: ToolsClient, bundle: string, proposals: string, outDir: string): Promise<Record<string, unknown>> {
  const r = await tools.run('review-verify', { bundle, proposals, out: outDir });
  return r.summary ?? {};
}

export async function runReview(o: ReviewOptions): Promise<ReviewOutcome> {
  const out = path.resolve(o.out);
  const design = path.resolve(o.design);
  if (!o.resume && !(await emptyOrAbsent(out))) throw new Error(`--out ${out} is not empty; give a new directory for the review record, or --resume it`);
  const rel = path.relative(design, out);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('--out must lie outside the design directory: a review never writes into the design');
  for (const d of o.domains) if (!DOMAINS[d]) throw new Error(`unknown domain "${d}"; domains are ${Object.keys(DOMAINS).join(', ')}`);
  await mkdir(path.join(out, 'model', 'samples'), { recursive: true });
  const tools = o.client ?? (await resolveTools(o.tools));
  const started = new Date();

  const resumable = o.resume && (await exists(path.join(out, 'bundle.json')));
  if (o.resume && !resumable) o.log('resume: no bundle in the record; starting from the sweep');

  // 1. sweep
  let sweepDir: string;
  if (resumable) {
    sweepDir = (await exists(path.join(out, 'sweep', 'review.json'))) ? path.join(out, 'sweep') : path.resolve(o.sweep ?? path.join(out, 'sweep'));
    o.log(`resume: reusing the sweep at ${sweepDir}`);
  } else if (o.sweep) {
    sweepDir = path.resolve(o.sweep);
    o.log(`sweep: using the record at ${sweepDir}`);
  } else {
    sweepDir = path.join(out, 'sweep');
    o.log('sweep: copperhead-tools review (every applicable deterministic check)');
    const fab = (o.fab ?? []).map((f) => path.resolve(f));
    const r = await tools.run('review', { input: [design, ...fab], 'out-dir': sweepDir, ...(o.fabProfile ? { profile: path.resolve(o.fabProfile) } : {}) });
    o.log(`sweep: ${JSON.stringify(r.summary)}`);
  }

  // 2. bundle
  const bundlePath = path.join(out, 'bundle.json');
  const sources = [...o.sources, ...(o.fab ?? [])].map((s) => path.resolve(s));
  let bundleSha: string;
  if (resumable) {
    bundleSha = sha256(await readFile(bundlePath, 'utf8'));
    o.log(`resume: reusing the bundle (sha256 ${bundleSha.slice(0, 12)})`);
  } else {
    const b = await tools.run('review-bundle', { drop: design, sweep: sweepDir, sources, ...(o.label ? { label: o.label } : {}), out: bundlePath });
    bundleSha = String((b.data as { sha256?: string }).sha256 ?? '');
    o.log(`bundle: ${JSON.stringify(b.summary)}`);
  }
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Parameters<typeof digest>[0];
  const system = systemPrompt(digest(bundle));

  // 3. passes
  const passes: PassRecord[] = await pool(o.domains, o.parallel, async (domain) => {
    const sample = path.join(out, 'model', 'samples', `${domain}.json`);
    if (resumable && (await exists(sample))) {
      const prior = JSON.parse(await readFile(sample, 'utf8')) as PassRecord;
      if (ENDED.has(prior.outcome) && prior.turns > 0) {
        o.log(`[${domain}] resume: keeping the pass that ended ${prior.outcome} after ${prior.turns} turns`);
        return prior;
      }
      await copyFile(sample, `${sample}.interrupted-${Date.now()}`);
    }
    o.log(`[${domain}] pass starts (${DOMAINS[domain]!.title})`);
    let provider: Provider;
    try {
      provider = await o.makeProvider(o.model);
    } catch (e) {
      return { domain, model: o.model, turns: 0, outcome: 'failed', error: (e as Error).message, inputTokens: 0, outputTokens: 0, startedAt: new Date().toISOString(), seconds: 0, proposals: [], calls: [], transcript: [], summary: null } satisfies PassRecord;
    }
    const save = (r: PassRecord) => writeFile(sample, `${JSON.stringify(r, null, 1)}\n`);
    const rec = await runPass({ domain, model: o.model, provider, tools, bundlePath, system, task: domainTask(domain, o.maxTurns), maxTurns: o.maxTurns, maxSeconds: o.maxMinutes * 60, turnTimeoutMs: 10 * 60_000, log: o.log, onTurn: save });
    await save(rec);
    o.log(`[${domain}] pass ends: ${rec.outcome} after ${rec.turns} turns, ${rec.proposals.length} proposals, ${rec.seconds} s${rec.error ? ` (${rec.error})` : ''}`);
    return rec;
  });

  // 4. verify
  const proposals = passes.flatMap((p) => p.proposals);
  const proposalsPath = path.join(out, 'model', 'proposals.json');
  await writeFile(proposalsPath, `${JSON.stringify({ format: 'copperhead-review-proposals', version: 1, proposals }, null, 1)}\n`);
  const summary = await verify(tools, bundlePath, proposalsPath, path.join(out, 'verify'));
  await copyFile(path.join(out, 'verify', 'report.md'), path.join(out, 'report.md'));

  // 5. record
  const toolsManifest = await tools.run('review-query', { bundle: bundlePath, op: 'calculators' }).then((r) => r.package ?? null).catch(() => null);
  const templates = { rules: sha256(RULES), tools: sha256(JSON.stringify(PASS_TOOLS)), ...Object.fromEntries(o.domains.map((d) => [`task-${d}`, sha256(domainTask(d, o.maxTurns))])) };
  await writeFile(
    path.join(out, 'model', 'passes.json'),
    `${JSON.stringify(passes.map((p) => ({ domain: p.domain, model: p.model, outcome: p.outcome, error: p.error, turns: p.turns, proposals: p.proposals.length, inputTokens: p.inputTokens, outputTokens: p.outputTokens, startedAt: p.startedAt, seconds: p.seconds, summary: p.summary })), null, 1)}\n`,
  );
  const lock = {
    format: 'copperhead-review-lock',
    version: 1,
    startedAt: started.toISOString(),
    design: design,
    bundle: { path: 'bundle.json', sha256: bundleSha },
    sweep: path.relative(out, sweepDir).startsWith('..') ? sweepDir : path.relative(out, sweepDir),
    tools: { command: tools.command, package: toolsManifest },
    model: { id: o.model, decoding: 'provider default (not pinnable through this provider)', samplesPerPass: 1 },
    templates: { version: TEMPLATE_VERSION, sha256: templates },
    domains: o.domains,
    fab: (o.fab ?? []).map((f) => path.resolve(f)),
    fabProfile: o.fabProfile ? path.resolve(o.fabProfile) : null,
    budgets: { maxTurns: o.maxTurns, maxMinutes: o.maxMinutes, parallel: o.parallel },
    proposals: { path: 'model/proposals.json', sha256: sha256(await readFile(proposalsPath, 'utf8')) },
    report: { path: 'report.md', sha256: sha256(await readFile(path.join(out, 'report.md'), 'utf8')) },
  };
  await writeFile(path.join(out, 'review.lock.json'), `${JSON.stringify(lock, null, 1)}\n`);
  return {
    out,
    report: path.join(out, 'report.md'),
    summary,
    passes: passes.map((p) => ({ domain: p.domain, outcome: p.outcome, turns: p.turns, proposals: p.proposals.length, seconds: p.seconds, error: p.error })),
  };
}

/** Re-verify a record's stored samples with no model, and compare the report with the recorded one. */
export async function replayReview(record: string, toolsFlag: string | undefined, log: (line: string) => void, client?: ToolsClient): Promise<{ identical: boolean; report: string; replayReport: string }> {
  const dir = path.resolve(record);
  const lock = JSON.parse(await readFile(path.join(dir, 'review.lock.json'), 'utf8')) as { bundle: { sha256: string }; proposals: { sha256: string }; report: { sha256: string } };
  const tools = client ?? (await resolveTools(toolsFlag));
  const bundlePath = path.join(dir, 'bundle.json');
  const proposalsPath = path.join(dir, 'model', 'proposals.json');
  if (sha256(await readFile(proposalsPath, 'utf8')) !== lock.proposals.sha256) throw new Error('model/proposals.json differs from the lockfile: the stored samples were changed');
  const replayDir = path.join(dir, 'replay');
  await mkdir(replayDir, { recursive: true });
  log('replay: re-verifying the stored samples (no model)');
  await verify(tools, bundlePath, proposalsPath, replayDir);
  const a = await readFile(path.join(dir, 'report.md'), 'utf8');
  const b = await readFile(path.join(replayDir, 'report.md'), 'utf8');
  return { identical: a === b && sha256(b) === lock.report.sha256, report: path.join(dir, 'report.md'), replayReport: path.join(replayDir, 'report.md') };
}
