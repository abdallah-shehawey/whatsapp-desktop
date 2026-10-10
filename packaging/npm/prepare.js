'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const destination = path.join(root, 'dist/npm');
fs.rmSync(destination, { recursive: true, force: true });
const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
fs.mkdirSync(destination, { recursive: true });
for (const name of ['src', 'data', 'LICENSE', 'README.md']) {
  fs.cpSync(path.join(root, name), path.join(destination, name), { recursive: true });
}
fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'whatsapp-desktop.js'), path.join(destination, 'bin/whatsapp-desktop.js'));
fs.chmodSync(path.join(destination, 'bin/whatsapp-desktop.js'), 0o755);
const manifest = {
  name: '@abdallah-shehawey/whatsapp-desktop',
  productName: source.productName,
  version: source.version,
  description: source.description,
  license: source.license,
  author: source.author,
  repository: { type: 'git', url: 'git+https://github.com/abdallah-shehawey/whatsapp-desktop.git' },
  homepage: 'https://github.com/abdallah-shehawey/whatsapp-desktop#readme',
  main: source.main,
  bin: { 'whatsapp-desktop': 'bin/whatsapp-desktop.js' },
  files: ['src', 'data', 'bin', 'LICENSE', 'README.md'],
  os: ['linux'],
  engines: { node: '>=22' },
  dependencies: { electron: lock.packages['node_modules/electron'].version },
  publishConfig: { registry: 'https://npm.pkg.github.com' },
};
fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(destination);
