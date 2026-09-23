const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

fs.cpSync(path.join(root, 'src', 'views'), path.join(root, 'dist', 'views'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'public'), path.join(root, 'dist', 'public'), { recursive: true });

// Documentação técnica (Markdown) do app local: copia para dist/docs como fallback, caso o
// deploy do cloud não tenha o monorepo ao lado (ver src/devdocs.ts). Se não existir, ignora.
const docsSrc = path.join(root, '..', 'src', 'docs');
if (fs.existsSync(docsSrc)) {
  fs.cpSync(docsSrc, path.join(root, 'dist', 'docs'), { recursive: true });
}
