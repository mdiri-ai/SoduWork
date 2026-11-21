'use strict';

const fileOpen = require('./file-open.cjs');

// A quit can be prevented and never re-entered (for example a shutdown promise
// that never settles). Without a bound, `quitting` would stay set forever and
// every later launch would be deferred into a process that keeps running.
// Un-mark after a grace period that comfortably covers the cleanup below.
const QUIT_ABORT_GRACE_MS = 30 * 1000;

/*
 * A confirmed quit can take several seconds while running conversations stop.
 * A launch during that window cannot take the single-instance lock, so it hands
 * off to this process and exits; this process then exits too and nothing is
 * left running. Remember the request and start a fresh instance after exit.
 */
function create(app, { argv = process.argv } = {}) {
  let quitting = false;
  let requested = false;
  let abortTimer = null;
  const pending = new Set();
  const cancelAbort = () => { if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; } };
  const resetQuitting = () => {
    abortTimer = null;
    if (!quitting) return;
    quitting = false;
    requested = false;
    if (pending.size) console.warn(`[quit-relaunch] quit aborted; ${pending.size} deferred file(s) discarded`);
    pending.clear();
  };
  // Cleanup may re-enter before-quit several times. Schedule once at the final
  // boundary, so later launches during cleanup can still contribute their files.
  app.once('will-quit', () => {
    cancelAbort();
    if (requested) app.relaunch({ args: fileOpen.relaunchArgs(argv, [...pending]) });
  });
  return {
    markQuitting() {
      quitting = true;
      cancelAbort();
      abortTimer = setTimeout(resetQuitting, QUIT_ABORT_GRACE_MS);
    },
    get quitting() { return quitting; },
    // Returns true when the launch was deferred until this process exits.
    deferLaunch(files = []) {
      if (!quitting) return false;
      requested = true;
      let dropped = 0;
      for (const file of fileOpen.normalizeFiles(files)) {
        if (pending.size < 20) pending.add(file);
        else dropped += 1;
      }
      if (dropped) console.warn(`[quit-relaunch] ${dropped} deferred file(s) dropped (relaunch keeps at most 20)`);
      return true;
    },
  };
}

module.exports = { create };
