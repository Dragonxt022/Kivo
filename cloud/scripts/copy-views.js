const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

fs.cpSync(path.join(root, 'src', 'views'), path.join(root, 'dist', 'views'), { recursive: true });
fs.cpSync(path.join(root, 'src', 'public'), path.join(root, 'dist', 'public'), { recursive: true });
