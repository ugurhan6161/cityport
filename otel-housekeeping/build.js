const fs = require('node:fs');
const path = require('node:path');

const outputDirectory = path.join(__dirname, 'public');
const staticFiles = [
  'index.html',
  'app.js',
  'firebase-config.js',
  'manifest.json',
  'responsive.css',
  'styles.css',
];

fs.mkdirSync(outputDirectory, { recursive: true });

for (const file of staticFiles) {
  fs.copyFileSync(path.join(__dirname, file), path.join(outputDirectory, file));
}
