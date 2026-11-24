import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { plugin as shadcn } from '@shadcn/lint';
import { policy } from './house-rules/index.mjs';

export default [
  { ignores: ['vendor/**', 'data/corpus/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.agents/**', '**/.codex/**', '**/.opencode/**', '**/.wrangler/**'] },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx}'],
    languageOptions: { ecmaVersion: 'latest', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { shadcn },
    rules: Object.fromEntries(Object.entries(policy.rules).filter(([name]) => !name.startsWith('@typescript-eslint/'))),
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: { '@typescript-eslint/no-non-null-assertion': policy.rules['@typescript-eslint/no-non-null-assertion'] },
  },
  { files: ['test/**', 'scripts/**', 'services/**'], rules: { 'no-console': 'off' } },
  { files: ['test/**'], rules: { 'max-lines-per-function': 'off' } },
];
