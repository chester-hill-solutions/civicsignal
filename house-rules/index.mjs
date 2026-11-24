export const policy = {
  id: 'callcaster-lint@1',
  rules: {
    complexity: ['warn', { max: 20 }],
    'max-depth': ['warn', { max: 4 }],
    'max-params': ['warn', { max: 5 }],
    'max-lines-per-function': ['warn', { max: 200, skipBlankLines: true, skipComments: true }],
    'no-console': 'warn',
    'no-return-await': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    'shadcn/no-restyle': ['warn', { allow: ['layout'] }],
    'shadcn/no-raw-colors': 'warn',
    'shadcn/no-arbitrary-values': 'warn',
    'shadcn/no-inline-styles': 'warn',
    'shadcn/no-unknown-classes': 'warn',
    'shadcn/require-static-classes': 'warn',
  },
};

export default { policy };
