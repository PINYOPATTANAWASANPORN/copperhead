/**
 * Where engine binaries fetched by bench/corpora/tools.sh live. They sit under
 * the copperhead checkout (or the installed package), not under the user's
 * board repository, so every resolver looks in both places.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The copperhead package root (this file is <root>/src|dist/pcb/engines/tools.*). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** Candidate `bench/var/tools` directories: the target repo first, then the copperhead package. */
export function toolsDirs(repoRoot: string): string[] {
  const dirs = [path.join(repoRoot, 'bench', 'var', 'tools'), path.join(packageRoot(), 'bench', 'var', 'tools')];
  return [...new Set(dirs)].filter((d) => existsSync(d));
}
