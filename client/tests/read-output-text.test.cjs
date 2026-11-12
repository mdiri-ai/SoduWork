'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readOutputText, CAP, PREVIEW_BYTES } = require('../main/pi-session/read-output-text.cjs');

test('large previews use bounded asynchronous reads and never split Unicode characters', async () => {
  const prefix = Buffer.from('a'.repeat(19999) + '😀中文'.repeat(20000));
  let totalRead = 0, closed = false;
  const result = await readOutputText('synthetic-large', async () => ({
    stat: async () => ({ size: 8 * 1024 * 1024, isFile: () => true }),
    read: async (buffer, offset, length, position) => {
      // Short reads are legal and must still produce the complete prefix.
      const count = Math.min(length, 997, prefix.length - position);
      prefix.copy(buffer, offset, position, position + count); totalRead += count;
      return { bytesRead: count };
    }, close: async () => { closed = true; },
  }));
  assert.equal(result.tooBig, true); assert.equal(result.size, 8 * 1024 * 1024);
  assert.equal(result.text, 'a'.repeat(19999));
  assert.equal(totalRead, PREVIEW_BYTES); assert.equal(closed, true);
});

test('real small UTF-8 files are returned intact, including at the two MiB threshold', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const text of ['你好 😀\n', 'a'.repeat(CAP - 4) + '😀']) {
    const target = path.join(root, 'output.txt'); fs.writeFileSync(target, text);
    const result = await readOutputText(target);
    assert.equal(result.text, text); assert.equal(result.size, Buffer.byteLength(text));
    assert.equal(result.tooBig, undefined);
  }
  await assert.rejects(readOutputText(root));
});

test('a changing file never expands the allocation and handles are closed on errors', async () => {
  let closed = 0;
  await assert.rejects(readOutputText('synthetic', async () => ({
    stat: async () => ({ size: 12, isFile: () => true }),
    read: async buffer => { assert.equal(buffer.length, 12); throw Error('read failed'); },
    close: async () => { closed++; },
  })), /read failed/);
  assert.equal(closed, 1);
});

test('opening non-regular files is nonblocking before fstat rejects them', async () => {
  let closed = false;
  await assert.rejects(readOutputText('synthetic-fifo', async (_target, flags) => {
    assert.equal(flags, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    return { stat: async () => ({ isFile: () => false }),
      read: async () => assert.fail('never read a pipe'), close: async () => { closed = true; } };
  }), /Only regular files/);
  assert.equal(closed, true);
});
