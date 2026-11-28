'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createEntriesSync } = require('../../main/conversation/zip-archive');

function workbook() {
  const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationships = (type, target) =>
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + rel + '/' + type + '" Target="' + target + '"/></Relationships>';
  const types = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="' + types + 'sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="' + types + 'worksheet+xml"/></Types>',
    '_rels/.rels': relationships('officeDocument', 'xl/workbook.xml'),
    'xl/workbook.xml': '<workbook xmlns="' + sheet + '" xmlns:r="' + rel + '"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships('worksheet', 'worksheets/sheet1.xml'),
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="' + sheet + '"><sheetData><row r="1"><c r="A1"><v>240</v></c></row></sheetData></worksheet>',
  };
  return createEntriesSync(Object.entries(parts).map(([name, xml]) => ({ name, bytes: Buffer.from(xml) })));
}

module.exports = function legacyDeliverables(root, fileRoot, owner, creator) {
  const bytes = workbook();
  const site = 'logo.htm', excel = 'budget.xlsx', heading = 'Updated logo';
  function record(cwd, ref, prompt, exchanges, answer, filename, nativeCwd = cwd) {
    const id = randomUUID(), since = Date.now() - 60000;
    const stat = fs.statSync(path.join(cwd, filename));
    const ended = Math.ceil(Math.max(stat.ctimeMs, stat.mtimeMs, Date.now()));
    const rows = [{ type: 'session', version: 3, id, cwd: nativeCwd, timestamp: new Date(since).toISOString() }];
    function message(value, when) {
      rows.push({ type: 'message', timestamp: new Date(when).toISOString(), message: { ...value, timestamp: when } });
    }
    message({ role: 'user', content: prompt }, since);
    for (const [index, [name, parameters]] of exchanges.entries()) {
      const toolCallId = 'call-' + index;
      message({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: toolCallId, name, arguments: parameters }] }, since + 1 + index * 2);
      message({ role: 'toolResult', toolCallId, toolName: name, content: [], isError: false }, since + 2 + index * 2);
    }
    message({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answer }] }, ended);
    const file = path.join(fileRoot, id + '.jsonl');
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
    return { id, cwd, ref, path: file, adapterId: 'pi', count: rows.length - 1, workOwner: owner, creator };
  }
  const project = path.join(root, 'logo-project'), scratch = path.join(root, 'temp', 'chat-abcdef-5555');
  fs.mkdirSync(project);
  fs.mkdirSync(scratch, { recursive: true });
  const before = '<!doctype html><meta charset="utf-8"><h1>Original logo</h1>', target = path.join(project, site);
  fs.writeFileSync(target, before.replace('Original logo', heading));
  const siteRow = record(project, 'reopened-project', '制作预览页', [
    ['write', { path: target, content: before }],
    ['edit', { path: target, edits: [{ oldText: 'Original logo', newText: heading }] }],
  ], '已修正预览页 `' + site + '`。', site);
  fs.writeFileSync(path.join(scratch, excel), bytes);
  const sheetRow = record(scratch, path.basename(scratch), '生成表格', [['bash', { command: 'python generate.py' }]],
    '已生成 `' + excel + '`。', excel, scratch + path.sep);
  return { siteRow, sheetRow, site, excel, bytes, heading };
};
module.exports.workbook = workbook;
