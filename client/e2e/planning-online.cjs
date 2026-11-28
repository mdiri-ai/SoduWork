'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');

async function main() {
  const [instance, output] = process.argv.slice(2);
  if (!instance || !output || process.argv.length !== 4) {
    throw Error('Usage: node client/e2e/planning-online.cjs <prepared SoduWork source instance> <new evidence directory>');
  }
  if (!process.env.SODUWORK_PLANNING_INDEX_URL) throw Error('Set SODUWORK_PLANNING_INDEX_URL to the company HTTPS simple index.');
  if (new URL(process.env.SODUWORK_PLANNING_INDEX_URL).protocol !== 'https:') throw Error('The package index must use HTTPS.');
  const state = fs.realpathSync(instance);
  const client = path.join(state, 'application', 'client');
  const windows = process.platform === 'win32';
  const electron = require(path.join(client, 'node_modules', 'electron'));
  const python = path.join(state, 'venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
  if (!fs.existsSync(electron) || !fs.existsSync(python)) throw Error('Prepare the source instance with start.sh or start.cmd --prepare-only --desktop first.');
  const evidence = path.resolve(output);
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.mkdirSync(evidence); // This run exclusively owns its new directory.
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'soduwork-planning-e2e-'));
  const env = { ...process.env, PLANNING_QA_STATE: state, PLANNING_QA_OUTPUT: evidence, PLANNING_QA_SCRATCH: scratch };
  for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key)) delete env[key];
  try {
    const driver = path.join(__dirname, 'fixtures', 'planning-online-driver.cjs');
    const child = spawn(electron, [driver], { env, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw Error('Planning online lifecycle failed. See ' + path.join(evidence, 'progress.log'));
    console.log('Planning online lifecycle evidence: ' + evidence);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
