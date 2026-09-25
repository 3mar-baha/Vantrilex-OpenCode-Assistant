import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'apps/desktop/dist/**',
      // Generated sidecar payload (bundled runtime): build output, not source.
      'apps/desktop/src-tauri/sidecar/**',
      'node_modules/**',
      'apps/desktop/node_modules/**',
      'coverage/**',
      '.venv/**',
      '**/target/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
