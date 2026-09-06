/**
 * Golden microboards (RFC 11 B0, ADR 0003): every board loads in KiCad and its
 * DRC report matches expected.json's `drc` block: the seeded fault's error
 * types all appear, only those plus the listed consequential types appear,
 * and the unconnected-item count is exact. Skipped without kicad-cli, like the
 * other DRC-backed tests.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runDrc } from '../src/kicad/cli.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'golden');

interface Expected {
  case: string;
  status: string;
  diagnostics: { code: string; entityReferences: string[] }[];
  drc: { errorTypes: string[]; consequential?: string[]; unconnected: number };
}

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

const cases = (await readdir(GOLDEN, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe('golden microboards', () => {
  it('has the ten cases the RFC names', () => {
    expect(cases).toEqual([
      'clearance', 'completion', 'congestion', 'decoupling-far', 'fixed-connector',
      'keepout', 'open', 'outside-board', 'overlap', 'short',
    ]);
  });

  it.each(cases)('%s: expected.json is well formed', async (name) => {
    const exp = JSON.parse(await readFile(path.join(GOLDEN, name, 'expected.json'), 'utf8')) as Expected;
    expect(exp.case).toBe(name);
    expect(['PASS', 'PARTIAL', 'HOLD', 'REFUSE']).toContain(exp.status);
    expect(exp.diagnostics.length).toBeGreaterThan(0);
    for (const d of exp.diagnostics) expect(d.code).toMatch(/^(geom|conn|drc|intent|quality)\./);
    expect(Array.isArray(exp.drc.errorTypes)).toBe(true);
    expect(Number.isInteger(exp.drc.unconnected)).toBe(true);
  });

  it.each(cases)('%s: KiCad DRC reports what expected.json says', async (name) => {
    if (!(await haveKicad())) return;
    const exp = JSON.parse(await readFile(path.join(GOLDEN, name, 'expected.json'), 'utf8')) as Expected;
    const report = await runDrc(path.join(GOLDEN, name, 'board.kicad_pcb'));
    const errorTypes = new Set(report.violations.map((v) => v.type));
    for (const t of exp.drc.errorTypes) expect(errorTypes, `${name}: missing ${t}`).toContain(t);
    const allowed = new Set([...exp.drc.errorTypes, ...(exp.drc.consequential ?? [])]);
    for (const t of errorTypes) expect(allowed, `${name}: unexpected error type ${t}`).toContain(t);
    expect(report.unrouted.length, `${name}: unconnected items`).toBe(exp.drc.unconnected);
  }, 120_000);
});
