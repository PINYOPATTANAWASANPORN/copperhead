import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReport, formatViolations } from '../src/kicad/report.js';
import { REPORTS } from './helpers.js';

const load = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(REPORTS, name), 'utf8'));

describe('report normalizer', () => {
  it('normalizes a clean ERC report', async () => {
    const r = normalizeReport(await load('erc-clean.json'), 'erc');
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('normalizes a clean DRC report', async () => {
    const r = normalizeReport(await load('drc-clean.json'), 'drc');
    expect(r.ok).toBe(true);
  });

  it('carries type, severity, and location for violations (AC-2.2 source)', async () => {
    const r = normalizeReport(await load('erc-unconnected-pin.json'), 'erc');
    expect(r.ok).toBe(false);
    const pin = r.violations.find((v) => v.type === 'pin_not_connected');
    expect(pin).toBeDefined();
    expect(pin!.severity).toBe('error');
    expect(pin!.sheet).toBe('/');
    expect(pin!.items[0]!.x).toBeTypeOf('number');
  });

  it('tolerates unknown shapes', () => {
    expect(normalizeReport({}, 'erc').ok).toBe(true);
    // a violation with no severity defaults to error, so it still blocks
    expect(normalizeReport({ violations: [{}] }, 'drc').violations).toHaveLength(1);
  });

  it('keeps warning-severity findings advisory (lib_footprint_mismatch must not block a draft)', () => {
    const r = normalizeReport(
      { violations: [{ type: 'lib_footprint_mismatch', severity: 'warning', description: "Footprint 'X' does not match copy in library 'L'", items: [] }] },
      'drc',
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(formatViolations(r)).toMatch(/DRC: clean; 1 warning\(s\) \(advisory, do not block\)/);
  });
});

describe('DRC unrouted connections', () => {
  // A first-draft layout leaves nets as ratsnest by design, so KiCad's
  // `unconnected_items` are work not done, not rules broken: reported apart
  // from violations and not counted against `ok`.
  it('keeps unconnected_items out of ok and lists them as unrouted', () => {
    const r = normalizeReport(
      { violations: [], unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing connection between items', items: [] }] },
      'drc',
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.unrouted).toHaveLength(1);
    expect(formatViolations(r)).toMatch(/DRC: clean; 1 unrouted connection\(s\) remain/);
  });
  it('still fails on a real violation and says both', () => {
    const r = normalizeReport(
      { violations: [{ type: 'courtyards_overlap', severity: 'error', description: 'Courtyards overlap', items: [] }], unconnected_items: [{ type: 'unconnected_items' }] },
      'drc',
    );
    expect(r.ok).toBe(false);
    expect(formatViolations(r)).toMatch(/1 violation\(s\); 1 unrouted/);
  });
});
