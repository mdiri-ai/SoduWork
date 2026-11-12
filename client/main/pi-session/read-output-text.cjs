'use strict';

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const CAP = 2 * 1024 * 1024;
const PREVIEW_CHARS = 20000;
// UTF-8 uses at most four bytes per character. Reading this fixed prefix is
// sufficient for the preview, regardless of the file's total size.
const PREVIEW_BYTES = PREVIEW_CHARS * 4;

async function readOutputText(target, open = fs.promises.open) {
  // fstat rejects non-files, but opening a FIFO must not first wait for a
  // writer and occupy a filesystem worker indefinitely on POSIX systems.
  const file = await open(target, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error('Only regular files can be previewed');
    const tooBig = stat.size > CAP, limit = tooBig ? PREVIEW_BYTES : Math.min(stat.size, CAP);
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await file.read(buffer, offset, limit - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    // Do not manufacture a replacement character for a multibyte sequence
    // cut by the byte limit. Small files preserve their normal UTF-8 decoding.
    const decoder = new StringDecoder('utf8');
    let text = decoder.write(buffer.subarray(0, offset));
    if (!tooBig || offset < limit) text += decoder.end();
    if (tooBig) {
      text = text.slice(0, PREVIEW_CHARS);
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    }
    return { ok: true, ...(tooBig ? { tooBig: true } : {}), size: stat.size, text };
  } finally { await file.close(); }
}

module.exports = { readOutputText, CAP, PREVIEW_BYTES };
