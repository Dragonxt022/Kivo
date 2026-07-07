const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'src', 'views');
const dest = path.resolve(__dirname, '..', 'dist', 'views');

fs.cpSync(src, dest, { recursive: true });
