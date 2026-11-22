import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// #829: the "recent failures" section printed the raw backend error string and
// a bare task id with no next step. The screen now routes failure rows through
// the operations copy catalog and offers a locate action that deep-links the
// projects screen to the failing task's detail view. These locks assert the
// wiring textually so they stay independent of the render environment.

const screen = fs.readFileSync(new URL('../src/screens/OperationsCenter.jsx', import.meta.url), 'utf8')
const projects = fs.readFileSync(new URL('../src/screens/Projects.jsx', import.meta.url), 'utf8')

test('failure rows render through the operations copy catalog, not raw errors (#829)', () => {
  assert.ok(screen.includes('{operationsText(row.error)'), 'failure text must pass through operationsText')
  assert.ok(!screen.includes('{row.error ||'), 'the raw error shortcut must be gone')
})

test('failure rows with a task carry a locate action deep-linking projects (#829)', () => {
  assert.ok(screen.includes("navTo('projects', { detail: row.taskId })"), 'locate action must deep-link projects with the task id')
  assert.ok(screen.includes('row.taskId && <button'), 'only rows with a task id get the button')
})

test('projects screen consumes the deep-linked detail intent (#829)', () => {
  assert.ok(projects.includes("takeNav('projects')"), 'projects screen must consume the navigation intent')
  assert.ok(projects.includes("(takeNav('projects') || {}).detail"), 'the detail id becomes the initially opened project')
})
