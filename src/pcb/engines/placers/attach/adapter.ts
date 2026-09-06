/**
 * placer-attach: stage 3 of the staged placement plan (RFC 11 §8.5). Rule
 * placement of `relative.attached` parts next to the pins they attach to,
 * and layout reuse for blocks carrying a reference. Deterministic, places
 * only what a constraint already fixes; exempt from §3.8.
 */
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import type { PlacedComponent } from '../../../ir/types.js';
import { bboxOf } from '../../../ir/geometry.js';
import { resultShape, specsOf, applySpec } from '../shared.js';

export const ATTACH_PLACER_MANIFEST: EngineManifest = {
  id: 'placer-attach',
  kind: 'placer',
  version: '1',
  adapterVersion: '1',
  license: 'Apache-2.0',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'deterministic',
  executionMode: 'library',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: {},
  capabilities: { bottomSide: false, rotation: false, arbitraryOutline: true, relativeConstraints: ['near'], fixedComponents: true, congestionAwareness: false, layoutReuse: true },
  supportedConstraints: ['relative.attached'],
};

/** `relative.attached`: part `ref` sits within `max_distance_nm` of `to` (a refdes, optionally `REF.PIN`). Travels in job.constraints as `{ kind: 'relative.attached', ref, to, max_distance_nm }`. */
export interface AttachedConstraint {
  kind: 'relative.attached';
  ref: string;
  to: string;
  max_distance_nm: number;
}

export function attachedOf(job: PlacementJob): AttachedConstraint[] {
  return job.constraints.filter((c): c is AttachedConstraint => typeof c === 'object' && c !== null && (c as { kind?: string }).kind === 'relative.attached');
}

export class AttachPlacer implements PlacerPlugin {
  async manifest(): Promise<EngineManifest> {
    return ATTACH_PLACER_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const design = job.snapshot.design;
    const movable = new Set(job.movableComponentIds);
    const byRef = new Map(design.components.map((c) => [c.reference, c]));
    const placements: PlacedComponent[] = [];
    const done = new Set<string>();
    // reuse blocks first: they fix whole groups
    for (const spec of specsOf(job)) {
      const { placements: ps, skipped } = applySpec(spec, design, movable);
      for (const s of skipped) ctx.log(`layout block ${spec.id}: skipped ${s}`);
      for (const p of ps) if (!done.has(p.id)) {
        done.add(p.id);
        placements.push(p);
      }
    }
    // then single attachments: put the part just outside the target's extent, on the side facing the pin
    for (const a of attachedOf(job)) {
      const part = byRef.get(a.ref);
      const [targetRef, pin] = a.to.split('.');
      const target = byRef.get(targetRef ?? '');
      if (!part || !target || !movable.has(part.id) || part.attributes.locked || done.has(part.id)) continue;
      const pad = pin ? target.pads.find((p) => p.number === pin) : undefined;
      const at = pad ? pad.at : target.at;
      const tb = bboxOf(target.pads.map((p) => p.copper));
      const pb = bboxOf(part.pads.map((p) => p.copper));
      const halfW = (pb.maxX - pb.minX) / 2, halfH = (pb.maxY - pb.minY) / 2;
      const gap = Math.min(a.max_distance_nm / 2, 1_000_000);
      // pick the outward direction from the target's centre through the pin
      const dx = at.x - target.at.x, dy = at.y - target.at.y;
      let x: number, y: number;
      if (Math.abs(dx) >= Math.abs(dy)) {
        x = dx >= 0 ? tb.maxX + gap + halfW : tb.minX - gap - halfW;
        y = at.y;
      } else {
        x = at.x;
        y = dy >= 0 ? tb.maxY + gap + halfH : tb.minY - gap - halfH;
      }
      done.add(part.id);
      placements.push({ id: part.id, at: { x: Math.round(x), y: Math.round(y) }, rotation: part.rotation, side: part.attributes.side });
    }
    return resultShape('complete', placements, [], (Date.now() - t0) / 1000, { engineId: ATTACH_PLACER_MANIFEST.id, engineVersion: '1', adapterVersion: '1', seed: job.seed, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() });
  }
}
