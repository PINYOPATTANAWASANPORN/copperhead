/**
 * What every placer wrapper needs: which components move, which stay, and
 * how to turn an engine's output board back into a PlacementResult without
 * trusting anything but the positions it wrote.
 */
import type { PcbDesign, ComponentInstance } from '../../ir/types.js';
import type { PlacementJob, PlacementResult } from '../contracts.js';
import type { PlacedComponent } from '../../ir/types.js';

export function movable(job: PlacementJob): ComponentInstance[] {
  const design = job.snapshot.design;
  const ids = new Set(job.movableComponentIds);
  return design.components.filter((c) => ids.has(c.id) && !c.attributes.locked);
}

export function fixedRefs(job: PlacementJob): string[] {
  const moving = new Set(movable(job).map((c) => c.id));
  return job.snapshot.design.components.filter((c) => !moving.has(c.id)).map((c) => c.reference);
}

/** Placements for the movable components as they stand in `output`, matched by refdes (engines rewrite files; uuids are not trusted). */
export function placementsFrom(job: PlacementJob, output: PcbDesign): { placements: PlacedComponent[]; unplaced: string[]; moved: number } {
  const byRef = new Map(output.components.map((c) => [c.reference, c]));
  const placements: PlacedComponent[] = [];
  const unplaced: string[] = [];
  let moved = 0;
  for (const c of movable(job)) {
    const o = byRef.get(c.reference);
    if (!o) {
      unplaced.push(c.id);
      continue;
    }
    if (o.at.x !== c.at.x || o.at.y !== c.at.y || o.rotation !== c.rotation) moved++;
    placements.push({ id: c.id, at: { x: o.at.x, y: o.at.y }, rotation: o.rotation, side: o.attributes.side });
  }
  return { placements, unplaced, moved };
}

export function identityPlacements(job: PlacementJob): PlacedComponent[] {
  return movable(job).map((c) => ({ id: c.id, at: { x: c.at.x, y: c.at.y }, rotation: c.rotation, side: c.attributes.side }));
}

export function resultShape(status: PlacementResult['status'], placements: PlacedComponent[], unplaced: string[], wall: number, provenance: PlacementResult['provenance']): PlacementResult {
  return { status, placements, unplacedComponentIds: unplaced, diagnostics: [], runtime: { wallSeconds: wall, engineSeconds: wall }, provenance };
}
