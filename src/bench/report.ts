/**
 * Report rendering for benchmark runs: a summary CSV and a self-contained
 * HTML page carrying the RFC 11 §13.4 record.
 */
import type { BenchReport, BoardRecord } from './runner.js';

const ROUTING_METRICS = ['completion_rate', 'unrouted_count', 'drc_error_count', 'drc_critical_count', 'shorts', 'total_wirelength_nm', 'via_count', 'bend_count', 'pour_largest_share', 'runtime_s'];
const PLACEMENT_METRICS = ['routability_completion', 'routability_drc_errors', 'hpwl_nm', 'congestion_overflow', 'courtyard_overlap_count', 'outside_board_count', 'unplaced_count', 'runtime_s'];
const VERIFY_METRICS: string[] = [];
const metricsFor = (r: BenchReport) => (r.kind === 'placement' ? PLACEMENT_METRICS : r.kind === 'verify' ? VERIFY_METRICS : ROUTING_METRICS);

function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function fmt(key: string, v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '';
  if (key.endsWith('_nm')) return `${(v / 1e6).toFixed(2)} mm`;
  if (key.endsWith('_rate') || key.endsWith('_share')) return `${(v * 100).toFixed(1)}%`;
  if (key === 'runtime_s') return `${v.toFixed(1)} s`;
  return String(v);
}

export function summaryCsv(report: BenchReport): string {
  const METRICS = metricsFor(report);
  const head = ['board', 'seed', 'status', 'selected', 'wall_s', 'engine_s', 'overhead_s', 'regret', 'invalid_over_valid', ...METRICS];
  const rows = report.boards.map((b) => {
    const m = b.candidates.find((c) => c.id === b.selected)?.metrics ?? {};
    return [b.id, b.seed, b.status, b.selected ?? '', b.wallSeconds.toFixed(2), b.engineSeconds.toFixed(2), b.overheadSeconds.toFixed(2), b.selectionRegret, b.invalidOverValid, ...METRICS.map((k) => m[k] ?? '')].join(',');
  });
  return [head.join(','), ...rows].join('\n') + '\n';
}

function boardRow(b: BoardRecord, METRICS: string[]): string {
  const sel = b.candidates.find((c) => c.id === b.selected);
  const cands = b.candidates.map((c) => `<li class="${c.eligible ? 'ok' : 'bad'}">${esc(c.id)} · rank ${c.rank} · score ${c.score === null || c.score === undefined ? '—' : c.score.toFixed(3)}${c.gateFailures.length ? ` · ${esc(c.gateFailures.join(', '))}` : ''}</li>`).join('');
  const inel = b.ineligible.map((i) => `<li class="muted">${esc(i.engineId)}: ${esc(i.reasons.join('; '))}</li>`).join('');
  const errs = b.errors.map((e) => `<li class="bad">${esc(e)}</li>`).join('');
  const cyc = b.cycles?.length ? `<li>cycles: ${esc(b.cycles.map((c) => `${c.n}${c.action ? ` ${c.action}` : ''} → ${c.status} (${c.errors} err, ${c.owed} owed, ${c.seconds.toFixed(0)} s)`).join('; '))}</li>` : '';
  const ver = b.verify ? `<li>gates: preflight ${b.verify.gates.preflight ? 'ok' : 'FAIL'}, placement ${b.verify.gates.placement ? 'ok' : 'FAIL'}, routing ${b.verify.gates.routing ? 'ok' : 'FAIL'}</li><li>${b.verify.intentHardViolations} of ${b.verify.intentHardApplicable} hard intent constraint(s) violated${b.verify.expectedStatus ? ` · expected ${esc(b.verify.expectedStatus)} ${b.verify.matched ? '✓' : '✗'}` : ''}</li>${b.verify.errors.length ? `<li class="bad">${esc(b.verify.errors.join(', '))}</li>` : ''}` : '';
  return `<tr class="s-${esc(b.status)}"><td class="board">${esc(b.id)}<div class="muted">seed ${b.seed}${b.expectedVerifyStatus ? ` · verify owes ${esc(b.expectedVerifyStatus)}` : ''}</div></td><td class="status"><b>${esc(b.status)}</b><div class="muted">${esc(b.summary)}</div></td><td>${esc(b.selected ?? '—')}</td>${METRICS.map((k) => `<td class="num">${fmt(k, sel?.metrics[k])}</td>`).join('')}<td class="num">${b.wallSeconds.toFixed(1)} / ${b.engineSeconds.toFixed(1)} / ${b.overheadSeconds.toFixed(1)}</td><td><ul>${cands}${inel}${errs}${ver}${cyc}</ul></td></tr>`;
}

export function renderHtml(r: BenchReport): string {
  const s = r.summary;
  const METRICS = metricsFor(r);
  const status = Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ');
  return `<!doctype html><meta charset="utf-8"><title>copperbench · ${esc(r.suite)}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #ddd;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f0f0f0;font-weight:600}
td.num{text-align:right;white-space:nowrap}td.status{min-width:220px}td.board{min-width:120px}.muted{color:#777;font-size:12px}ul{margin:0;padding-left:16px;font-size:12px}.ok{color:#1a7f37}.bad{color:#b42318}
.s-PASS td:first-child{border-left:4px solid #1a7f37}.s-PARTIAL td:first-child{border-left:4px solid #b26b00}.s-REFUSE td:first-child,.s-ENGINE_ERROR td:first-child,.s-INVALID_OUTPUT td:first-child{border-left:4px solid #b42318}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.gallery figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:6px;padding:6px}.gallery img{width:100%;height:160px;object-fit:contain;background:#f6f4ee}.gallery figcaption{font-size:12px;padding-top:4px}.kv div:nth-child(odd){color:#555}code{background:#eee;padding:1px 4px;border-radius:3px}
</style>
<h1>copperbench · ${esc(r.suite)} · ${esc(r.kind ?? 'routing')} · track ${esc(r.track)}</h1>
<div class="muted">${esc(r.startedAt)} → ${esc(r.finishedAt)} · benchmark version ${esc(r.benchmarkVersion)}</div>
<h2>Summary</h2>
<div class="kv">
<div>boards / runs</div><div>${s.boards} / ${s.runs}</div>
<div>status</div><div>${esc(status)}</div>
<div>clean-pass rate</div><div>${(s.cleanPassRate * 100).toFixed(1)}%</div>
<div>mean completion (selected)</div><div>${(s.meanCompletion * 100).toFixed(1)}%</div>
<div>selection regret (total)</div><div>${s.selectionRegretTotal.toFixed(4)}</div>
<div>invalid-over-valid selections</div><div>${s.invalidOverValidCount}</div>
<div>mean engine / overhead seconds</div><div>${s.meanEngineSeconds.toFixed(1)} / ${s.meanOverheadSeconds.toFixed(1)}</div>
${Object.keys(s.seedVariance).length ? `<div>seed variance (wirelength CV)</div><div>${esc(Object.entries(s.seedVariance).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(' · '))}</div>` : ''}
${s.repair ? `<div>repair</div><div>${s.repair.needed} board(s) needed repair, ${s.repair.fixed} fixed by the cycles; ${s.repair.meanCycles.toFixed(1)} cycle(s) per board; ${s.repair.holds} hold(s)</div>` : ''}
${s.intent ? `<div>hard intent constraints</div><div>${s.intent.hardPassed} of ${s.intent.hardApplicable} passed (${(s.intent.passRate * 100).toFixed(0)}%); expected status matched on ${s.intent.expectedMatched} of ${s.intent.expectedTotal} board(s)</div>` : ''}
${s.hpwlVsRoutability ? `<div>HPWL vs probe completion</div><div>Pearson r ${s.hpwlVsRoutability.r === null ? 'n/a' : s.hpwlVsRoutability.r.toFixed(2)} over ${s.hpwlVsRoutability.candidates} eligible candidate(s); mean completion ${(s.hpwlVsRoutability.meanCompletion * 100).toFixed(1)}%</div>` : ''}
</div>
<h2>Record (RFC 11 §13.4)</h2>
<div class="kv">
<div>harness</div><div>copperhead ${esc(r.harness.copperhead)} @ ${esc(r.harness.commit)} · kicad-cli ${esc(r.harness.kicad)} · node ${esc(r.harness.node)} · ${esc(r.harness.platform)}</div>
<div>corpus</div><div>${esc(r.corpus)}${r.corpusCommit ? ` @ ${esc(r.corpusCommit)}` : ''}</div>
<div>engines</div><div>${r.engines.map((e) => `${esc(e.id)} ${esc(e.version)} · ${esc(e.license)} · ${esc(e.adopted)} · ${esc(e.executionMode)} · ${esc(e.determinism)}`).join('<br>')}</div>
<div>built by copperhead</div><div>IR, adapter, snapshot, verification, scoring (${esc(r.scoring)}), ranking, orchestration (${esc(r.mode)}), provenance</div>
<div>seeds / budget</div><div>${esc(r.seeds.join(', '))} / ${r.budgetSeconds} s per board</div>
<div>reproduce</div><div><code>${esc(r.reproduce)}</code></div>
</div>
<h2>Gallery</h2>
<div class="gallery">${r.boards.map((b) => { const rel = (p: string) => '../'.repeat(3) + p; const img = r.kind === 'layout' && b.runDir ? rel(`${b.runDir}/board.svg`) : b.selectedDir ? rel(`${b.selectedDir}/candidate.svg`) : ''; return img ? `<figure><a href="${esc(img)}"><img src="${esc(img)}" alt="${esc(b.id)}" loading="lazy"></a><figcaption><b>${esc(b.id)}</b> · ${esc(b.status)}${b.selected ? ` · ${esc(b.selected)}` : ''}</figcaption></figure>` : `<figure><figcaption><b>${esc(b.id)}</b> · ${esc(b.status)} · no candidate</figcaption></figure>`; }).join('')}</div>
<h2>Boards</h2>
<table><thead><tr><th>board</th><th>status</th><th>selected</th>${METRICS.map((k) => `<th>${esc(k)}</th>`).join('')}<th>wall / engine / overhead s</th><th>candidates</th></tr></thead>
<tbody>${r.boards.map((b) => boardRow(b, METRICS)).join('\n')}</tbody></table>
`;
}
