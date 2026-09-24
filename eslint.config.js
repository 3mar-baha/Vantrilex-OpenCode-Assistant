import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'apps/desktop/dist/**', 'node_modules/**', 'apps/desktop/node_modules/**', 'coverage/**', '.venv/**', '**/target/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
