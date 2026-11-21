import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function setup(t) {
  const requests = []
  const page = await createComponentHarness(new URL('../src/screens/ClientReleases.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { can: () => false, api: {
        clientReleases: async () => ({ releases: [] }),
        clientReleaseNotes: async () => ({ notes: [] }),
        clientUpdateAttempts: filters => {
          const request = { ...deferred(), filters }
          requests.push(request)
          return request.promise
        },
      } },
      '../ui.jsx': { Icon: 'Icon', Loading: 'Loading' },
      './client-releases.css': {},
    },
  })
  t.after(() => page.unmount())
  const panel = () => page.nodes(node => node.type.name === 'AttemptsPanel')[0].props
  page.render()
  await page.flush()
  return { page, requests, panel }
}

test('a delayed previous state filter cannot replace the latest rows or counts', async t => {
  const { page, requests, panel } = await setup(t)
  page.act(() => panel().onStateFilter('failed'))
  assert.deepEqual(requests.map(row => row.filters.state), ['all', 'failed'])
  requests[1].resolve({ attempts: [{ id: 'current-failure' }], counts: { failed: 1 } })
  await page.flush()
  requests[0].resolve({ attempts: [{ id: 'stale-installed' }], counts: { installed: 99 } })
  await page.flush()
  assert.equal(panel().stateFilter, 'failed')
  assert.deepEqual(panel().attempts, [{ id: 'current-failure' }])
  assert.deepEqual(panel().counts, { failed: 1 })
  assert.equal(panel().loading, false)
})

test('a stale failure cannot clear a newly selected release or finish its loading state', async t => {
  const { page, requests, panel } = await setup(t)
  page.act(() => panel().onReleaseFilter('new-release'))
  requests[0].reject(new Error('old request failed'))
  await page.flush()
  assert.equal(panel().loading, true)
  requests[1].resolve({ attempts: [{ id: 'new-release-attempt' }], counts: { downloading: 1 } })
  await page.flush()
  assert.equal(panel().releaseFilter, 'new-release')
  assert.deepEqual(panel().counts, { downloading: 1 })
  page.act(() => panel().onRefresh())
  requests[2].resolve({ attempts: [{ id: 'refreshed' }], counts: { installed: 1 } })
  await page.flush()
  assert.deepEqual(panel().attempts, [{ id: 'refreshed' }])
})

test('overlapping refreshes keep the newest result when an older refresh fails', async t => {
  const { page, requests, panel } = await setup(t)
  page.act(() => panel().onRefresh())
  requests[1].resolve({ attempts: [{ id: 'latest' }], counts: { installed: 2 } })
  await page.flush()
  requests[0].reject(new Error('late failure'))
  await page.flush()
  assert.deepEqual(panel().attempts, [{ id: 'latest' }])
  assert.deepEqual(panel().counts, { installed: 2 })
  assert.equal(panel().loading, false)
})

test('the current request still clears activity and ends loading after a failure', async t => {
  const { page, requests, panel } = await setup(t)
  requests[0].resolve({ attempts: [{ id: 'initial' }], counts: { installed: 1 } })
  await page.flush()
  page.act(() => panel().onRefresh())
  requests[1].reject(new Error('current failure'))
  await page.flush()
  assert.deepEqual(panel().attempts, [])
  assert.deepEqual(panel().counts, {})
  assert.equal(panel().loading, false)
})
