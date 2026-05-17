/**
 * SDBA RDMS — Searchable Multi-Select
 *
 * Vanilla replacement for the SDBA-RMS Materialize multi-select pattern.
 * A button shows the current selection count; clicking opens a panel with a
 * search input and a checkbox list. Options can carry a sublabel so each row
 * can render "<code> — <name>" style content. Click outside closes the panel.
 */

let openInstance = null;

function closeAny() {
  if (openInstance) {
    openInstance.panel.style.display = 'none';
    openInstance = null;
  }
}

document.addEventListener('click', (e) => {
  if (!openInstance) return;
  if (openInstance.root.contains(e.target)) return;
  closeAny();
});

/**
 * Mount a multi-select onto a container.
 *
 * @param {HTMLElement} container - host element (will be emptied)
 * @param {Object} opts
 * @param {Array<{value:string|number, label:string, sublabel?:string}>} opts.options
 * @param {Array<string|number>} [opts.initial] - initially selected values
 * @param {string} [opts.placeholder] - label when nothing is selected
 * @param {string} [opts.allLabel] - label when everything is selected (defaults to placeholder)
 * @param {string} [opts.searchPlaceholder]
 * @param {function(Array<string|number>): void} [opts.onChange]
 * @returns {{ getSelected: () => Array, setSelected: (vals: Array) => void, destroy: () => void }}
 */
export function mountMultiSelect(container, opts) {
  const options = opts.options || [];
  const placeholder = opts.placeholder || 'Select…';
  const allLabel = opts.allLabel || `All (${options.length})`;
  const searchPlaceholder = opts.searchPlaceholder || 'Search…';
  let selected = new Set((opts.initial || []).map(String));
  let query = '';

  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'ms-root';
  root.style.cssText = 'position:relative; display:inline-block;';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-outline';
  btn.style.cssText = 'min-width:180px; justify-content:space-between; display:inline-flex; align-items:center; gap:8px;';
  root.appendChild(btn);

  const panel = document.createElement('div');
  panel.className = 'ms-panel';
  panel.style.cssText = 'display:none; position:absolute; top:calc(100% + 4px); left:0; min-width:260px; max-height:320px; overflow:hidden; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm); box-shadow:var(--shadow-md); z-index:1000; display:none; flex-direction:column;';
  root.appendChild(panel);

  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding:8px; border-bottom:1px solid var(--border-subtle);';
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'form-input';
  search.placeholder = searchPlaceholder;
  search.style.cssText = 'width:100%; font-size:13px;';
  searchWrap.appendChild(search);
  panel.appendChild(searchWrap);

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex; gap:6px; padding:6px 8px; border-bottom:1px solid var(--border-subtle); font-size:12px;';
  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'btn btn-ghost';
  btnAll.style.cssText = 'padding:2px 8px; font-size:12px;';
  btnAll.textContent = 'All';
  const btnNone = document.createElement('button');
  btnNone.type = 'button';
  btnNone.className = 'btn btn-ghost';
  btnNone.style.cssText = 'padding:2px 8px; font-size:12px;';
  btnNone.textContent = 'None';
  toolbar.appendChild(btnAll);
  toolbar.appendChild(btnNone);
  panel.appendChild(toolbar);

  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto; flex:1;';
  panel.appendChild(list);

  function renderButton() {
    const count = selected.size;
    let label;
    if (count === 0) label = placeholder;
    else if (count === options.length) label = allLabel;
    else if (count === 1) {
      const only = options.find(o => selected.has(String(o.value)));
      label = only ? (only.label || String(only.value)) : `1 selected`;
    } else {
      label = `${count} selected`;
    }
    btn.innerHTML = `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(label)}</span><i class="material-icons" style="font-size:18px;">arrow_drop_down</i>`;
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? options.filter(o =>
          (o.label || '').toLowerCase().includes(q) ||
          (o.sublabel || '').toLowerCase().includes(q) ||
          String(o.value).toLowerCase().includes(q))
      : options;

    if (filtered.length === 0) {
      list.innerHTML = `<div style="padding:12px; font-size:13px; color:var(--text-tertiary); text-align:center;">No matches</div>`;
      return;
    }

    list.innerHTML = filtered.map(o => {
      const checked = selected.has(String(o.value)) ? 'checked' : '';
      const main = escapeHtml(o.label || String(o.value));
      const sub = o.sublabel ? `<span style="color:var(--text-tertiary); font-size:12px; margin-left:6px;">${escapeHtml(o.sublabel)}</span>` : '';
      return `<label style="display:flex; align-items:center; gap:8px; padding:6px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border-subtle);" data-val="${escapeAttr(String(o.value))}">
        <input type="checkbox" ${checked} style="margin:0;"/>
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${main}${sub}</span>
      </label>`;
    }).join('');

    list.querySelectorAll('label').forEach(lbl => {
      const cb = lbl.querySelector('input');
      const val = lbl.dataset.val;
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(val);
        else selected.delete(val);
        renderButton();
        if (opts.onChange) opts.onChange(currentSelected());
      });
    });
  }

  function currentSelected() {
    // Preserve original value type (number vs string) by mapping back.
    return options
      .filter(o => selected.has(String(o.value)))
      .map(o => o.value);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openInstance && openInstance.panel === panel) {
      closeAny();
      return;
    }
    closeAny();
    panel.style.display = 'flex';
    openInstance = { root, panel };
    search.focus();
  });

  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });

  btnAll.addEventListener('click', () => {
    selected = new Set(options.map(o => String(o.value)));
    renderList();
    renderButton();
    if (opts.onChange) opts.onChange(currentSelected());
  });

  btnNone.addEventListener('click', () => {
    selected = new Set();
    renderList();
    renderButton();
    if (opts.onChange) opts.onChange(currentSelected());
  });

  container.appendChild(root);
  renderButton();
  renderList();

  return {
    getSelected: () => currentSelected(),
    setSelected: (vals) => {
      selected = new Set((vals || []).map(String));
      renderList();
      renderButton();
    },
    destroy: () => {
      if (openInstance && openInstance.panel === panel) closeAny();
      container.innerHTML = '';
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
