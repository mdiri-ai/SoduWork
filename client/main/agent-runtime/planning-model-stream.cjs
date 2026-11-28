'use strict';

// Consume exactly one application event per host pull. Holding the generator at
// yield keeps subsequent provider bytes in the transport's bounded read queue.
const MAX_CHUNK = 120 * 1024;
async function* events(body, signal) {
  if (!body) throw Error('Planning 流式响应为空');
  const reader = body.getReader();
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelRead, { once: true });
  if (signal.aborted) cancelRead();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], dataSize = 0, total = 0, eof = false, finished = false;
  try {
    while (true) {
      const separator = /[\r\n]/.exec(buffer);
      if (!separator || !eof && separator[0] === '\r' && separator.index === buffer.length - 1) {
        if (eof && !buffer.length && !data.length) {
          if (!finished) throw Error('Planning 模型流中断，未收到结束标志');
          return;
        }
        if (!eof) {
          const part = await reader.read();
          if (part.done) { buffer += decoder.decode(); eof = true; }
          else {
            total += part.value.byteLength;
            if (total > 8 * 1024 * 1024) throw Error('Planning 模型响应过大');
            buffer += decoder.decode(part.value, { stream: true });
            if (buffer.length > MAX_CHUNK && !/[\r\n]/.test(buffer)) throw Error('Planning 模型事件过大');
          }
          continue;
        }
      }
      const end = separator?.index ?? buffer.length;
      const line = buffer.slice(0, end);
      buffer = separator ? buffer.slice(end + (buffer.slice(end, end + 2) === '\r\n' ? 2 : 1)) : '';
      if (line.startsWith('data:') || line === 'data') {
        const value = line.slice(5).replace(/^ /, '');
        dataSize += Buffer.byteLength(value) + 1;
        if (dataSize > MAX_CHUNK) throw Error('Planning 模型事件过大');
        data.push(value);
      } else if (!line && data.length) {
        const payload = data.join('\n'); data = []; dataSize = 0;
        if (payload.trim() === '[DONE]') {
          if (!finished) throw Error('Planning 模型流缺少完成原因');
          return;
        }
        let chunk;
        try { chunk = JSON.parse(payload); } catch (_) { throw Error('Planning 模型事件数据无效'); }
        if (chunk?.error || !Array.isArray(chunk?.choices)) throw Error('Planning 模型流返回错误');
        if (chunk.choices.some(choice => choice?.finish_reason != null)) finished = true;
        yield chunk;
      }
    }
  } finally {
    try { await reader.cancel(); } catch (_) { /* The grant may already have closed the transport. */ }
    signal.removeEventListener('abort', cancelRead);
    reader.releaseLock();
  }
}
module.exports = { events };
