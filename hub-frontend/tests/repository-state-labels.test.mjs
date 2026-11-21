import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const source = new URL('../src/screens/Repositories.jsx', import.meta.url)
const accountButton = (page) => page.nodes((node) => node.type === 'button' && node.props.className?.startsWith('rc-acct'))[0]
const syncButton = (page) => page.nodes((node) => node.type === 'button' && node.props.className?.includes('btn-ghost'))[0]
const stateLabel = (page, label) => page.nodes((node) => node.type === 'b' && Array.isArray(node.props.children) && node.props.children.includes(label))
const rendered = (page) => JSON.stringify(page.render())

async function card(t, account = {}, props = {}) {
  setLocale('zh-CN')
  const page = await createComponentHarness(source, { exportName: 'SourceCard', privateExports: ['SourceCard'],
    props: { source: { id: 'source', type: 'gitlab', pullAccountUser: 'saved-user', pullAccountKind: 'password', pullAccountSet: true, ...account },
      onSaved: async () => {}, onSync() {}, ...props },
    dependencies: { '../api.js': { can: () => true, api: {} }, '../FilterControls.jsx': { FilterInput: 'input' },
      '../ui.jsx': { Icon: 'svg', Loading: 'loading', Modal: 'dialog', SelectMenu: 'select', toast: () => {} },
      './project-governance.css': {}, './repositories.css': {},
      './RepositoryIssueSync.jsx': { default: 'issue-dialog', RepositoryIssueSyncStatus: 'issue-status' } },
  })
  t.after(() => page.unmount())
  page.render()
  return page
}

test('a source without a pull account states the missing account instead of the legacy pending state', async (t) => {
  const page = await card(t, { pullAccountSet: false })
  assert.equal(stateLabel(page, '未配置账号').length, 1)
  assert.doesNotMatch(rendered(page), /已配置未同步|同步成功|同步失败/)
  assert.match(accountButton(page).props.className, /primary/)
  assert.doesNotMatch(syncButton(page).props.className, /primary/)
})

test('an account set but never synced card recommends syncing as its single next step', async (t) => {
  const page = await card(t)
  assert.equal(stateLabel(page, '已配置未同步').length, 1)
  assert.doesNotMatch(rendered(page), /未配置账号|同步成功|同步失败/)
  assert.match(syncButton(page).props.className, /primary/)
  assert.doesNotMatch(accountButton(page).props.className, /primary/)
})

test('a failed scan keeps the sync recommendation and a synced card drops it', async (t) => {
  const failed = await card(t, { repositorySyncAt: 1700000000000, repositorySyncOk: false })
  assert.equal(stateLabel(failed, '同步失败').length, 1)
  assert.match(syncButton(failed).props.className, /primary/)
  const healthy = await card(t, { repositorySyncAt: 1700000000000, repositorySyncOk: true, repositorySyncCount: 2 })
  assert.equal(stateLabel(healthy, '同步成功').length, 1)
  assert.doesNotMatch(syncButton(healthy).props.className, /primary/)
  assert.doesNotMatch(accountButton(healthy).props.className, /primary/)
})

test('a synced-but-empty card names the empty result instead of a bare count', async (t) => {
  const page = await card(t, { repositorySyncAt: 1700000000000, repositorySyncOk: true, repositorySyncCount: 0 })
  assert.equal(stateLabel(page, '同步成功但 0 仓库').length, 1)
  assert.doesNotMatch(rendered(page), /已配置未同步|同步失败/)
  assert.doesNotMatch(syncButton(page).props.className, /primary/)
})

test('a syncing card shows the in-flight state without a competing recommendation', async (t) => {
  const page = await card(t, {}, { syncing: 'source' })
  assert.equal(stateLabel(page, '同步中').length, 1)
  assert.match(syncButton(page).props.children[1], /同步中…/)
  assert.doesNotMatch(syncButton(page).props.className, /primary/)
})

test('an empty catalog explains its value and the account-first dependency', async (t) => {
  setLocale('zh-CN')
  const page = await createComponentHarness(source, {
    dependencies: { '../api.js': { can: () => true, api: {
      integrations: async () => [{ id: 'src1', type: 'gitlab', enabled: true, pullAccountSet: false }],
      repositoryCatalog: async () => ({ items: [] }),
    } }, '../FilterControls.jsx': { FilterInput: 'input' },
      '../ui.jsx': { Icon: 'svg', Loading: 'loading', Modal: 'dialog', SelectMenu: 'select', toast: () => {} },
      './project-governance.css': {}, './repositories.css': {},
      './RepositoryIssueSync.jsx': { default: 'issue-dialog', RepositoryIssueSyncStatus: 'issue-status' } },
  })
  t.after(() => page.unmount())
  page.render()
  await page.flush()
  const html = rendered(page)
  assert.match(html, /目录里还没有仓库/)
  assert.match(html, /这里是任务挂载可用的仓库清单：先配好拉取账号，再点「立即同步」，仓库会出现在这里。/)
})
