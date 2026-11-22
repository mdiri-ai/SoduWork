import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'
import { operationsText } from '../src/screens/operations-copy.js'

// #829: the "recent failures" section used to print the raw backend error
// string and a bare task id with no next step. Failures now go through the
// operations copy catalog and every row carries a "locate the task" action
// that deep-links the projects screen to the failing task's detail view.

async function mountOperations(t) {
  setLocale('zh-CN')
  const descriptors = new Map(['window', 'document', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const events = new EventTarget()
  const navigations = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {}, pushState() {} },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: (event) => { events.dispatchEvent(event); if (event.type === 'soduwork-hub-nav') navigations.push(event.detail) },
    setInterval() { return 1 }, clearInterval() {}, scrollTo() {},
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    hidden: false, documentElement: {}, title: '', addEventListener() {}, removeEventListener() {},
  } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: () => null, setItem() {},
  } })
  const snapshot = {
    hub: { modeLabel: '单实例控制面', nodeId: 'hub-1', service: 'hub', version: '1', ready: true, clusterNote: '' },
    requests: { requests: 5, errors: 0, windowMinutes: 30 },
    runners: { total: 1, online: 1, accepting: 1, busy: 0, items: [] },
    work: { workflow: { failed: 1 }, executions: {}, deployments: {}, pendingApprovals: 0 },
    recentFailures: [
      { id: 'f1', taskId: 'task-9f2', error: '数据库不可用：ConnectionError', updatedAt: '' },
      { id: 'f2', taskId: '', error: '', updatedAt: '' },
    ],
    blockers: [],
  }
  const page = await createComponentHarness(new URL('../src/screens/OperationsCenter.jsx', import.meta.url), { dependencies: {
    '../ui.jsx': { Icon: 'Icon', AUTO: 800, navTo: (screen, params) => navigations.push({ screen, ...params }), useAsync: () => ({ data: snapshot, loading: false, error: null, reload: async () => {} }) },
    './operations-center.css': {},
    '../api.js': { api: { operationsOverview: async () => snapshot } },
    './operations-copy.js': { operationsText },
} })
  page.render(); await page.flush()
  t.after(() => {
    page.unmount()
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  })
  const failures = () => page.nodes(node => node.type === 'article' && node.props.className !== undefined).length
  const buttons = () => page.nodes(node => node.type === 'button')
  return { page, buttons, navigations }
}

test('failure rows translate the backend error through the copy catalog (#829)', async t => {
  const { page } = await mountOperations(t)
  const texts = page.nodes(node => node.type === 'b').map(node => String(node.props.children))
  assert.ok(texts.some(child => child.includes('数据库不可用：ConnectionError')),
    'backend error must pass through operationsText')
})

test('failure rows with a task carry a locate action that deep-links projects (#829)', async t => {
  const { page, buttons, navigations } = await mountOperations(t)
  const locate = buttons().find(node => node.props.children === '定位需求')
  assert.ok(locate, 'a failure row with a taskId must offer a locate action')
  page.act(() => locate.props.onClick())
  assert.equal(navigations.length, 1)
  assert.equal(navigations[0].screen, 'projects')
  assert.equal(navigations[0].detail, 'task-9f2')
  assert.ok(!buttons().some(node => node.props.children === '定位需求' && node.props.onClick === undefined))
})

test('failure rows without a task keep no locate action (#829)', async t => {
  const { buttons } = await mountOperations(t)
  const locates = buttons().filter(node => node.props.children === '定位需求')
  assert.equal(locates.length, 1, 'only the row with a taskId gets a locate button')
})

test('projects screen consumes the deep-linked detail intent (#829)', async t => {
  const fs = await import('node:fs')
  const source = fs.readFileSync(new URL('../src/screens/Projects.jsx', import.meta.url), 'utf8')
  assert.ok(source.includes("takeNav('projects')"), 'projects screen must consume the navigation intent')
  assert.ok(source.includes("(takeNav('projects') || {}).detail"), 'the detail id becomes the initially opened project')
})
