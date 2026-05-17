/**
 * SDBA RDMS — Excel-Like Input Grid Component
 * Arrow key navigation, direct typing, auto-select on focus.
 * Renders lane_count rows with editable Lane, Time, Penalty columns.
 */

/**
 * @typedef {Object} GridColumn
 * @property {string} key - Data field name
 * @property {string} label - Column header text
 * @property {boolean} editable - Whether cells are editable
 * @property {'input'|'select'|'readonly'|'computed'} type
 * @property {number} width - Column width in px
 * @property {Array<{value:string, label:string}>} [options] - For select type
 * @property {function} [format] - Formatter for computed/readonly display
 */

export class ExcelGrid {
  /**
   * @param {HTMLElement} container - DOM element to render into
   * @param {Object} config
   * @param {number} config.rowCount - Number of rows (= lane_count)
   * @param {GridColumn[]} config.columns - Column definitions
   * @param {function} config.onChange - Called with (rowIndex, colKey, newValue, rowData)
   * @param {Object[]} [config.data] - Initial row data
   */
  constructor(container, config) {
    this.container = container;
    this.rowCount = config.rowCount;
    this.columns = config.columns;
    this.onChange = config.onChange || (() => {});
    this.data = config.data || Array.from({ length: this.rowCount }, () => ({}));
    this.cells = []; // 2D array: cells[row][colIdx] = DOM element
    this.focusRow = 0;
    this.focusCol = -1; // -1 = no focus
    this.editableCols = this.columns
      .map((c, i) => ({ ...c, idx: i }))
      .filter(c => c.editable);

    this.render();
    this.attachKeyboardHandler();
  }

  render() {
    const table = document.createElement('table');
    table.className = 'excel-grid';
    table.setAttribute('role', 'grid');

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    // Row number column
    const thNum = document.createElement('th');
    thNum.textContent = '#';
    thNum.style.width = '30px';
    headerRow.appendChild(thNum);

    this.columns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (col.width) th.style.width = `${col.width}px`;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    this.cells = [];

    for (let r = 0; r < this.rowCount; r++) {
      const tr = document.createElement('tr');
      const rowCells = [];

      // Row number
      const tdNum = document.createElement('td');
      tdNum.className = 'cell-rownum';
      tdNum.textContent = r + 1;
      tr.appendChild(tdNum);

      this.columns.forEach((col, c) => {
        const td = document.createElement('td');
        let cellEl;

        if (col.editable && col.type === 'input') {
          cellEl = document.createElement('input');
          cellEl.type = 'text';
          cellEl.className = 'cell-input';
          cellEl.value = this.data[r][col.key] || '';
          cellEl.dataset.row = r;
          cellEl.dataset.col = c;
          cellEl.dataset.key = col.key;
          if (col.placeholder) cellEl.placeholder = col.placeholder;
          if (col.maxLength) cellEl.maxLength = col.maxLength;

          // Auto-select on focus
          cellEl.addEventListener('focus', () => {
            cellEl.select();
            this.focusRow = r;
            this.focusCol = c;
          });

          // Change handler (on blur or immediate for rapid input)
          cellEl.addEventListener('input', () => {
            this.data[r][col.key] = cellEl.value;
            this.onChange(r, col.key, cellEl.value, this.data[r]);
          });

        } else if (col.editable && col.type === 'select') {
          cellEl = document.createElement('select');
          cellEl.className = 'cell-select';
          cellEl.dataset.row = r;
          cellEl.dataset.col = c;
          cellEl.dataset.key = col.key;

          (col.options || []).forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (this.data[r][col.key] === opt.value) option.selected = true;
            cellEl.appendChild(option);
          });

          cellEl.addEventListener('focus', () => {
            this.focusRow = r;
            this.focusCol = c;
          });
          cellEl.addEventListener('change', () => {
            this.data[r][col.key] = cellEl.value;
            this.onChange(r, col.key, cellEl.value, this.data[r]);
          });

        } else {
          // Read-only or computed
          cellEl = document.createElement('span');
          cellEl.className = col.type === 'computed' ? 'cell-computed' : 'cell-readonly';
          const val = this.data[r][col.key];
          cellEl.textContent = col.format ? col.format(val, this.data[r]) : (val ?? '');
        }

        td.appendChild(cellEl);
        tr.appendChild(td);
        rowCells.push(cellEl);
      });

      tbody.appendChild(tr);
      this.cells.push(rowCells);
    }

    table.appendChild(tbody);

    // Wrap in scrollable container
    this.container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'excel-grid-container';
    wrapper.appendChild(table);
    this.container.appendChild(wrapper);
    this.tableEl = table;
  }

  attachKeyboardHandler() {
    this.tableEl.addEventListener('keydown', (e) => {
      const target = e.target;
      const row = parseInt(target.dataset?.row);
      const col = parseInt(target.dataset?.col);
      if (isNaN(row) || isNaN(col)) return;

      let handled = false;

      switch (e.key) {
        case 'ArrowUp':
          this.moveFocus(row - 1, col);
          handled = true;
          break;
        case 'ArrowDown':
          this.moveFocus(row + 1, col);
          handled = true;
          break;
        case 'ArrowLeft':
          // Only move left if cursor is at start of input
          if (target.tagName === 'INPUT' && target.selectionStart > 0) break;
          this.moveFocusEditable(row, col, -1);
          handled = true;
          break;
        case 'ArrowRight':
          // Only move right if cursor is at end of input
          if (target.tagName === 'INPUT' && target.selectionStart < target.value.length) break;
          this.moveFocusEditable(row, col, 1);
          handled = true;
          break;
        case 'Enter':
          this.moveFocus(row + 1, col);
          handled = true;
          break;
        case 'Tab':
          e.preventDefault();
          this.moveFocusEditable(row, col, e.shiftKey ? -1 : 1);
          handled = true;
          break;
        case 'Escape':
          target.blur();
          handled = true;
          break;
      }

      if (handled) e.preventDefault();
    });
  }

  moveFocus(newRow, newCol) {
    if (newRow < 0 || newRow >= this.rowCount) return;
    if (newCol < 0 || newCol >= this.columns.length) return;
    const cell = this.cells[newRow][newCol];
    if (cell && (cell.tagName === 'INPUT' || cell.tagName === 'SELECT')) {
      cell.focus();
    }
  }

  moveFocusEditable(currentRow, currentCol, direction) {
    // Find next/previous editable column
    let c = currentCol + direction;
    let r = currentRow;

    while (r >= 0 && r < this.rowCount) {
      while (c >= 0 && c < this.columns.length) {
        if (this.columns[c].editable) {
          this.moveFocus(r, c);
          return;
        }
        c += direction;
      }
      // Wrap to next/previous row
      r += direction;
      c = direction > 0 ? 0 : this.columns.length - 1;
    }
  }

  // ──── Public API ────

  /** Get all row data */
  getData() {
    return this.data;
  }

  /** Set data for a specific row */
  setRowData(rowIndex, rowData) {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return;
    this.data[rowIndex] = { ...this.data[rowIndex], ...rowData };
    this.refreshRow(rowIndex);
  }

  /** Update a computed/readonly cell display */
  setCellDisplay(rowIndex, colKey, value) {
    const colIdx = this.columns.findIndex(c => c.key === colKey);
    if (colIdx === -1 || rowIndex < 0 || rowIndex >= this.rowCount) return;
    const cell = this.cells[rowIndex][colIdx];
    const col = this.columns[colIdx];
    if (cell && (cell.className.includes('cell-readonly') || cell.className.includes('cell-computed'))) {
      cell.textContent = col.format ? col.format(value, this.data[rowIndex]) : (value ?? '');
    }
    this.data[rowIndex][colKey] = value;
  }

  /** Mark a cell as having an error */
  setCellError(rowIndex, colKey, hasError) {
    const colIdx = this.columns.findIndex(c => c.key === colKey);
    if (colIdx === -1) return;
    const cell = this.cells[rowIndex][colIdx];
    if (cell) cell.classList.toggle('error', hasError);
  }

  /** Refresh display of a single row (re-read from data) */
  refreshRow(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return;
    const rowData = this.data[rowIndex];

    this.columns.forEach((col, c) => {
      const cell = this.cells[rowIndex][c];
      if (!cell) return;

      if (col.editable && cell.tagName === 'INPUT') {
        if (document.activeElement !== cell) {
          cell.value = rowData[col.key] || '';
        }
      } else if (col.editable && cell.tagName === 'SELECT') {
        cell.value = rowData[col.key] || '';
      } else {
        const val = rowData[col.key];
        cell.textContent = col.format ? col.format(val, rowData) : (val ?? '');
      }
    });
  }

  /** Refresh all rows */
  refreshAll() {
    for (let r = 0; r < this.rowCount; r++) {
      this.refreshRow(r);
    }
  }

  /** Focus a specific cell */
  focus(row, col) {
    this.moveFocus(row, col);
  }

  /** Destroy the grid */
  destroy() {
    this.container.innerHTML = '';
    this.cells = [];
  }
}
