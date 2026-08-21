import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-installer/**',
      'node_modules/**',
      'drizzle/**',
      'coverage/**',
      'build/**',
      // Bundle de terceiros, minificado: lintar isso rendia 258 dos 394 erros que o
      // `npm run lint` acusava — ruído suficiente para ninguém mais olhar a saída.
      'src/public/vendor/**',
      'cloud/node_modules/**',
      'cloud/dist/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // `const { ok, ...rest } = obj` para OMITIR uma chave é intenção, não código morto.
          ignoreRestSiblings: true,
        },
      ],
      // `catch {}` deliberado (best-effort que não deve derrubar o fluxo) é padrão neste
      // projeto; o que a regra ainda pega é bloco vazio de if/for/while, que é sempre bug.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Scripts servidos ao navegador: rodam sem bundler, em escopo global de <script>.
    // Sem isto, `window`/`document`/`fetch` viravam `no-undef` (92 erros) e toda função
    // de topo — que as views chamam por nome — virava "defined but never used".
    files: ['src/public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, Alpine: 'readonly' },
    },
  },
);
