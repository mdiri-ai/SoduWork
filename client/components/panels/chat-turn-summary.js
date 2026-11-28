/* Completed-turn presentation only. Source messages and output ownership stay intact. */
(function (global) {
  'use strict';
  const owner = (snap, index) => snap.history?.messageIndices?.[index] ??
    ((Number(snap.history?.messageStart) || 0) + index);
  const epoch = value => typeof value === 'number' ? value : Date.parse(value || '');
  const tx = value => global.SoduWorkI18n?.translateText?.(value) || value;
  function stoppedText(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return tx('你已停止');
    const total = Math.floor(elapsedMs / 1000);
    const template = total >= 3600 ? '你在 {hours} 小时 {minutes} 分 {seconds} 秒后停止了'
      : total >= 60 ? '你在 {minutes} 分 {seconds} 秒后停止了' : '你在 {seconds} 秒后停止了';
    return tx(template).replace('{hours}', String(Math.floor(total / 3600)))
      .replace('{minutes}', String(Math.floor(total / 60) % 60))
      .replace('{seconds}', String(total % 60));
  }
  function tokenInfo(messages, from, to, metric) {
    if (Number.isFinite(metric?.tokens)) return { tokens: metric.tokens, tokensEstimated: false };
    const counter = global.ChatStatus || (typeof require === 'function' ? require('./panels-chat-status') : null);
    if (!counter?.outputTokens || !counter?.estimateOutput) return { tokens: null, tokensEstimated: false };
    let tokens = 0, known = false, estimated = messages[from]?.role !== 'user';
    for (let index = from; index <= to; index++) {
      const message = messages[index];
      if (message?.role !== 'assistant') continue;
      const actual = counter.outputTokens(message.usage);
      if (actual !== null) { tokens += actual; known = true; }
      else {
        const estimate = counter.estimateOutput(message);
        tokens += estimate; known = known || estimate > 0; estimated = true;
      }
    }
    // Old native archives may lack turn receipts. Estimate only their exposed
    // output; context occupancy and cumulative session billing are unrelated.
    return { tokens: known ? tokens : null, tokensEstimated: known && estimated };
  }
  function project(snap, finalReplies) {
    const messages = snap.messages || [], turns = [];
    let from = 0;
    messages.forEach((message, index) => {
      if (message.role === 'user') from = index;
      if (!finalReplies.has(index) || message.done === false) return;
      let to = index;
      while (to + 1 < messages.length && messages[to + 1].role !== 'user') to++;
      if ((snap.tools || []).some(tool => tool.state === 'running' &&
        (Number(tool.after) || 0) >= from && (Number(tool.after) || 0) <= to)) return;
      const absolute = owner(snap, index);
      const metric = (snap.turnMetrics || []).find(row => row.fromMessage <= absolute && row.toMessage >= absolute);
      if (metric?.outcome) return;
      const start = messages[from]?.role === 'user' ? epoch(messages[from].sentAt) : NaN;
      const end = epoch(message.completedAt);
      const wallTime = Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start ? end - start : null;
      // The latest cloud receipt belongs to the remote turn, not replay arrival times.
      const latestCloud = snap.execution?.cloud && to === messages.length - 1;
      const cloudElapsed = !snap.execution?.running && snap.execution?.completedAt > 0 &&
        Number.isFinite(snap.execution.elapsedMs) ? snap.execution.elapsedMs : null;
      turns.push({ key: 'reply:' + absolute, from, to, finalIndex: index,
        lastToolBlock: (message.blocks || []).findLastIndex(block => block.kind === 'toolcall'),
        ...tokenInfo(messages, from, to, metric),
        /* The footer quotes the task total this turn reached, so the running value has to
           travel with the turn instead of being recomputed from the final summary. */
        cumulativeTokens: Number.isFinite(metric?.cumulativeTokens) ? metric.cumulativeTokens : null,
        elapsedMs: latestCloud ? cloudElapsed : Number.isFinite(metric?.elapsedMs) ? metric.elapsedMs : wallTime,
        wallTime: !latestCloud && !Number.isFinite(metric?.elapsedMs),
      });
    });
    for (const metric of snap.turnMetrics || []) {
      if (!['stopped', 'interrupted'].includes(metric.outcome)) continue;
      const indices = messages.map((_, index) => index).filter(index =>
        owner(snap, index) >= metric.fromMessage && owner(snap, index) <= metric.toMessage);
      if (!indices.length) continue;
      const to = indices.at(-1);
      // A pending followup may start before its user message is echoed. The
      // previous turn's receipt remains historical even while the chat is busy.
      turns.push({ key: 'outcome:' + metric.fromMessage, from: indices[0], to,
        outcome: metric.outcome, elapsedMs: metric.elapsedMs, finalIndex: -1, lastToolBlock: -1 });
    }
    return turns;
  }
  function create(ctx) {
    const expanded = new Set();
    let scope = '', turns = [], byIndex = new Map(), boundList = null;
    const duration = value => {
      if (value === null) return ctx.esc(tx('未记录'));
      const seconds = Math.floor(Math.max(0, value) / 1000);
      return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
    };
    function reset() { expanded.clear(); turns = []; byIndex.clear(); scope = ''; closeUsageMenu(); }
    /*
     * The footer quotes what the task had consumed when this turn ended, not the latest
     * session total: a per-turn figure read from the ledger's own receipts is what makes
     * the number reconcile with 「我的用量」 without every row showing today's total.
     * Tokens stay visible without a price; the ledger never invents a cost.
     */
    function usageFacts(turn) {
      const summary = ctx._snap?.usageSummary;
      const tokens = Number(turn && turn.cumulativeTokens) || 0;
      if (!(tokens > 0)) return null;
      const brand = global.AgentBrand;
      /* Receipts carry the agent that actually billed the call; older archived turns may
         omit it, so fall back to the newest visible attribution instead of guessing. */
      const agentKey = summary?.agent || (ctx._snap?.messages || []).reduceRight(
        (found, message) => found || String(message?.sourceAgent?.agentId || ''), '');
      const agentId = agentKey ? (brand?.canonical?.(agentKey) || String(agentKey)) : '';
      const agentLabel = agentId ? (brand?.LABELS?.[agentId] || agentId) : '';
      const locale = globalThis.SoduWorkI18n?.getLocale?.() || 'zh-CN';
      const parts = [agentLabel, String(summary?.model || '')].filter(Boolean);
      const head = parts.length ? parts.join(' · ') + ' · ' : '';
      const text = head + tx('本次任务累计') + ' ' + tokens.toLocaleString(locale) + ' tokens';
      const hint = tx('（右键查看用量）');
      const title = tx('Agent · 模型 · 截至这一轮结束时本次任务累计消耗的 token，与「我的用量」读取同一份账本；右键可打开用量记录。');
      return {
        text,
        html: '<span class="nturn-usage" data-turn-usage="' + ctx.esc(turn.key) +
          '" title="' + ctx.esc(title) + '">' + ctx.esc(text) + ctx.esc(hint) + '</span>',
      };
    }
    /* The renderer also runs under a bare stub inside tests, so every cleanup step has to
       tolerate a missing document or window instead of assuming a live browser. */
    function closeUsageMenu() {
      const doc = typeof document === 'undefined' ? null : document;
      const win = typeof window === 'undefined' ? null : window;
      const menu = doc?.querySelector ? doc.querySelector('.nturn-usage-menu') : null;
      if (menu) menu.remove();
      doc?.removeEventListener?.('pointerdown', onUsageMenuOutside, true);
      doc?.removeEventListener?.('keydown', onUsageMenuKey, true);
      win?.removeEventListener?.('resize', closeUsageMenu);
      win?.removeEventListener?.('scroll', closeUsageMenu, true);
    }
    function onUsageMenuKey(event) { if (event.key === 'Escape') closeUsageMenu(); }
    function onUsageMenuOutside(event) {
      const menu = document.querySelector('.nturn-usage-menu');
      if (menu && !menu.contains(event.target)) closeUsageMenu();
    }
    function openUsageMenu(x, y) {
      closeUsageMenu();
      const menu = document.createElement('div');
      menu.className = 'nturn-usage-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', tx('本次任务用量'));
      menu.innerHTML = '<button type="button" role="menuitem" data-usage-action="open">' +
        ctx.esc(tx('查看用量记录')) + '</button>';
      document.body.appendChild(menu);
      const box = menu.getBoundingClientRect();
      menu.style.left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - box.width - 8)) + 'px';
      menu.style.top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - box.height - 8)) + 'px';
      menu.addEventListener('click', event => {
        if (!event.target.closest?.('[data-usage-action="open"]')) return;
        closeUsageMenu();
        /*
         * Open through the workspace host instead of showing the panel directly. The host
         * records which page is on screen, and that record is what lets the next sidebar
         * navigation close this panel; showing it bare left the route stale, so choosing a
         * conversation appeared to do nothing because the usage page stayed on top.
         */
        if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') {
          global.WorkspaceHost.open('usage', {});
          return;
        }
        if (typeof global.openUsagePanel === 'function') global.openUsagePanel();
      });
      // Listen after the contextmenu event unwinds so the opening gesture cannot close it.
      setTimeout(() => {
        if (!menu.isConnected) return;
        document.addEventListener('pointerdown', onUsageMenuOutside, true);
        document.addEventListener('keydown', onUsageMenuKey, true);
        window.addEventListener('resize', closeUsageMenu);
        window.addEventListener('scroll', closeUsageMenu, true);
      }, 0);
      const first = menu.querySelector('[data-usage-action]');
      if (first) first.focus({ preventScroll: true });
    }
    function prepare(snap, finals) {
      const nextScope = JSON.stringify([ctx._ref || '', global.SoduWorkAPI?.taskStorageKey?.('ops') || '']);
      if (scope !== nextScope) { reset(); scope = nextScope; }
      turns = project(snap, finals); byIndex = new Map();
      turns.forEach(turn => { for (let index = turn.from; index <= turn.to; index++) byIndex.set(index, turn); });
      return byIndex;
    }
    function html(turn, currentMetrics) {
      if (turn.outcome) {
        const text = turn.outcome === 'stopped'
          ? stoppedText(turn.elapsedMs)
          : tx('本轮已中断');
        return '<div class="nturn-outcome" data-chat-node="turn-summary:' + ctx.esc(turn.key) + '">' + ctx.esc(text) + '</div>';
      }
      const open = expanded.has(turn.key);
      const label = ctx.esc(tx(open ? '收起过程' : '展开过程'));
      // A completed turn owns immutable timing, including after switching or
      // reopening. A live counter cannot supply a missing historical duration.
      // The live token counter is dropped because it counts this reply only, while the
      // footer quotes the running task total at the moment this turn ended.
      let values = currentMetrics ? currentMetrics.replace(/^<div\b[^>]*>/, '').replace(/<\/div>$/, '')
        : '<span>' + ctx.esc(tx('用时')) + ' ' + duration(turn.elapsedMs) + '</span>';
      values = values.replace(/(<span\b[^>]*\bdata-thinking-label[^>]*>)[\s\S]*?(<\/span>)/,
        (_, before, after) => before + ctx.esc(tx('用时')) + after);
      if (currentMetrics) {
        values = values.replace(/(<b\b[^>]*\bdata-thinking-elapsed[^>]*>)[\s\S]*?(<\/b>)/,
          (_, before, after) => before + duration(turn.elapsedMs) + after);
      }
      if (currentMetrics) {
        values = values
          // The token metric is a nested status item. Removing only its value
          // leaves the surrounding `tokens` label visible in completed turns.
          .replace(/<span\b(?=[^>]*\bclass=["'][^"']*\bnstatus-metric\b[^"']*["'])[^>]*>(?:(?!<span\b(?=[^>]*\bclass=["'][^"']*\bnstatus-metric\b[^"']*["'])[^>]*>)[\s\S])*?<b\b[^>]*\bdata-thinking-tokens\b[^>]*>[\s\S]*?<\/b>[\s\S]*?<\/span>\s*/gi, '')
          .replace(/<span\b[^>]*\bdata-thinking-estimate[^>]*>[\s\S]*?<\/span>/g, '')
          .replace(/<b\b[^>]*\bdata-thinking-tokens[^>]*>[\s\S]*?<\/b>/g, '')
          .replace(/<span\b[^>]*\bdata-thinking-tokens[^>]*>[\s\S]*?<\/span>/g, '')
          .replace(/<span\b[^>]*>\s*(?:≈\s*)?(?:—|[\d,]+)?\s*tokens\s*<\/span>/gi, '')
          .replace(/<b\b[^>]*>\s*(?:≈\s*)?(?:—|[\d,]+)?\s*tokens\s*<\/b>/gi, '')
          .replace(/\s+tokens?\b/gi, '')
          .replace(/<span\b[^>]*class=["']nstatus-divider["'][^>]*>\s*·\s*<\/span>/g, '');
      }
      const facts = usageFacts(turn);
      if (facts) values += '<span class="nstatus-divider">·</span>' + facts.html;
      return '<div class="nturn-summary" data-chat-node="turn-summary:' + ctx.esc(turn.key) + '">' +
        '<button type="button" data-turn-toggle="' + ctx.esc(turn.key) + '" aria-expanded="' + open +
        '" title="' + label + '" aria-label="' + label + '">' +
        '<span class="nturn-summary-values">' + values + '</span>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>' +
        '<p data-turn-empty hidden>' + ctx.esc(tx('本轮没有可显示的过程记录。')) + '</p></div>';
    }
    function apply(list) {
      if (!list?.querySelectorAll) return;
      list.querySelectorAll('[data-turn-hidden]').forEach(node => node.removeAttribute('data-turn-hidden'));
      list.querySelectorAll('[data-turn-process]').forEach(node => node.removeAttribute('data-turn-process'));
      const hide = node => node.setAttribute('data-turn-hidden', '');
      const withProcess = new Set();
      for (const row of Array.from(list.children || [])) {
        const key = row.dataset.chatNode || '';
        const message = /^message:(\d+)$/.exec(key);
        const tools = /^(?:tools|process):message:(\d+)(?::|$)/.exec(key);
        const index = message ? Number(message[1]) : tools ? Number(tools[1]) :
          /^(?:(?:tools|process):tail|goal-progress:)/.test(key) ? (ctx._snap?.messages?.length || 1) - 1 : -1;
        const turn = byIndex.get(index);
        if (!turn || turn.outcome || row.classList.contains('user')) continue;
        const open = expanded.has(turn.key);
        if (message) {
          row.querySelectorAll(':scope > .nthink').forEach(node => {
            if (open && node.querySelector('[data-thinking-body]')?.textContent.trim()) withProcess.add(turn.key);
            else hide(node);
          });
          row.querySelectorAll(':scope > .ntext').forEach(node => {
            if (index === turn.finalIndex && Number(node.dataset.block) > turn.lastToolBlock) return;
            if (!open) hide(node);
            else if (node.textContent.trim() || node.querySelector('img,video,audio')) withProcess.add(turn.key);
          });
          if (!open && index !== turn.finalIndex) {
            row.querySelectorAll(':scope > .nmessage-footer').forEach(hide);
            row.setAttribute('data-turn-process', '');
          }
        } else if (!open) row.setAttribute('data-turn-process', '');
        else if (row.childElementCount) withProcess.add(turn.key);
      }
      list.querySelectorAll(':scope > .nturn-summary > button[data-turn-toggle]').forEach(button => {
        const open = expanded.has(button.dataset.turnToggle);
        button.setAttribute('aria-expanded', String(open));
        button.title = tx(open ? '收起过程' : '展开过程');
        button.setAttribute('aria-label', button.title);
        button.parentElement.querySelector('[data-turn-empty]').hidden = !open || withProcess.has(button.dataset.turnToggle);
      });
      list.querySelectorAll('[data-turn-usage]').forEach(node => {
        if (node.dataset.usageBound === '1') return;
        node.dataset.usageBound = '1';
        node.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          openUsageMenu(event.clientX, event.clientY);
        });
      });
      if (boundList === list) return;
      boundList = list;
      list.addEventListener('click', event => {
        const button = event.target.closest?.('[data-turn-toggle]');
        if (!button || !list.contains(button)) return;
        event.preventDefault();
        const key = button.dataset.turnToggle;
        if (!turns.some(turn => turn.key === key)) return;
        const top = button.getBoundingClientRect().top;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        apply(list);
        const scroll = list.closest('.nchat-scroll');
        if (scroll) scroll.scrollTop += button.getBoundingClientRect().top - top;
      });
    }
    return { prepare, html, apply, reset };
  }
  const api = { project, create };
  global.ChatTurnSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
