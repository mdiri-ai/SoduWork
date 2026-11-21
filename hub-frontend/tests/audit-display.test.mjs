import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'
import { detailText } from '../src/screens/audit-detail.js'

async function mount(t, items) {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/Audit.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api: { audit: async () => ({ items, total: items.length }) } },
      '../ui.jsx': { Loading: 'Loading', ErrorState: 'ErrorState', Icon: 'Icon' },
      '../FilterControls.jsx': { FilterSelect: 'FilterSelect' },
      '../ListPager.jsx': 'ListPager',
      './admin-access-pages.css': {},
      './audit-detail.js': { detailText },
    },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  page.render()
  await page.flush()
  return page
}

const actions = page => page.nodes(n => n.props.className === 'admin-audit-action')
const label = node => node.props.children[1]

test('audit rows preserve seconds so records in the same minute remain distinguishable', async t => {
  const at = new Date(2026, 10, 21, 11, 42, 24, 463).getTime()
  const page = await mount(t, [
    { id: 'first', at, action: 'org.delete' },
    { id: 'second', at: at + 3000, action: 'org.delete' },
  ])
  assert.deepEqual(page.nodes(n => n.props.className === 'admin-audit-time').map(n => n.props.children), [
    '2026/11/21 11:42:24', '2026/11/21 11:42:27',
  ])
})

test('organization create, update and delete actions use existing department labels', async t => {
  const page = await mount(t, ['org.create', 'org.update', 'org.delete'].map((action, id) => ({ id, action })))
  assert.deepEqual(actions(page).map(label), ['新建部门', '编辑部门', '删除部门'])
  assert.deepEqual(actions(page).map(n => n.props.title), ['org.create', 'org.update', 'org.delete'])
})

test('unknown actions have an explicit label and retain the exact original code', async t => {
  const page = await mount(t, [
    { id: 'custom', action: 'custom.action.with.dots' },
    { id: 'inherited', action: 'constructor' },
    { id: 'missing' },
  ])
  assert.deepEqual(actions(page).map(label), [
    '未知操作 (custom.action.with.dots)', '未知操作 (constructor)', '未知操作',
  ])
  assert.equal(actions(page)[0].props.title, 'custom.action.with.dots')
})

test('changing locale translates action labels without altering recorded action codes', async t => {
  const page = await mount(t, [{ id: 'known', action: 'org.delete' }, { id: 'unknown', action: 'custom.action' }])
  setLocale('en-US')
  page.render({})
  assert.deepEqual(actions(page).map(label), ['Delete department', 'Unknown action (custom.action)'])
  assert.deepEqual(actions(page).map(n => n.props.title), ['org.delete', 'custom.action'])
  setLocale('zh-CN')
  page.render({})
  assert.deepEqual(actions(page).map(label), ['删除部门', '未知操作 (custom.action)'])
})
