function bindSettingsListDivider(box, listId, key) {
  const list = box.querySelector('.cfg-master');
  const grid = list.parentElement;
  if (grid.querySelector('.cfg-list-divider')) return;
  const inWorkspace = !box.closest('#wsSettingsContent');
  if (inWorkspace) grid.classList.add('cfg-workspace-split');
  const grip = document.createElement('div');
  grip.className = 'cfg-list-divider';
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  list.id = listId;
  grip.setAttribute('aria-labelledby', listId + 'Label');
  grip.setAttribute('aria-controls', list.id);
  list.after(grip);

  const min = 240, max = 420, initial = inWorkspace ? null : 320;
  const storageKey = inWorkspace ? key + '.workspace' : key;
  const limit = () => {
    // A narrow workspace can already give its left pane more than half the width.
    const available = inWorkspace ? Math.max(320, grid.clientWidth - 240) : grid.clientWidth - grip.offsetWidth - 420;
    return Math.max(min, Math.min(max, available));
  };
  let preferred = initial;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) preferred = saved;
  } catch { /* Use the default if local storage is unavailable. */ }
  function paint() {
    const upper = limit(), width = preferred === null ? null : Math.min(preferred, upper);
    if (width === null) grid.style.removeProperty('--cfg-list-width');
    else grid.style.setProperty('--cfg-list-width', width + 'px');
    grip.setAttribute('aria-valuemin', String(min));
    grip.setAttribute('aria-valuemax', String(upper));
    grip.setAttribute('aria-valuenow', String(width ?? list.offsetWidth));
  }
  function save() {
    try {
      if (preferred === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred));
    } catch { /* The current window still keeps its width. */ }
  }
  function adjust(width) {
    preferred = Math.round(Math.max(min, Math.min(limit(), width)));
    paint();
  }
  let drag = null;
  grip.onpointerdown = event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    grip.focus({preventScroll:true});
    drag = { id:event.pointerId, x:event.clientX, width:list.offsetWidth, previous:preferred };
    grip.setPointerCapture(event.pointerId);
  };
  grip.onpointermove = event => {
    if (drag?.id === event.pointerId) adjust(drag.width + event.clientX - drag.x);
  };
  grip.onpointerup = event => {
    if (drag?.id !== event.pointerId) return;
    if (event.clientX !== drag.x) adjust(drag.width + event.clientX - drag.x);
    drag = null;
    save();
  };
  grip.onlostpointercapture = () => {
    if (drag) { preferred = drag.previous; drag = null; paint(); }
  };
  grip.ondblclick = () => { preferred = initial; paint(); save(); };
  grip.onkeydown = event => {
    const width = list.offsetWidth;
    const widths = { ArrowLeft:width - 16, ArrowRight:width + 16, Home:min, End:max };
    if (!Object.hasOwn(widths, event.key)) return;
    event.preventDefault();
    adjust(widths[event.key]); save();
  };
  paint();
  const observer = new ResizeObserver(() => {
    if (grid.isConnected) paint();
    else observer.disconnect();
  });
  observer.observe(grid);
}
