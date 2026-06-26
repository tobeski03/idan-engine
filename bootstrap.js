const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoUrl = process.argv[2];
const token = process.argv[3];
const targetDir = process.argv[4] || __dirname;
const stateFile = path.join(targetDir, 'engine-state.json');

if (!repoUrl || !token) {
  console.error('Usage: node bootstrap.js <repo-url> <pairing-token> [target-dir]');
  process.exit(1);
}

const state = { token: String(token).trim() };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const hasLock = fs.existsSync(path.join(targetDir, 'package-lock.json'));
const install = hasLock ? ['ci'] : ['install'];
const npmResult = spawnSync('npm', install, {
  cwd: targetDir,
  stdio: 'inherit',
  shell: true,
});

if (npmResult.status !== 0) {
  process.exit(npmResult.status || 1);
}

console.log('Engine paired and ready.');
