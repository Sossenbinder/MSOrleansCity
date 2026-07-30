// Enforces structural rule #2 from specs/outlines/orleans-city-3d-visualization.md:
// "sim/ never imports three.js". This test is the runtime backstop for the
// eslint.config.js `no-restricted-imports` override — it reads every .ts file
// under src/sim/ straight from disk, so it can't be bypassed by editor config,
// a disabled lint rule, or a lint step skipped in some environment.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SIM_DIR = join(import.meta.dirname, '.');

// Matches a static import, dynamic import, or require call that names the
// three package (or any subpath of it), in either quote style. Deliberately
// does not appear as a literal example anywhere else in this file's prose —
// this file lives under sim/ too, and is itself scanned below.
const THREE_IMPORT_PATTERN =
  /(?:from|require\(|import\()\s*['"]three(?:\/[^'"]*)?['"]/;

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (stats.isFile() && entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('sim/ three.js boundary', () => {
  it('never imports three.js from any file under src/sim/', () => {
    const simFiles = collectTsFiles(SIM_DIR);

    // Sanity check: this test must actually be walking real files, or a
    // refactor that moves sim/ elsewhere would make it pass vacuously.
    expect(simFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];

    for (const filePath of simFiles) {
      const contents = readFileSync(filePath, 'utf-8');
      if (THREE_IMPORT_PATTERN.test(contents)) {
        offenders.push(filePath);
      }
    }

    expect(
      offenders,
      `sim/ must never import three.js, but found a three.js import in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
