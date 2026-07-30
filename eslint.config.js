// @ts-check
import tseslint from 'typescript-eslint';

const SIM_MUST_STAY_PURE =
  'sim/ is the pure Orleans model (specs/outlines/orleans-city-3d-visualization.md, ' +
  'structural rule #2): it must never import three.js. sim/ and world/ communicate only ' +
  'through an immutable SimState snapshot and a typed SimEvent bus — importing three.js ' +
  'here breaks that boundary and makes the sim untestable headless.';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  tseslint.configs.recommended,
  {
    // The architectural boundary: sim/ must never import three.js, or any
    // three/* subpath. See also src/sim/boundary.test.ts, which enforces
    // the same rule by reading the sim/ source directly from disk.
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'three', message: SIM_MUST_STAY_PURE }],
          patterns: [{ group: ['three/*'], message: SIM_MUST_STAY_PURE }],
        },
      ],
    },
  },
);
