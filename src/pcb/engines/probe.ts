/**
 * Routability probe (implementation spec §5.3): route a placement candidate
 * with one router in a fixed configuration and report completion and DRC
 * errors as metrics, never as gates. Lives with the engines because it runs
 * one; the verify layer never imports it.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { routeBoard, type RouteOptions } from './route.js';
import type { EngineRegistry, EnginePolicy } from './registry.js';

export interface ProbeOptions {
  repoRoot: string;
  /** The materialized placement candidate. */
  pcbPath: string;
  workDir: string;
  routerId?: string;
  budgetSeconds?: number;
  registry?: EngineRegistry;
  policy?: EnginePolicy;
  noKicad?: boolean;
  log?: (line: string) => void;
}

export const PROBE_STRATEGY = { passes: 10 } as const;

export async function routabilityProbe(opts: ProbeOptions): Promise<{ routability_completion: number; routability_drc_errors: number; probe_engine?: string }> {
  const projectPath = opts.pcbPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  const routeOpts: RouteOptions = {
    repoRoot: opts.repoRoot,
    boardPath: opts.pcbPath,
    ...(existsSync(projectPath) ? { projectPath } : {}),
    runDir: path.join(opts.workDir, 'probe'),
    routers: [opts.routerId ?? 'router-freerouting'],
    mode: 'single',
    strategy: { ...PROBE_STRATEGY },
    seed: 0,
    limits: { engineSeconds: opts.budgetSeconds ?? 120, wallSeconds: opts.budgetSeconds ?? 120 },
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.noKicad ? { noKicad: true } : {}),
    log: opts.log ?? (() => {}),
  };
  const res = await routeBoard(routeOpts);
  const sel = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : res.candidates[0];
  if (!sel) return { routability_completion: 0, routability_drc_errors: 0 };
  return { routability_completion: sel.verify.metrics.completion_rate ?? 0, routability_drc_errors: sel.verify.metrics.drc_error_count ?? 0, probe_engine: sel.engineId } as { routability_completion: number; routability_drc_errors: number; probe_engine?: string };
}
