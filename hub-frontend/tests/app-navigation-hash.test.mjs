import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as healthVersion from '../src/health-version.js'
import { setLocale } from '../src/i18n.js'

// #807: every admin page needs a stable hash URL, browser back/forward
// support, and its own readable tab title instead of a constant "SoduWork".

async function mount(t, { permissions = ['identity.manage', 'user.manage', 'role.manage', 'task.view', 'org.manage'], hash = '', isSuper = false } = {}) {
  setLocale('zh-CN')
  const values = new Map([['soduwork-hub-screen', 'overview']])
  const pushes = []
  const descriptors = new Map(['window', 'document', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState() {}, pushState(_s, _t, url) { pushes.push(url) } },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setInterval() { return 1 }, clearInterval() {}, scrollTo() {},
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    hidden: false, documentElement: {}, title: '', addEventListener() {}, removeEventListener() {},
  } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value),
  } })
  const user = { username: 'admin-fixture', displayName: 'Fixture Admin', isSuper }
  const page = await createComponentHarness(new URL('../src/App.jsx', import.meta.url), { dependencies: {
    './api.js': { api: { me: async () => user, health: async () => ({ ok: true }) }, getToken: () => 'fixture',
      getUser: () => user, setUser() {}, setToken() {}, can: permission => permissions.includes(permission) },
    './Login.jsx': 'Login', './LocaleSettings.jsx': 'LocaleSettings', './Landing.jsx': 'Landing',
    './ui.jsx': { Icon: 'Icon', Loading: 'Loading', ThemeToggle: 'ThemeToggle', ToastHost: 'ToastHost' },
    './health-version.js': healthVersion,
  } })
  page.render(); await page.flush()
  t.after(() => {
    page.unmount()
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  })
  const buttons = () => page.nodes(node => node.type === 'button' && String(node.props.className).startsWith('nav-item'))
  const screen = () => page.nodes(node => node.props.className === 'app')[0].props['data-screen']
  const nav = (label) => buttons().find(node => node.props.children[1].props.children === label)
  return { page, screen, nav, pushes, events, doc: globalThis.document }
}

test('a #users deep link restores the users screen directly (#807)', async t => {
  const { screen } = await mount(t, { hash: '#users' })
  assert.equal(screen(), 'users')
})

test('navigating updates the tab title and pushes a stable hash (#807)', async t => {
  const { page, screen, nav, pushes, doc } = await mount(t)
  const users = nav('用户管理')
  assert.ok(users, 'users entry needs a reachable navigation item')
  page.act(() => users.props.onClick())
  assert.equal(screen(), 'users')
  assert.equal(doc.title, '用户管理 · SoduWork 管理端')
  assert.ok(pushes.includes('#users'), 'navigate must sync the URL hash')
})

test('browser back restores the previous screen via popstate (#807)', async t => {
  const { page, screen, nav, pushes, events } = await mount(t)
  const users = nav('用户管理')
  page.act(() => users.props.onClick())
  assert.equal(screen(), 'users')
  const afterForward = pushes.length
  page.act(() => {
    window.location.hash = '#overview'
    events.dispatchEvent(new Event('popstate'))
  })
  assert.equal(screen(), 'overview')
  assert.equal(pushes.length, afterForward, 'back navigation must not push a new entry')
})
