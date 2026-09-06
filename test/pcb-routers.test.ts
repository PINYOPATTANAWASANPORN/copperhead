/**
 * Router wrappers (ADR 0008; RFC 11 §9.2). DSN emission follows KiCad's
 * exporter conventions (verified against pcbnew when COPPERHEAD_TEST_PCBNEW=1),
 * the session parser is pinned to a real Freerouting 2.4.1 session captured
 * on the completion golden board, every failure kind is named, and the live
 * runs need the tools from bench/corpora/tools.sh.
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot } from '../src/pcb/ir/snapshot.js';
import { emitDsn } from '../src/pcb/engines/routers/freerouting/dsn.js';
import { parseSes } from '../src/pcb/engines/routers/freerouting/ses.js';
import { FreeroutingRouter, resolveJar, resolveJava } from '../src/pcb/engines/routers/freerouting/adapter.js';
import { KicadToolsRouter, resolveKct, toCodeDialect } from '../src/pcb/engines/routers/kicad-tools/adapter.js';
import { EngineError } from '../src/pcb/ir/status.js';
import { mmToNm } from '../src/pcb/ir/units.js';
import type { RoutingJob, RunContext } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'bench', 'golden');
const FIX = path.join(HERE, 'fixtures', 'pcb');
const mm = mmToNm;

async function completion() {
  const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
  const text = await readFile(pcb, 'utf8');
  const projectText = await readFile(path.join(GOLDEN, 'completion', 'board.kicad_pro'), 'utf8');
  return { pcb, text, projectText, design: importBoard({ boardText: text, boardPath: pcb, projectText, now: 't' }).design };
}

const job = (design: Awaited<ReturnType<typeof completion>>['design'], extra: Partial<RoutingJob> = {}): RoutingJob => ({
  runId: 'r', snapshot: makeSnapshot(design, { kind: 'routing', netIds: null, region: null, preserveExistingRoutes: false }),
  scope: { netIds: null, region: null, preserveExistingRoutes: false }, strategy: {}, hardConstraints: [], objectives: [], seed: 1, limits: { engineSeconds: 120, wallSeconds: 120, memoryMb: 1024 }, ...extra,
});

const ctxIn = (workDir: string, boardPath: string): RunContext => ({ workDir, boardPath, log: () => {} });

describe('DSN emission', () => {
  it('follows the KiCad exporter conventions', async () => {
    const { design } = await completion();
    const dsn = emitDsn(design, { boardName: 'completion', edgeClearanceNm: mm(0.3) });
    expect(dsn).toContain('(resolution um 10)');
    expect(dsn).toContain('(layer F.Cu');
    expect(dsn).toContain('(layer B.Cu');
    // U1 at (116, 113) front, rotation 0 -> um, Y negated
    expect(dsn).toMatch(/\(place U1 116000 -113000 front 0/);
    // every pad is a pin in some image; images are deduped per footprint geometry
    const pins = (dsn.match(/\(pin /g) ?? []).length;
    const images = (dsn.match(/\(image /g) ?? []).length;
    expect(images).toBe(new Set(design.components.map((c) => c.footprint.libId)).size);
    expect(pins).toBe(design.components.filter((c, i, a) => a.findIndex((x) => x.footprint.libId === c.footprint.libId) === i).reduce((s, c) => s + c.pads.length, 0));
    // boundary is inset by the edge clearance: 100..136 x 100..126 mm becomes 100.3..135.7
    expect(dsn).toMatch(/\(boundary\s+\(path pcb 0 100300 -100300/);
    for (const n of design.nets.filter((n) => n.padIds.length >= 2)) expect(dsn).toContain(`(net ${n.name}`);
    expect(dsn).toContain('(pins U1-8');
    expect(dsn).toContain('(class kicad_default');
    expect(dsn).toContain('(wiring\n  )'); // nothing preserved
  });

  it('places back-side parts with 180 + rotation and quotes odd names', async () => {
    const { design } = await completion();
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    u1.attributes.side = 'back';
    u1.rotation = 45_000;
    u1.reference = 'U 1';
    const dsn = emitDsn(design, { boardName: 'x', edgeClearanceNm: 0 });
    expect(dsn).toMatch(/\(place "U 1" 116000 -113000 back 225/);
  });

  it('matches pcbnew\'s own Specctra export on placement (COPPERHEAD_TEST_PCBNEW=1)', async () => {
    if (process.env.COPPERHEAD_TEST_PCBNEW !== '1') return;
    const { pcb, design } = await completion();
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-dsn-'));
    try {
      const py = process.env.COPPERHEAD_PCBNEW_PYTHON ?? '/usr/bin/python3';
      const out = path.join(dir, 'kicad.dsn');
      await execa(py, ['-c', `import pcbnew; b=pcbnew.LoadBoard(${JSON.stringify(pcb)}); pcbnew.ExportSpecctraDSN(b, ${JSON.stringify(out)})`], { env: { ...process.env, PYTHONPATH: process.env.COPPERHEAD_PCBNEW_PYTHONPATH ?? '/usr/lib/python3/dist-packages' } });
      const kicad = await readFile(out, 'utf8');
      const ours = emitDsn(design, { boardName: 'completion', edgeClearanceNm: 0 });
      const places = (t: string) => [...t.matchAll(/\(place (\S+) (-?[\d.]+) (-?[\d.]+) (front|back) (-?[\d.]+)/g)].map((m) => `${m[1]} ${Math.round(Number(m[2]))} ${Math.round(Number(m[3]))} ${m[4]} ${Number(m[5])}`).sort();
      expect(places(ours)).toEqual(places(kicad));
      const pinsOf = (t: string) => (t.match(/\(pin /g) ?? []).length;
      expect(pinsOf(ours)).toBe(pinsOf(kicad));
      const netPins = (t: string) => [...t.matchAll(/\(net (\S+)\s+\(pins ([^)]+)\)/g)].map((m) => `${m[1]}:${m[2].trim().split(/\s+/).sort().join(' ')}`).sort();
      expect(netPins(ours)).toEqual(netPins(kicad));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('SES import', () => {
  it('reads the captured Freerouting 2.4.1 session at resolution-unit scale', async () => {
    const { design } = await completion();
    const ses = await readFile(path.join(FIX, 'completion-freerouting.ses'), 'utf8');
    const r = parseSes(ses, { copperLayers: ['F.Cu', 'B.Cu'], netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 'test' });
    expect(r.nets.sort()).toEqual(['GND', 'SIG1', 'SIG2', 'VCC', 'XI', 'XO']);
    const paths = (ses.match(/\(path /g) ?? []).length;
    expect(paths).toBe(21);
    expect(r.segments.length).toBeGreaterThanOrEqual(paths);
    const widths = new Set(r.segments.map((s) => s.width));
    expect(widths).toEqual(new Set([mm(0.25), mm(0.1874)]));
    expect(r.vias).toHaveLength(3);
    expect(r.vias[0]!.size).toBe(mm(0.6));
    expect(r.vias[0]!.drill).toBe(mm(0.3));
    for (const s of r.segments) expect(['F.Cu', 'B.Cu']).toContain(s.layer);
    // coordinates land on the board (100..136 x 100..126 mm) and Y is negated back
    for (const s of r.segments) {
      expect(s.a.x).toBeGreaterThan(mm(100));
      expect(s.a.x).toBeLessThan(mm(136));
      expect(s.a.y).toBeGreaterThan(mm(100));
      expect(s.a.y).toBeLessThan(mm(126));
    }
    // deterministic ids
    const again = parseSes(ses, { copperLayers: ['F.Cu', 'B.Cu'], netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 'test' });
    expect(again.segments.map((s) => s.id)).toEqual(r.segments.map((s) => s.id));
  });

  it('refuses an unknown layer', async () => {
    const { design } = await completion();
    const ses = (await readFile(path.join(FIX, 'completion-freerouting.ses'), 'utf8')).replace('(path B.Cu', '(path In1.Cu');
    expect(() => parseSes(ses, { copperLayers: ['F.Cu', 'B.Cu'], netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 't' })).toThrow(/In1\.Cu/);
  });
});

describe('Freerouting failure kinds are named', () => {
  it('no-binary, no-runtime, runtime-too-old', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fr-'));
    try {
      const { pcb, design } = await completion();
      await expect(resolveJar('/nowhere/freerouting.jar', {})).rejects.toMatchObject({ kind: 'no-binary' });
      expect(resolveJava({ COPPERHEAD_JAVA: '/x/java' })).toBe('/x/java');
      const jar = path.join(dir, 'freerouting-9.9.9.jar');
      await writeFile(jar, '', 'utf8');
      const missing = new FreeroutingRouter({ jar, java: path.join(dir, 'no-such-java') });
      await expect(missing.route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'no-runtime' });
      const oldJava = path.join(dir, 'java');
      await writeFile(oldJava, '#!/bin/sh\necho "Error: LinkageError occurred while loading main class app.freerouting.Freerouting" >&2\necho "java.lang.UnsupportedClassVersionError: app/freerouting/Freerouting has been compiled by a more recent version of the Java Runtime (class file version 69.0)" >&2\nexit 1\n', 'utf8');
      await chmod(oldJava, 0o755);
      const old = new FreeroutingRouter({ jar, java: oldJava });
      await expect(old.route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'runtime-too-old' });
      const silent = path.join(dir, 'java-silent');
      await writeFile(silent, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(silent, 0o755);
      await expect(new FreeroutingRouter({ jar, java: silent }).route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'no-output' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('live engines (bench/corpora/tools.sh)', () => {
  const tools = path.join(ROOT, 'bench', 'var', 'tools');
  it('Freerouting routes the completion board (COPPERHEAD_TEST_FREEROUTING=1)', async () => {
    if (process.env.COPPERHEAD_TEST_FREEROUTING !== '1' || !existsSync(path.join(tools, 'jre25', 'bin', 'java'))) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fr-live-'));
    try {
      const { pcb, design } = await completion();
      const r = await new FreeroutingRouter({ repoRoot: ROOT, passes: 10 }).route(job(design), ctxIn(dir, pcb));
      expect(r.status).toBe('complete');
      expect(r.unroutedNetIds).toEqual([]);
      expect(r.segments.length).toBeGreaterThan(10);
      expect(r.provenance.invocation?.binary).toContain('java');
      expect(existsSync(path.join(dir, 'board.dsn'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('kicad-tools routes the completion board (COPPERHEAD_TEST_KICAD_TOOLS=1)', async () => {
    if (process.env.COPPERHEAD_TEST_KICAD_TOOLS !== '1' || !existsSync(resolveKct(process.env, ROOT))) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-kct-live-'));
    try {
      const { pcb, text, design } = await completion();
      const boardCopy = path.join(dir, 'board.kicad_pcb');
      await writeFile(boardCopy, text, 'utf8');
      const r = await new KicadToolsRouter({ repoRoot: ROOT }).route(job(design, { strategy: { strategy: 'basic' }, limits: { engineSeconds: 240, wallSeconds: 240, memoryMb: 2048 } }), ctxIn(dir, boardCopy));
      expect(['complete', 'partial']).toContain(r.status);
      expect(r.segments.length).toBeGreaterThan(0);
      expect(r.segments.every((s) => design.nets.some((n) => n.id === s.netId))).toBe(true);
      void pcb;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe('real-world board dialects', () => {
  // spisolator (PCBench, MIT): a KiCad 4 board with a back-side SOIC, upgraded by kicad-cli to the KiCad 10 format
  const fixture = path.join(HERE, 'fixtures', 'pcb', 'spisolator.kicad_pcb');
  it('presents back-side images from the top view like KiCad\'s exporter (pins mirrored, [T] padstacks, place back rot+180)', async () => {
    const { design } = importBoard({ boardText: await readFile(fixture, 'utf8'), boardPath: fixture, now: 't' });
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    expect(u1.attributes.side).toBe('back');
    const dsn = emitDsn(design, { boardName: 'spisolator', edgeClearanceNm: 0 });
    // numbers from pcbnew.ExportSpecctraDSN on the same board
    expect(dsn).toMatch(/\(place U1 148590 -114935 back 180 /);
    const image = /\(image "?SMD_Packages:SOIC-14_N"?[\s\S]*?\n    \)/.exec(dsn)![0];
    expect(image).toMatch(/\(pin "?Rect\[T\]Pad_508x1343_um_0_\w+"? 1 -3810 -3402\)/);
    expect(image).toMatch(/\(pin "?Rect\[T\]Pad_508x1343_um_\d+_\w+"? 8 3810 3148\)/);
    expect(image).not.toMatch(/\[B\]/);
  });
  it('rewrites the KiCad 10 net dialect into net codes for kct without touching anything else', async () => {
    const text = await readFile(fixture, 'utf8');
    const { design } = importBoard({ boardText: text, boardPath: fixture, now: 't' });
    expect(design.source.netDialect).toBe('name');
    const out = toCodeDialect(text, design);
    expect(out).toMatch(/\n\t\(net 0 ""\)\n\t\(net \d+ "GND"\)/);
    expect(out).not.toMatch(/\(net "[^"]*"\)/);
    expect((out.match(/\(net \d+ "\/BUFEN"\)/g) ?? []).length).toBeGreaterThan(1);
    const back = importBoard({ boardText: out, boardPath: fixture, now: 't' }).design;
    expect(back.source.netDialect).toBe('code');
    expect(back.nets.map((n) => n.name).sort()).toEqual(design.nets.map((n) => n.name).sort());
    expect(back.components.flatMap((c) => c.pads.map((p) => p.netId && back.nets.find((n) => n.id === p.netId)!.name))).toEqual(design.components.flatMap((c) => c.pads.map((p) => p.netId && design.nets.find((n) => n.id === p.netId)!.name)));
  });
  it('chains an outline with a legacy 2.5 µm gap', async () => {
    const p = path.join(ROOT, 'bench', 'var', 'corpora', 'pcbench-upgraded', 'kitspace_piezo_amplifier.kicad_pcb');
    if (!existsSync(p)) return;
    const { design, warnings } = importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' });
    expect(warnings.filter((w) => /unclosed/.test(w))).toEqual([]);
    expect(design.board.outline.outer.length).toBeGreaterThanOrEqual(4);
  });
});
