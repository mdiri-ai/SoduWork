'use strict';

const fs = require('node:fs');
const path = require('node:path');

const manifest = require('./armonel-release.json');
const noticeNames = Object.freeze(['LICENSE', 'THIRD_PARTY_LICENSES.txt']);

function selectRelease(platform, arch) {
  const target = platform + '-' + arch;
  const entry = manifest.packages.find(pkg => pkg.target === target);
  if (!entry) return null;
  return { ...entry, version: manifest.version, executable: platform === 'win32' ? 'armonel.exe' : 'armonel' };
}

function bundledExecutable(app, resourceRoot, platform = process.platform, arch = process.arch) {
  const release = selectRelease(platform, arch);
  if (!app || !release) return null;
  const root = app.isPackaged ? resourceRoot : app.getAppPath?.();
  if (!root) return null;
  const file = path.resolve(root, ...(app.isPackaged ? ['armonel'] : ['.runtime', 'armonel', release.target]),
    release.executable);
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}

module.exports = { selectRelease, noticeNames, bundledExecutable };
