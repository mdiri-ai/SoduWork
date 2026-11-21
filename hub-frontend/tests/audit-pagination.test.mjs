import test from 'node:test'
import assert from 'node:assert/strict'
import { validAuditPage } from '../src/screens/audit-pagination.js'

test('audit pagination returns to the last page when records shrink', () => {
  assert.equal(validAuditPage(4, 41, 20), 3)
  assert.equal(validAuditPage(3, 0, 20), 1)
  assert.equal(validAuditPage(2, 40, 20), 2)
})
