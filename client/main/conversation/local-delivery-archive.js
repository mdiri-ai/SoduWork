'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const hash = value => createHash('sha256').update(value).digest('hex');
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
async function publishArchive({ anchor, folder, target, bytes, guard }) {
  if (await exists(target)) return target;
  // Revision hashes omit titles, so each filename needs its own directory when
  // hard links are unavailable. Existing legacy archives keep their paths.
  const cachedFolder = path.join(path.dirname(folder), 'archive-' + hash(path.basename(folder) + '\0' + path.basename(target)));
  const cachedTarget = path.join(cachedFolder, path.basename(target));
  assertNoLinks(anchor, cachedTarget);
  if (await exists(cachedTarget)) return cachedTarget;
  const staging = path.join(path.dirname(folder), '.delivery-' + randomUUID());
  const temporary = path.join(staging, path.basename(target));
  assertNoLinks(anchor, temporary);
  await fs.mkdir(staging, { mode: 0o700 });
  let output;
  try {
    output = await fs.open(temporary, 'wx', 0o600);
    await fs.writeFile(output, bytes);
    await output.close();
    await guard();
    assertNoLinks(anchor, temporary); assertNoLinks(anchor, target);
    try { await fs.link(temporary, target); }
    catch (error) {
      if (error.code === 'EEXIST') return target;
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
      await guard();
      assertNoLinks(anchor, temporary); assertNoLinks(anchor, cachedTarget);
      // Publishing the complete directory cannot replace a nonempty directory
      // installed by another writer. Cleanup never owns either final ZIP.
      try { await fs.rename(staging, cachedFolder); }
      catch (error) { if (!await exists(cachedTarget)) throw error; }
      return await exists(target) ? target : cachedTarget;
    }
    return target;
  } catch (error) {
    if (output) await output.close().catch(() => {});
    throw error;
  } finally {
    if (output) await fs.unlink(temporary).catch(() => {});
    await fs.rmdir(staging).catch(() => {});
  }
}
async function create({ app, owner, result, guard }) {
  if (!result.manifest?.files?.length || result.contentType !== 'application/zip' || !/\.zip$/i.test(result.filename || '') ||
      !/^[a-f0-9]{64}$/.test(result.manifest?.revision || '') || !result.bytes) throw Error('当前成果不是压缩包');
  const anchor = app.getPath('userData');
  const folder = path.join(anchor, 'delivery-archives', hash(owner), result.manifest.revision);
  let target = path.join(folder, path.basename(result.filename));
  assertNoLinks(anchor, target); await fs.mkdir(folder, { recursive: true }); assertNoLinks(anchor, target);
  await guard();
  target = await publishArchive({ anchor, folder, target, bytes: result.bytes, guard });
  assertNoLinks(anchor, target);
  const stat = await fs.stat(target);
  const mismatch = () => Object.assign(Error('本地压缩包与交付版本不一致，请重新生成成果后再试'), {code:'DELIVERY_ARCHIVE_INVALID'});
  if (!stat.isFile() || stat.size !== result.bytes.length) throw mismatch();
  let offset = 0;
  for await (const chunk of createReadStream(target)) {
    if (!chunk.equals(result.bytes.subarray(offset, offset + chunk.length))) throw mismatch();
    offset += chunk.length;
  }
  if (offset !== result.bytes.length) throw mismatch();
  await guard(); assertNoLinks(anchor, target);
  return target;
}
module.exports = { create };
