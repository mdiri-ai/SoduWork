import './helpers/chinese-locale.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'

const Runtime = () => null
const provider = (id, enabled = true) => ({ id, name: id, builtin: false, enabled, revision: 'fixture' })
const ready = id => ({ ...provider(id), baseUrl: 'https://service.example/v1', keySet: true })
const model = (providerId, modality, enabled = true) => ({ id: providerId + '-' + modality,
  name: 'fixture', providerId, modality, enabled })
const chatModel = providerId => model(providerId, 'chat')

async function mount(t, catalog, { toast, ...options } = {}) {
  const page = await createComponentHarness(new URL('../src/screens/ModelCatalog.jsx', import.meta.url), {
    ...options,
    dependencies: {
      '../api.js': { api: { modelCatalog: async () => structuredClone(catalog),
        saveModelProvider: async () => ({}), ...options.api } },
      '../ui.jsx': { takeNav: () => null, Modal: () => null, SelectMenu: () => null, Confirm: () => null,
        Icon: () => null, Loading: () => null, ErrorState: () => null, toast: toast || (() => {}) },
      './ModelProviderDeletion.jsx': { __esModule: true, default: () => null },
      './LlmSettings.jsx': { __esModule: true, default: () => null }, './ModelRuntime.jsx': { __esModule: true, default: Runtime },
      './model-catalog-actions.css': {}, './model-capabilities.css': {},
      './ModelCapabilities.jsx': { CAPABILITY_LABELS: {}, CAPABILITY_STATES: {}, CapabilityBadges() {}, ModelCapabilityStatus() {} },
    },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  return page
}
const notes = page => page.nodes(node => node.type === 'p' && node.props.className === 'model-provider-note')

test('a configured provider without a usable chat model gets an inline empty state and an add-model shortcut', async t => {
  const catalog = { providers: [ready('empty-service'), ready('no-chat-service'), ready('ready-service')],
    models: [model('no-chat-service', 'image'), chatModel('ready-service')] }
  const page = await mount(t, catalog)
  // Provider cards carry no note field, so every model-provider-note here is an empty state.
  const texts = notes(page).map(note => Array.isArray(note.props.children) ? note.props.children[0] : note.props.children)
  assert.deepEqual(texts, ['还没有可选模型。连接成功不等于模型可选——',
    '已启用的模型里没有可对话的——点「查看」确认模型与额度，或加一个对话模型。'])
  const add = page.nodes(node => node.type === 'button' && node.props.className === 'model-cloud-toggle'
    && node.props.children === '加一个模型')
  assert.equal(add.length, 1)
  page.act(() => add[0].props.onClick())
  assert.equal(page.nodes(node => node.type?.name === 'ModelForm')[0].props.providerId, 'empty-service')
})

test('providers that are not fully configured stay without the empty-state note', async t => {
  const catalog = { providers: [{ ...provider('no-key'), baseUrl: 'https://service.example/v1', keySet: false },
    { ...provider('off'), enabled: false }, { ...provider('no-url'), baseUrl: '' }], models: [] }
  const page = await mount(t, catalog)
  assert.equal(notes(page).length, 0)
})

test('saving a new service points the toast at adding a model', async t => {
  const toasts = []
  const form = await mount(t, { providers: [], models: [] }, {
    toast: msg => toasts.push(msg),
    privateExports: ['ProviderForm'], exportName: 'ProviderForm',
    props: { onSaved: () => {} },
  })
  const change = (matches, value) => form.act(() => form.nodes(matches)[0].props.onChange({ target: { value } }))
  change(node => node.props.placeholder === '如 my-gateway', 'new-service')
  change(node => node.props.placeholder === '给人看的名字，如「研发网关」', 'New Service')
  const save = () => React.Children.toArray(form.render().props.foot.props.children)
    .find(button => button.props.children === '保存').props.onClick()
  form.act(() => save())
  await form.flush()
  assert.deepEqual(toasts, ['服务已保存。连接成功不等于模型可选——加一个模型后才能在会话中选用。'])
})

test('editing an existing service keeps the credential toast', async t => {
  const toasts = []
  const form = await mount(t, { providers: [], models: [] }, {
    toast: msg => toasts.push(msg),
    privateExports: ['ProviderForm'], exportName: 'ProviderForm',
    props: { initial: { id: 'svc', name: 'Svc', kind: 'openai-compat', baseUrl: 'https://service.example/v1', note: '', revision: 'r1', keySet: true, keyLen: 8 }, onSaved: () => {} },
  })
  const save = () => React.Children.toArray(form.render().props.foot.props.children)
    .find(button => button.props.children === '保存').props.onClick()
  form.act(() => save())
  await form.flush()
  assert.deepEqual(toasts, ['已保存（密钥未改动）'])
})

test('the summary note ties complete configuration to enabled chat models', async t => {
  const page = await mount(t, { providers: [], models: [] })
  const { catalogSummary } = page.nodes(node => node.type === Runtime)[0].props
  const note = page.nodes(node => node.type === 'p' && node.props.className === 'model-dimension-note', catalogSummary)
  assert.equal(note.length, 1)
  assert.match(renderToStaticMarkup(note[0]), /会话中可选用还需要服务下有已启用的对话模型。/)
})
