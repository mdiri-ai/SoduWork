import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'
const require = createRequire(import.meta.url)
const parser = require('@babel/parser')
const traverse = require('@babel/traverse').default
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const han = /[\u3400-\u9fff]/
const ui = [], unmarked = []
const isCall = (p, name) => p?.isCallExpression() && p.node.callee.name === name
// A destructured binding such as `for (const [key, label] of [...])` or
// `[...].map(([key, label]) => …)` hands cataloged copy to `tx(label)`. These two
// branches recognize the binding from both the literal side and the call side so
// such copy is reviewed as a message instead of being flagged as unmarked. The
// literal still has to appear in the catalog, so nothing bypasses translation.
const LOOP_BINDINGS = ['ForOfStatement', 'ForInStatement']
function isTranslatedLiteral(p) {
  // A literal sitting in the destructured array reaches tx through the element
  // binding, so review it as a message when that element is passed on.
  if (p.parentPath?.isArrayExpression() && isDestructuredIntoTranslation(p)) return true
  // Only value branches reach tx. Conditions and nested data-building calls
  // remain subject to their normal literal review rules.
  while (p.parentPath?.isConditionalExpression() && ['consequent', 'alternate'].includes(p.key)) p = p.parentPath
  if (!isCall(p.parentPath, 'tx') || p.key !== 0) return false
  const argument = p.parentPath.get('arguments')[0]
  if (!argument?.isIdentifier()) return true
  // `tx(message)` where `message` is destructured from the consumed array.
  const binding = p.parentPath.scope.getBinding(argument.node.name)
  if (!binding) return false
  const consumer = owningConsumer(binding.path)
  return Boolean(consumer && destructuredDeclarator(consumer))
}
// Walk up from the binding to the node that owns the destructuring source, so
// both the `for`-of declaration and the `.map()` callback parameter resolve.
function owningConsumer(bindingPath) {
  let current = bindingPath
  while (current) {
    if (LOOP_BINDINGS.includes(current.node.type)) return current
    if (current.isMemberExpression()) return current
    current = current.parentPath
  }
  return null
}
// Every element of a destructured loop row must itself reach tx for the copy to
// count as translated; a partially consumed row keeps its literals under review.
// Rows may be nested one level deeper than the iterated array, so unwrap it first.
function isDestructuredIntoTranslation(p) {
  let row = p.parentPath
  if (row?.parentPath?.isArrayExpression()) row = row.parentPath
  if (!row?.isArrayExpression()) return false
  const consumer = row.parentPath
  if (!consumer) return false
  const declarator = destructuredDeclarator(consumer)
  if (!declarator) return false
  if (declarator.sourceNode !== row.node) return false
  const index = Number(p.key)
  const elementPattern = declarator.id.get('elements')[index]
  if (!elementPattern?.isIdentifier()) return false
  const binding = elementPattern.scope.getBinding(elementPattern.node.name)
  if (!binding) return false
  return binding.referencePaths.every(reference => isCall(reference.parentPath, 'tx') && reference.key === 0)
}
// Resolves the array a destructuring reads from, covering both
// `for (const [a, b] of [...])` and `[...].map(([a, b]) => …)`. The consumed row
// is reported alongside the pattern so callers can confirm the pairing.
function destructuredDeclarator(consumer) {
  if (consumer.isMemberExpression()) {
    // `row.map(([a, b]) => …)`: the callee object is the consumed array and the
    // callback parameter carries the destructuring pattern.
    const call = consumer.parentPath
    const callback = call?.isCallExpression() ? call.get('arguments')[0] : null
    const parameter = callback?.get('params')[0]
    if (parameter?.isArrayPattern()) return { id: parameter, sourceNode: consumer.get('object').node }
    return null
  }
  if (LOOP_BINDINGS.includes(consumer.node.type)) {
    const left = consumer.get('left')
    const declarator = left?.isVariableDeclaration() ? left.get('declarations')[0] : null
    return declarator?.get('id')?.isArrayPattern()
      ? { id: declarator.get('id'), sourceNode: consumer.get('right').node } : null
  }
  return null
}
const files = [path.join(root, 'src'), path.join(root, 'src/screens')].flatMap(dir =>
  fs.readdirSync(dir).filter(name => /\.(jsx|js)$/.test(name) && name !== 'i18n.js').map(name => path.join(dir, name)))
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] })
  const record = (array, node, value, kind) => { array.push({ file: path.relative(root, file).replaceAll('\\', '/'), line: node.loc.start.line, kind, source: value }) }
  traverse(ast, {
    StringLiteral(p) {
      const value = p.node.value
      if (!han.test(value)) return
      if (isTranslatedLiteral(p)) return record(ui, p.node, value, 'message')
      if (isCall(p.parentPath, 'deferredMessageKey') && p.key === 0) return record(ui, p.node, value, 'deferred-message')
      if (p.parent.type === 'ObjectProperty' && p.key === 'key') return
      if (p.findParent(q => isCall(q, 'localeMap'))) return record(ui, p.node, value, 'constant-label')
      if (isCall(p.parentPath, 't')) return // Keyed shell dictionary.
      if (p.parent.type === 'BinaryExpression' && p.parent.operator !== '+') return
      if (p.parent.type === 'CallExpression' && ['includes', 'indexOf', 'startsWith', 'endsWith', 'replace', 'replaceAll', 'split', 'match', 'test'].includes(p.parent.callee.property?.name)) return
      const name = p.findParent(q => q.isVariableDeclarator())?.node.id.name
      const property = p.findParent(q => q.isObjectProperty())?.node.key.name
      if (['STARTER', 'defaults', 'blank'].includes(name)) return
      // The clause-number formatter keeps Chinese numeral tables in `digits`/`units`.
      // They are algorithm data rather than display copy, so they stay untranslated.
      if (file.endsWith('legal-docx-layout.js') && ['digits', 'units'].includes(name)) return
      if (['title', 'name'].includes(property) && ['新的一步', '新分类'].includes(value)) return
      record(unmarked, p.node, value, 'literal-review')
    },
    JSXText(p) { if (han.test(p.node.value)) record(unmarked, p.node, p.node.value.trim(), 'jsx-text') },
    TemplateLiteral(p) {
      if (!p.node.quasis.some(q => han.test(q.value.cooked))) return
      record(unmarked, p.node, p.node.quasis.map(q => q.value.cooked).join('{…}'), 'template-review')
    },
  })
}
const missing = ui.flatMap(row => {
  const key = row.source.trim()
  if (row.kind !== 'deferred-message') return key in messages ? [] : [row]
  // Deferred validation keys cross a presentation boundary, so require an explicit
  // entry in every translated locale rather than accepting the English fallback.
  return [['en-US', messages], ['ja-JP', messagesByLocale['ja-JP']], ['ko-KR', messagesByLocale['ko-KR']]]
    .filter(([, catalog]) => !catalog || !(key in catalog))
    .map(([locale]) => ({ ...row, locale }))
})
const unique = new Set(ui.map(row => row.source.trim()))
const report = { scannedFiles: files.length, uiOccurrences: ui.length, uniqueMessages: unique.size,
  missingMessages: [...new Set(missing.map(row => row.source.trim()))], missingOccurrences: missing, unmarked }
const output = process.argv[2]
if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, missingOccurrences: undefined, unmarked: unmarked.length }, null, 2))
if (missing.length || unmarked.length) process.exitCode = 1
