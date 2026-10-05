import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';
import { normalizeProposal, runPass } from '../src/review/pass.js';
import { digest, domainTask } from '../src/review/prompts.js';
import { replayReview, runReview } from '../src/review/run.js';
import type { ToolsClient, ToolsResult } from '../src/review/tools-client.js';

/**
 * `copperhead review` (grounded review): the orchestration, with a scripted model and a fake
 * copperhead-tools. The deterministic tools are tested in copperhead-tools; here the contract is
 * what copperhead sends them, what the model sees, and what the record holds.
 */

function scriptedProvider(turns: Partial<Turn>[]): Provider & { seen: Msg[][]; closed: number } {
  let i = 0;
  const p = {
    name: 'scripted',
    seen: [] as Msg[][],
    closed: 0,
    async chat(messages: Msg[]): Promise<Turn> {
      p.seen.push([...messages]);
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return { text: t.text ?? null, toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })), usage: t.usage ?? { inputTokens: 100, outputTokens: 10 } };
    },
    async close() {
      p.closed++;
    },
  };
  return p;
}

const BUNDLE = {
  format: 'copperhead-review-bundle',
  version: 1,
  label: 'fake board',
  design: { source: 'x.kicad_net', generator: 'test', components: [{ ref: 'U1', value: 'EXA', footprint: 'Lib:Pkg', dnp: false, fields: {} }], nets: [{ name: 'GND', nodes: [{ ref: 'U1', pin: '2', pinName: 'GND' }] }] },
  board: null,
  sweep: { findings: [{ severity: 'major', code: 'drc-triage.x', title: 'a sweep finding', evidenceClass: 'tool' }], envelope: [{ title: 'fabrication rules', examined: false, reason: 'no Gerbers' }] },
  sources: [{ id: 'ds/exa.txt', kind: 'datasheet', pages: 3 }],
  notes: [],
};

/** A copperhead-tools stand-in: records every request and answers each tool from a table. */
function fakeTools(): ToolsClient & { calls: { tool: string; inputs: Record<string, unknown> }[] } {
  const calls: { tool: string; inputs: Record<string, unknown> }[] = [];
  return {
    command: ['fake-tools'],
    calls,
    async run(tool, inputs): Promise<ToolsResult> {
      calls.push({ tool, inputs });
      const ok = (data: Record<string, unknown>, summary: Record<string, unknown> = {}): ToolsResult => ({ status: 'ok', tool: { id: tool, version: '0' }, package: { name: 'fake', version: '0' }, data, summary });
      if (tool === 'review') {
        await mkdir(String(inputs['out-dir']), { recursive: true });
        await writeFile(path.join(String(inputs['out-dir']), 'review.json'), '{}');
        return ok({}, { completed: 1 });
      }
      if (tool === 'review-bundle') {
        await writeFile(String(inputs.out), JSON.stringify(BUNDLE));
        return ok({ sha256: 'b'.repeat(64) }, { parts: 1 });
      }
      if (tool === 'review-query') return ok({ ok: true, text: `answer to ${String(inputs.op)} ${String(inputs.args ?? '')}` });
      if (tool === 'review-verify') {
        const doc = JSON.parse(await readFile(String(inputs.proposals), 'utf8')) as { proposals: { id: string; kind: string }[] };
        const verifications = doc.proposals.map((p) => ({ id: p.id, kind: p.kind, outcome: 'VERIFIED', class: 'VERIFIED', verifier: 'claim-check', reason: 'ok', claim: 'U1.2 is on GND' }));
        if (inputs.out) {
          await mkdir(String(inputs.out), { recursive: true });
          await writeFile(path.join(String(inputs.out), 'report.md'), `# report\n${doc.proposals.map((p) => p.id).join(', ')}\n`);
        }
        return ok({ verifications }, { proposals: verifications.length });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

describe('review: the model\'s view', () => {
  it('reads the arguments of a call however the model names them', () => {
    const catalog = new Set(['search']);
    const parse = (raw: string) => parseToolCalls(raw, () => 'x', catalog).toolCalls[0]?.args;
    expect(parse('{"tool": "search", "args": {"pattern": "SDO"}}')).toEqual({ pattern: 'SDO' });
    expect(parse('{"tool": "search", "arguments": {"pattern": "SDO"}}')).toEqual({ pattern: 'SDO' });
    expect(parse('{"tool": "search", "pattern": "SDO", "source": "lis3dh"}')).toEqual({ pattern: 'SDO', source: 'lis3dh' });
    expect(parse('{"tool": "search"}')).toEqual({});
  });

  it('shows the coverage gaps and every net in the bundle digest, and names the domain in the task', () => {
    const d = digest(BUNDLE);
    expect(d).toContain('GND: U1.2(GND)');
    expect(d).toContain('fabrication rules: no Gerbers');
    expect(d).toContain('[major] drc-triage.x');
    expect(domainTask('L', 30)).toMatch(/Your domain is L: physical\.[\s\S]*30 turns/);
  });

  it('prefixes proposal ids and their references with the domain', () => {
    expect(normalizeProposal('P', { id: 'F1', kind: 'finding', premises: ['C1', 'P.C2'] })).toMatchObject({ id: 'P.F1', domain: 'P', premises: ['P.C1', 'P.C2'] });
    expect(normalizeProposal('S', { id: 'K1', kind: 'calculation', inputs: { v: { value: '3.3 V', from: 'C1' }, r: { value: '10k', from: 'design:R1' }, x: { value: '1 V', from: 'assumption: y' } } }).inputs).toEqual({
      v: { value: '3.3 V', from: 'S.C1' },
      r: { value: '10k', from: 'design:R1' },
      x: { value: '1 V', from: 'assumption: y' },
    });
  });
});

describe('review: one pass', () => {
  it('queries through review-query, pre-checks proposals through review-verify, and ends on submit', async () => {
    const tools = fakeTools();
    const bundlePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'review-test-')), 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(BUNDLE));
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'net', args: { net: 'GND' } }] },
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: { 'pin-on-net': { pin: 'U1.2', net: 'GND' } } }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: 'done' } }] },
    ]);
    const rec = await runPass({ domain: 'P', model: 'scripted', provider, tools, bundlePath, system: 'sys', task: 'task', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(rec).toMatchObject({ outcome: 'submitted', turns: 3, summary: 'done', proposals: [{ id: 'P.P1', domain: 'P' }] });
    expect(tools.calls.map((c) => c.tool)).toEqual(['review-query', 'review-verify']);
    expect(tools.calls[0]!.inputs).toMatchObject({ op: 'net', args: '{"net":"GND"}' });
    expect(rec.calls[1]!.result).toMatch(/^P\.P1: VERIFIED as VERIFIED \(claim-check\): ok/);
    expect(provider.closed).toBeGreaterThan(0);
  });

  it('retries a turn that times out once, and ends the pass on a second in a row', async () => {
    const tools = fakeTools();
    let calls = 0;
    const slowOnce: Provider = {
      name: 'slow',
      async chat(): Promise<Turn> {
        calls++;
        if (calls === 1) await new Promise((r) => setTimeout(r, 200));
        return { text: null, toolCalls: [{ id: `c${calls}`, name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ok = await runPass({ domain: 'P', model: 's', provider: slowOnce, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 50, log: () => undefined });
    expect(ok).toMatchObject({ outcome: 'submitted', turns: 2 });
    expect(ok.calls[0]!.tool).toBe('(timeout)');
    const never: Provider = { name: 'never', chat: () => new Promise(() => undefined) };
    const failed = await runPass({ domain: 'P', model: 's', provider: never, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 20, log: () => undefined });
    expect(failed).toMatchObject({ outcome: 'failed', turns: 2, error: expect.stringMatching(/turn exceeded/) });
  });

  it('stops a pass that never calls a tool, and warns before the turns run out', async () => {
    const tools = fakeTools();
    const stalled = await runPass({ domain: 'M', model: 's', provider: scriptedProvider([{ text: 'thinking' }]), tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(stalled).toMatchObject({ outcome: 'stalled', turns: 3 });
    const p = scriptedProvider([{ toolCalls: [{ name: 'nets', args: {} }] }]);
    const out = await runPass({ domain: 'M', model: 's', provider: p, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(out).toMatchObject({ outcome: 'turns-exhausted', turns: 5 });
    expect(p.seen.at(-1)!.some((m) => m.role === 'user' && /turns left/.test(m.content))).toBe(true);
  });
});

describe('review: the run and its record', () => {
  it('runs the sweep, the bundle, a pass per domain and the verification, never writing the design', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    await writeFile(path.join(design, 'board.kicad_sch'), '(kicad_sch)');
    const tools = fakeTools();
    const script = (d: string) => scriptedProvider([
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: d } }] },
    ]);
    let n = 0;
    const out = path.join(root, 'record');
    const res = await runReview({ design, out, sources: [], model: 'scripted', domains: ['P', 'L'], maxTurns: 5, maxMinutes: 5, parallel: 2, makeProvider: async () => script(String(n++)), log: () => undefined, client: tools });
    expect(res.passes.map((p) => [p.domain, p.outcome, p.proposals])).toEqual([['P', 'submitted', 1], ['L', 'submitted', 1]]);
    expect(await readdir(design)).toEqual(['board.kicad_sch']);
    expect(await readFile(path.join(out, 'report.md'), 'utf8')).toBe('# report\nP.P1, L.P1\n');
    const lock = JSON.parse(await readFile(path.join(out, 'review.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ format: 'copperhead-review-lock', domains: ['P', 'L'], model: { id: 'scripted' } });
    expect(Object.keys(lock.templates.sha256)).toEqual(['rules', 'tools', 'task-P', 'task-L']);
    expect(await readdir(path.join(out, 'model', 'samples'))).toEqual(['L.json', 'P.json']);
    const replay = await replayReview(out, undefined, () => undefined, tools);
    expect(replay.identical).toBe(true);
    expect(tools.calls.filter((c) => c.tool === 'review-verify').at(-1)!.inputs.out).toBe(path.join(out, 'replay'));
    await writeFile(path.join(out, 'model', 'proposals.json'), '{"proposals": []}');
    await expect(replayReview(out, undefined, () => undefined, tools)).rejects.toThrow(/differs from the lockfile/);
  }, 30_000);

  it('resumes a killed run: keeps ended passes, reruns interrupted ones, reuses the bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const tools = fakeTools();
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    const base = { design, out, sources: [], model: 's', maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: tools };
    await runReview({ ...base, domains: ['P'], makeProvider: async () => submitter() });
    const sample = path.join(out, 'model', 'samples', 'L.json');
    await writeFile(sample, JSON.stringify({ domain: 'L', outcome: 'running', turns: 2, proposals: [] }));
    let made = 0;
    const res = await runReview({ ...base, domains: ['P', 'L'], resume: true, makeProvider: async () => (made++, submitter()) });
    expect(made).toBe(1);
    expect(res.passes.map((p) => [p.domain, p.outcome])).toEqual([['P', 'submitted'], ['L', 'submitted']]);
    expect(tools.calls.filter((c) => c.tool === 'review-bundle')).toHaveLength(1);
    expect((await readdir(path.join(out, 'model', 'samples'))).some((f) => f.startsWith('L.json.interrupted-'))).toBe(true);
  }, 30_000);

  it('refuses a record directory inside the design, or one that is not empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const base = { sources: [], model: 's', domains: ['P'], maxTurns: 1, maxMinutes: 1, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, design: root, out: path.join(root, 'rec') })).rejects.toThrow(/outside the design/);
    const full = path.join(root, 'full');
    await mkdir(full);
    await writeFile(path.join(full, 'x'), '');
    await expect(runReview({ ...base, design: path.join(root, 'd'), out: full })).rejects.toThrow(/not empty/);
  });
});
