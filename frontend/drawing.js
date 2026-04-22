// ============================================================
//  drawing.js — Motor de dibujo para TradingR3
//  Depende de: chart.js (variables globales: mainChart, candleSeries)
//  Se carga DESPUÉS de chart.js y ANTES de backtest.js
// ============================================================

const drawingState = {
  mode: 'select',           // 'select' | 'draw'
  tool: null,
  phase: 'idle',            // 'idle' | 'first_point' | 'second_point' | 'third_point'
  points: [],               // puntos capturados [{time,price,x,y}]
  activeObjId: null,
  dragOffset: null,
  dragHandleIndex: null,    // índice del handle que se está arrastrando
  hoveredObjId: null,
  isDragging: false,
  objects: [],              // array de DrawingObject
  undoStack: [],
  settings: {
    color: '#2196F3',
    lineWidth: 1,
    lineStyle: 'solid',
    fillColor: 'rgba(33,150,243,0.1)',
    showLabels: true,
    extendLeft: false,
    extendRight: true
  },
  mouseX: 0,
  mouseY: 0
};

// ── Utilidades de coordenadas ──────────────────────────────────────────────

function getSecondsPerBar() {
  let tf = (typeof currentTimeframe !== 'undefined' && currentTimeframe) ? String(currentTimeframe).toUpperCase() : 'M5';
  
  // Handle formats like "1M", "5M", "1H", "M5", "H1"
  const val = parseInt(tf.replace(/[^0-9]/g, ''));
  const unit = tf.replace(/[0-9]/g, '');
  
  if (unit.includes('M')) return (isNaN(val) ? 5 : val) * 60;
  if (unit.includes('H')) return (isNaN(val) ? 1 : val) * 3600;
  if (unit.includes('D')) return (isNaN(val) ? 1 : val) * 86400;
  if (unit.includes('W')) return (isNaN(val) ? 1 : val) * 604800;
  if (unit.includes('S')) return (isNaN(val) ? 1 : val);
  
  return 300; // Default 5m
}

// Globals to store reference for stable coordinate mapping every frame
let currentRefCandle = null;
let currentRefLogical = null;
let currentRefX = null;

function resetDrawingReference() {
  currentRefCandle = null;
  currentRefLogical = null;
  currentRefX = null;
}

function updateCurrentRef() {
  if (typeof mainChart === 'undefined' || typeof candleSeries === 'undefined' || typeof candleData === 'undefined' || candleData.length === 0) return;
  const timeScale = mainChart.timeScale();
  const canvas = document.getElementById('drawing-canvas');
  if (!timeScale || !canvas) return;

  // SYSTEM ANCHOR: Always use the absolute last candle of the series as the base.
  // This prevents drift when scrolling or resizing.
  const idx = candleData.length - 1;
  const anchor = candleData[idx];
  
  currentRefCandle = anchor;
  currentRefLogical = idx;
  currentRefX = timeScale.logicalToCoordinate(idx);
  
  if (currentRefX === null) {
      // Manual extrapolation if anchor is off-screen
      const range = timeScale.getVisibleLogicalRange();
      if (range) {
          const centerLog = (range.from + range.to) / 2;
          const barSpacing = timeScale.options().barSpacing || 6;
          currentRefX = (canvas.width / 2) + (idx - centerLog) * barSpacing;
      }
  }
}

function resizeCanvas() {
  const mainEl = document.getElementById('main-chart');
  const canvas = document.getElementById('drawing-canvas');
  if (!mainEl || !canvas) return;

  const rect = mainEl.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  
  // CSS sync
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
}

const chartResizeObserver = new ResizeObserver(() => {
    resizeCanvas();
});

function initDrawingSystem() {
    const mainEl = document.getElementById('main-chart');
    if (mainEl) chartResizeObserver.observe(mainEl);
    setTimeout(resizeCanvas, 50);
}

if (document.readyState === 'complete') initDrawingSystem();
else window.addEventListener('load', initDrawingSystem);

function pixelToChart(x, y) {
  // Use the BT specialized engine if active
  if (window.DrawingBT && window.backtestState && window.backtestState.active) {
      return DrawingBT.pixelToChart(x, y);
  }
  
  try {
    const timeScale = mainChart.timeScale();
    const priceScale = candleSeries.priceScale();
    const canvas = document.getElementById('drawing-canvas');
    if (!timeScale || !priceScale || !canvas) return { time: null, price: null };

    const price = candleSeries.coordinateToPrice(y);
    let logical = timeScale.coordinateToLogical(x);
    let time = timeScale.coordinateToTime(x);

    // B. Sub-bar Extrapolation (The "Wall" Smasher)
    // Even in Real-Time, clicking in the future padding returns null time.
    if (time === null && logical !== null && candleData && candleData.length > 0) {
        const secPerBar = Math.max(getSecondsPerBar(), 1);
        const lastIdx = candleData.length - 1;
        const lastCandle = candleData[lastIdx];
        time = lastCandle.time + (logical - lastIdx) * secPerBar;
    }
    
    return { time, price, offsetSeconds: 0, logical };
  } catch (e) {
    console.error("Error in pixelToChart:", e);
    return { time: null, price: null, offsetSeconds: 0, logical: null };
  }
}

function chartToPixel(time, price, offsetSeconds = 0, logical = null) {
  // Use the BT specialized engine if active
  if (window.DrawingBT && window.backtestState && window.backtestState.active) {
      return DrawingBT.chartToPixel(time, price, offsetSeconds, logical);
  }

  try {
    const timeScale = mainChart.timeScale();
    const secPerBar = Math.max(getSecondsPerBar(), 1);

    if (time === null || time === undefined || isNaN(Number(time)) || time <= 0) return { x: null, y: null };
    if (price === null || price === undefined || isNaN(Number(price))) return { x: null, y: null };
    
    let y = candleSeries.priceToCoordinate(price);
    let x = timeScale.timeToCoordinate(time);

    // Minor extrapolation for nearby future/past in Real-Time
    if (x === null && candleData && candleData.length > 0) {
        const lastCandle = candleData[candleData.length - 1];
        const lastX = timeScale.timeToCoordinate(lastCandle.time);
        if (lastX !== null) {
            const barSpacing = timeScale.options().barSpacing || 6;
            const diff = (time - lastCandle.time) / secPerBar;
            x = lastX + diff * barSpacing;
        } else {
            // Far off-screen fallback
            const range = timeScale.getVisibleLogicalRange();
            if (range) {
                const centerLog = (range.from + range.to) / 2;
                const canvas = document.getElementById('drawing-canvas');
                const lastIdx = candleData.length - 1;
                const targetLog = lastIdx + (time - lastCandle.time) / secPerBar;
                const barSpacing = timeScale.options().barSpacing || 6;
                x = (canvas.width / 2) + (targetLog - centerLog) * barSpacing;
            }
        }
    }

    if (x !== null && Math.abs(offsetSeconds) > 0.1 && (Number(time) % 1 === 0)) {
        const barSpacing = timeScale.options().barSpacing || 6;
        x += (offsetSeconds / secPerBar) * barSpacing;
    }

    return { x, y };
  } catch (e) {
    console.error("Error in chartToPixel:", e);
    return { x: null, y: null };
  }
}

window.setPositionType = function(tool) {
    window._positionType = tool;
    if (typeof setDrawingTool === 'function') setDrawingTool(tool);
};


// ── Canvas setup ──────────────────────────────────────────────────────────

function syncCanvasSize() {
  const canvas = document.getElementById('drawing-canvas');
  const container = document.getElementById('main-chart');
  if (!canvas || !container) return;
  const rect = container.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
}

function isMouseInScaleArea(x, y) {
  const canvas = document.getElementById('drawing-canvas');
  if (!canvas) return false;
  
  const PRICE_SCALE_WIDTH = 60; // Based on chart.js minimumWidth
  const TIME_SCALE_HEIGHT = 26; 
  
  const inPriceScale = x > (canvas.width - PRICE_SCALE_WIDTH);
  const inTimeScale = y > (canvas.height - TIME_SCALE_HEIGHT);
  
  return inPriceScale || inTimeScale;
}

function updateCanvasPointerEvents(e) {
  const canvas = document.getElementById('drawing-canvas');
  if (!canvas) return;
  
  let x = drawingState.mouseX;
  let y = drawingState.mouseY;
  
  if (e) {
      const rect = canvas.getBoundingClientRect();
      x = e.clientX - rect.left;
      y = e.clientY - rect.top;
  }
  
  // 1. If we are in the scale area, ALWAYS disable events so chart can handle them
  if (isMouseInScaleArea(x, y) && !drawingState.isDragging) {
      canvas.style.pointerEvents = 'none';
      canvas.style.cursor = 'default';
      return;
  }

  // 2. Otherwise, use normal logic
  const someSelected = drawingState.objects.some(o => o.selected);
  const needsEvents = drawingState.mode === 'draw' || !!drawingState.hoveredObjId || drawingState.isDragging || !!drawingState.activeObjId || someSelected;
  
  const current = canvas.style.pointerEvents;
  const target = needsEvents ? 'auto' : 'none';
  
  if (current !== target) {
      canvas.style.pointerEvents = target;
      canvas.style.cursor = (drawingState.mode === 'draw') ? 'crosshair' : (drawingState.hoveredObjId ? 'pointer' : 'default');
  }
}

function initDrawingCanvas() {
  // Remove previous if exists
  const existing = document.getElementById('drawing-canvas');
  if (existing) existing.remove();

  const canvas = document.createElement('canvas');
  canvas.id = 'drawing-canvas';
  canvas.style.cssText = `
    position: absolute;
    top: 0; left: 0;
    pointer-events: auto;
    z-index: 10;
    cursor: crosshair;
  `;

  const chartContainer = document.getElementById('main-chart');
  if (!chartContainer) return;
  chartContainer.style.position = 'relative';
  chartContainer.appendChild(canvas);

  // New: Monitoring mouse movement on the container to enable canvas when near objects
  chartContainer.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Si estamos sobre las escalas, desactivar canvas inmediatamente para que Lightweight Charts tome el control
      if (isMouseInScaleArea(x, y) && !drawingState.isDragging) {
          if (canvas.style.pointerEvents !== 'none') {
              canvas.style.pointerEvents = 'none';
              canvas.style.cursor = 'default';
          }
          return;
      }

      if (drawingState.isDragging || drawingState.mode === 'draw' || !!drawingState.activeObjId) {
          updateCanvasPointerEvents(e);
          return;
      }
      
      const hit = hitTest(x, y);
      const prev = drawingState.hoveredObjId;
      drawingState.hoveredObjId = hit ? hit.id : null;
      
      if (prev !== drawingState.hoveredObjId) {
          updateCanvasPointerEvents(e);
      }
  });

  const ro = new ResizeObserver(() => syncCanvasSize());
  ro.observe(chartContainer);
  syncCanvasSize();

  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseup', onCanvasMouseUp);
  canvas.addEventListener('dblclick', onCanvasDoubleClick);
  canvas.addEventListener('contextmenu', onCanvasRightClick);

  // Sync with chart scroll/zoom
  mainChart.timeScale().subscribeVisibleTimeRangeChange(() => {
    updateCanvasPointerEvents();
  });

  requestAnimationFrame(renderLoop);
  loadDrawings();
}

// ── Persistencia ──────────────────────────────────────────────────────────

function saveDrawings() {
  try {
    const instrument = typeof currentInstrument !== 'undefined' ? currentInstrument : 'UNKNOWN';
    const isBT = (typeof backtestState !== 'undefined' && backtestState.active);
    const key = `drawings_${instrument}${isBT ? '_bt' : ''}`;
    
    localStorage.setItem(key, JSON.stringify(drawingState.objects));
    updateObjectTree();

    // Guardamos en el servidor para persistencia real
    if (window.socket && window.socket.readyState === WebSocket.OPEN) {
      window.socket.send(JSON.stringify({
        type: 'save_drawings',
        instrument: instrument,
        drawings: drawingState.objects,
        is_backtest: isBT
      }));
    }
  } catch (e) { console.error("Error saving drawings:", e); }
}

function loadDrawings(retryCount = 0) {
  try {
    const instrument = typeof currentInstrument !== 'undefined' ? currentInstrument : 'UNKNOWN';
    const isBT = (typeof backtestState !== 'undefined' && backtestState.active);
    const key = `drawings_${instrument}${isBT ? '_bt' : ''}`;
    
    // 1. Carga rápida desde local
    const saved = localStorage.getItem(key);
    if (saved) {
      drawingState.objects = JSON.parse(saved);
      if (window.updateObjectTree) updateObjectTree();
    }

    // 2. Solicitar versión persistente al servidor
    if (window.socket && window.socket.readyState === WebSocket.OPEN) {
      window.socket.send(JSON.stringify({
        type: 'load_drawings',
        instrument: instrument,
        is_backtest: isBT
      }));
    }
    
    // 3. Retry mechanism: if chart is blank or data is loading, drawings might fail to anchor.
    // We force a reference update and if it failed, we retry or just force a render.
    updateCurrentRef();
    if (!currentRefCandle && retryCount < 3) {
       setTimeout(() => loadDrawings(retryCount + 1), 300);
    }
  } catch (e) {
    console.error("Error loading drawings:", e);
  }
}

window.handleDrawingsLoaded = function(data) {
  const normalizedData = (data.instrument || "").replace('/', '_');
  const normalizedCurrent = (currentInstrument || "").replace('/', '_');
    const isBT = !!(window.backtestState && window.backtestState.active);
    const targetIsBT = (data.is_backtest === true || data.is_backtest === 'true');
    const modeMatch = (targetIsBT === isBT);

  if (normalizedData === normalizedCurrent && modeMatch) {
    drawingState.objects = (data.drawings || []).map(obj => ({...obj, selected: false}));
    drawingState.activeObjId = null;
    if (window.updateObjectTree) window.updateObjectTree();
    console.log(`[Drawings] Cargados ${drawingState.objects.length} objetos para ${normalizedCurrent} (Deseleccionados)`);
  } else {
    console.warn(`[Drawings] Ignorando dibujos para ${data.instrument} (actual: ${currentInstrument}). ModeMatch: ${modeMatch} (TargetBT: ${data.is_backtest}, CurrentBT: ${isBT})`);
  }
};


// ── Object Tree Management ──────────────────────────────────────────────

function toggleObjectTree() {
  const sidebar = document.getElementById('object-tree-sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('open');
  if (sidebar.classList.contains('open')) {
    updateObjectTree();
  }
}

function updateObjectTree() {
  const list = document.getElementById('object-tree-list');
  if (!list) return;

  list.innerHTML = '';
  
  if (drawingState.objects.length === 0) {
    list.innerHTML = '<div style="padding: 20px; text-align: center; color: #787B86; font-size: 12px;">No hay objetos en este gráfico.</div>';
    return;
  }

  // Render reverse so newest is top
  drawingState.objects.slice().reverse().forEach(obj => {
    const item = document.createElement('div');
    item.className = `object-item ${obj.selected ? 'selected' : ''} ${!obj.visible ? 'hidden' : ''}`;
    
    // Label based on type
    const label = getToolLabel(obj.type);
    const icon = getToolIcon(obj.type);

    item.innerHTML = `
      <div class="object-icon">${icon}</div>
      <div class="object-label">${label}</div>
      <div class="object-actions">
        <button class="object-action-btn" onclick="toggleObjectVisibility('${obj.id}', event)" title="Mostrar/Ocultar">
          ${obj.visible ? '👁️' : '🕶️'}
        </button>
        <button class="object-action-btn" onclick="deleteObjectById('${obj.id}', event)" title="Eliminar">
          🗑️
        </button>
      </div>
    `;

    item.onclick = () => {
      drawingState.objects.forEach(o => o.selected = false);
      obj.selected = true;
      drawingState.activeObjId = obj.id;
      updateObjectTree();
    };

    list.appendChild(item);
  });
}

function getToolLabel(type) {
  const labels = {
    'trendline': 'Línea de tendencia',
    'hline': 'Línea horizontal',
    'vline': 'Línea vertical',
    'ray': 'Rayo',
    'rectangle': 'Rectángulo',
    'fibonacci': 'Retroceso Fibonacci',
    'measure': 'Regla de medida',
    'long_pos': 'Posición Larga',
    'short_pos': 'Posición Corta',
    'text': 'Texto',
    'arrow': 'Flecha',
    'triangle': 'Triángulo',
    'parallel': 'Canal paralelo',
    'price_range': 'Rango de precios'
  };
  return labels[type] || type;
}

function getToolIcon(type) {
  // Simple emoji/symbol representations as icons
  const icons = {
    'trendline': '╱',
    'hline': '⎯',
    'vline': '┆',
    'ray': '→',
    'rectangle': '□',
    'fibonacci': '≡',
    'measure': '📏',
    'long_pos': '📈',
    'short_pos': '📉',
    'text': 'T',
    'arrow': '↗',
    'triangle': 'Δ',
    'parallel': '‖',
    'price_range': '↕'
  };
  return icons[type] || '•';
}

function deleteObjectById(id, event) {
  if (event) event.stopPropagation();
  pushUndo();
  drawingState.objects = drawingState.objects.filter(o => o.id !== id);
  if (drawingState.activeObjId === id) drawingState.activeObjId = null;
  saveDrawings();
}

function toggleObjectVisibility(id, event) {
  if (event) event.stopPropagation();
  const obj = drawingState.objects.find(o => o.id === id);
  if (obj) {
    obj.visible = !obj.visible;
    saveDrawings();
  }
}

function clearAllDrawings() {
  showCustomConfirm(
    'Borrar todos los objetos', 
    '¿Estás seguro de que deseas eliminar todos los dibujos de este gráfico? Esta acción no se puede deshacer.',
    () => {
      drawingState.objects = [];
      drawingState.activeObjId = null;
      saveDrawings();
      if (window.updateObjectTree) window.updateObjectTree();
    }
  );
}

// ── Herramienta activa ─────────────────────────────────────────────────────

function setDrawingTool(tool) {
  drawingState.phase = 'idle';
  drawingState.points = [];
  drawingState.tool = tool;
  drawingState.mode = tool === 'cursor' ? 'select' : 'draw';

  // Deselect all when switching tools
  if (tool !== 'cursor') {
    drawingState.objects.forEach(o => o.selected = false);
    drawingState.activeObjId = null;
  }

  document.querySelectorAll('.draw-tool-btn').forEach(btn => btn.classList.remove('active'));
  const btn = document.getElementById('tool-' + tool);
  if (btn) btn.classList.add('active');

  updateCanvasPointerEvents();
  const canvas = document.getElementById('drawing-canvas');
  if (canvas) {
    canvas.style.cursor = tool === 'cursor' ? 'default'
      : tool === 'eraser' ? 'cell'
      : tool === 'text' ? 'text'
      : 'crosshair';
  }
  hidePropertiesPanel();
}

window.setDrawingTool = setDrawingTool;
window.clearAllDrawings = clearAllDrawings;

// Combined position button state
let _positionType = 'long_pos';
window.setPositionType = function(type) {
  _positionType = type;
  // Update combined button icon
  const icon = document.getElementById('pos-btn-icon');
  if (icon) {
    icon.innerHTML = type === 'long_pos'
      ? '<rect x="2" y="4" width="12" height="4" fill="rgba(38,166,154,0.3)" stroke="#26a69a" stroke-width="1.2" rx="1"/><rect x="2" y="8" width="12" height="4" fill="rgba(239,83,80,0.3)" stroke="#ef5350" stroke-width="1.2" rx="1"/><line x1="2" y1="8" x2="14" y2="8" stroke="#26a69a" stroke-width="1.8"/>'
      : '<rect x="2" y="4" width="12" height="4" fill="rgba(239,83,80,0.3)" stroke="#ef5350" stroke-width="1.2" rx="1"/><rect x="2" y="8" width="12" height="4" fill="rgba(38,166,154,0.3)" stroke="#26a69a" stroke-width="1.2" rx="1"/><line x1="2" y1="8" x2="14" y2="8" stroke="#ef5350" stroke-width="1.8"/>';
  }
  // Close submenu
  const grp = document.getElementById('pos-tool-group');
  if (grp) grp.classList.remove('open');
  setDrawingTool(type);
};
window.togglePositionMenu = function() {
  const grp = document.getElementById('pos-tool-group');
  if (grp) grp.classList.toggle('open');
};

// Close position submenu when clicking outside
document.addEventListener('click', function(e) {
  const grp = document.getElementById('pos-tool-group');
  if (grp && !grp.contains(e.target)) {
    grp.classList.remove('open');
  }
}, true);

// ── Chart zoom / fit helpers ─────────────────────────────────────────────
window.chartZoomIn = function() {

  if (typeof mainChart === 'undefined') return;
  const range = mainChart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  const center = (range.from + range.to) / 2;
  const half   = (range.to - range.from) / 2 * 0.65;
  mainChart.timeScale().setVisibleLogicalRange({ from: center - half, to: center + half });
};
window.chartZoomOut = function() {
  if (typeof mainChart === 'undefined') return;
  const range = mainChart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  const center = (range.from + range.to) / 2;
  const half   = (range.to - range.from) / 2 * 1.5;
  mainChart.timeScale().setVisibleLogicalRange({ from: center - half, to: center + half });
};
window.chartFitContent = function() {
  if (typeof mainChart === 'undefined') return;
  mainChart.timeScale().fitContent();
};

// ── Eventos del canvas ─────────────────────────────────────────────────────

function getCanvasCoords(e) {
  const canvas = document.getElementById('drawing-canvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

function onCanvasMouseDown(e) {
  if (e.button !== 0) return;
  updateCurrentRef();
  const { x, y } = getCanvasCoords(e);
  const pt = pixelToChart(x, y);

  if (drawingState.mode === 'select') {
    handleSelectMouseDown(x, y, pt);
  } else if (drawingState.mode === 'draw') {
    handleDrawMouseDown(x, y, pt);
  }
}

function onCanvasMouseMove(e) {
  updateCurrentRef();
  const { x, y } = getCanvasCoords(e);
  drawingState.mouseX = x;
  drawingState.mouseY = y;

  if (drawingState.mode === 'select') {
    // Check for hits while moving to handle highlight and cursor changes
    const hit = hitTest(x, y);
    const prevHovered = drawingState.hoveredObjId;
    drawingState.hoveredObjId = hit ? hit.id : null;
    
    if (prevHovered !== drawingState.hoveredObjId) {
      updateCanvasPointerEvents(e);
    }
    
    handleSelectMouseMove(x, y);
  }

  // Si entramos en zona de escala mientras movemos, soltar el control (si no estamos arrastrando)
  if (isMouseInScaleArea(x, y) && !drawingState.isDragging) {
      updateCanvasPointerEvents(e);
  }
}

function onCanvasMouseUp(e) {
  if (e.button !== 0) return;
  const { x, y } = getCanvasCoords(e);

  if (drawingState.isDragging) {
    drawingState.isDragging = false;
    drawingState.dragOffset = null;
    drawingState.dragHandleIndex = null;
    saveDrawings();
  }

  // Drag-to-draw tools: mouseup finalizes (currently none, all are click-to-click)
  const dragTools = [];
  if (drawingState.mode === 'draw' && dragTools.includes(drawingState.tool) && drawingState.phase === 'first_point') {
    const pt = pixelToChart(x, y);
    if ((pt.time !== null || pt.logical !== null) && pt.price != null && drawingState.points.length > 0) {
      completeObject([drawingState.points[0], pt]);
    }
  }
}

function onCanvasDoubleClick(e) {
  // no-op for now; text tool uses single click
}

function onCanvasRightClick(e) {
  e.preventDefault();
  // Cancelar dibujo en curso
  if (drawingState.phase !== 'idle') {
    drawingState.phase = 'idle';
    drawingState.points = [];
  }
  setDrawingTool('cursor');
}

// ── Lógica de selección ────────────────────────────────────────────────────

function handleSelectMouseDown(x, y, pt) {
  // 1. Check if clicking a handle of ANY (visible) object first
  for (let i = drawingState.objects.length - 1; i >= 0; i--) {
    const obj = drawingState.objects[i];
    if (!obj.visible || obj.locked) continue;
    const pixels = obj.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
    const handleIdx = getHandleIndex(x, y, pixels, obj);
    if (handleIdx !== -1) {
      drawingState.objects.forEach(o => o.selected = false);
      obj.selected = true;
      drawingState.activeObjId = obj.id;
      drawingState.isDragging = true;
      drawingState.dragHandleIndex = handleIdx;
      showPropertiesPanel(obj, x, y);
      return;
    }
  }

  // 2. Hit test for object body
  const hit = hitTest(x, y);
  if (hit) {
    drawingState.objects.forEach(o => o.selected = false);
    hit.selected = true;
    drawingState.activeObjId = hit.id;
    drawingState.isDragging = true;
    drawingState.dragHandleIndex = null;
    const pixels = hit.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
    drawingState.dragOffset = { dx: x - (pixels[0]?.x || 0), dy: y - (pixels[0]?.y || 0) };
    showPropertiesPanel(hit, x, y);
    if (hit.type === 'long_pos' || hit.type === 'short_pos') {
      if (typeof syncBacktestWithDrawing === 'function') syncBacktestWithDrawing(hit);
    }
  } else {
    drawingState.objects.forEach(o => o.selected = false);
    drawingState.activeObjId = null;
    hidePropertiesPanel();
    updateCanvasPointerEvents();
  }
}

function handleSelectMouseMove(x, y) {
  if (drawingState.isDragging && drawingState.activeObjId) {
    const obj = drawingState.objects.find(o => o.id === drawingState.activeObjId);
    if (!obj) return;

    if (drawingState.dragHandleIndex !== null) {
      // Resize: move only the dragged point
      const pt = pixelToChart(x, y);
      if ((pt.time !== null || pt.logical !== null) && pt.price != null) {
        const isPos = (obj.type === 'long_pos' || obj.type === 'short_pos');
        const hi = drawingState.dragHandleIndex;
        
        if (isPos) {
          if (hi === 0) {
            // Dragging Entry handle: Move entire position vertically
            const dy = pt.price - obj.points[0].price;
            obj.points = obj.points.map(p => ({ ...p, price: p.price + dy }));
          } else if (hi === 1) {
            // Dragging TP handle: Move TP price and Width (time)
            obj.points[1].time = pt.time;
            obj.points[1].logical = pt.logical;
            obj.points[1].offsetSeconds = pt.offsetSeconds;
            obj.points[1].price = pt.price;
          } else if (hi === 2) {
            // Dragging SL handle: Only move SL price
            obj.points[2].price = pt.price;
          }
          // Always keep Entry and SL points horizontally aligned
          if (obj.points[2]) {
            obj.points[2].time = obj.points[0].time;
            obj.points[2].logical = obj.points[0].logical;
          }
        } else if (obj.type === 'rectangle') {
            // Rectangle corner logic (0:p1, 1:Virtual p2.t/p1.p, 2:Virtual p1.t/p2.p, 3:p2)
            if (hi === 0) { // Top-Left-ish (Original p1)
              obj.points[0] = { time: pt.time, price: pt.price, logical: pt.logical, offsetSeconds: pt.offsetSeconds };
            } else if (hi === 1) { // Top-Right-ish
              obj.points[0].price = pt.price;
              obj.points[1].time = pt.time;
              obj.points[1].logical = pt.logical;
              obj.points[1].offsetSeconds = pt.offsetSeconds;
            } else if (hi === 2) { // Bottom-Left-ish
              obj.points[0].time = pt.time;
              obj.points[0].logical = pt.logical;
              obj.points[0].offsetSeconds = pt.offsetSeconds;
              obj.points[1].price = pt.price;
            } else if (hi === 3) { // Bottom-Right-ish (Original p2)
              obj.points[1] = { time: pt.time, price: pt.price, logical: pt.logical, offsetSeconds: pt.offsetSeconds };
            }
        } else {
          // Standard tool behavior (trendline, etc)
          if (obj.points[hi]) {
            obj.points[hi] = { time: pt.time, price: pt.price, logical: pt.logical, offsetSeconds: pt.offsetSeconds };
          }
        }
      }
    } else {
      // Move entire object
      const pixels = obj.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
      const refPx = pixels[0];
      if (!refPx || refPx.x == null) return;
      const newRefX = x - (drawingState.dragOffset?.dx || 0);
      const newRefY = y - (drawingState.dragOffset?.dy || 0);
      const dxPx = newRefX - refPx.x;
      const dyPx = newRefY - refPx.y;

      obj.points = obj.points.map((p, i) => {
        const px = pixels[i];
        if (!px || px.x == null) return p;
        const np = pixelToChart(px.x + dxPx, px.y + dyPx);
        return (np.time !== null || np.logical !== null) && np.price != null ? { time: np.time, price: np.price, logical: np.logical, offsetSeconds: np.offsetSeconds } : p;
      });

      // Maintain internal consistency for positions
      const isPosMove = (obj.type === 'long_pos' || obj.type === 'short_pos');
      if (isPosMove && obj.points[2] && obj.points[0]) {
        obj.points[2].time = obj.points[0].time;
        obj.points[2].logical = obj.points[0].logical;
      }
    }
    if (obj.type === 'long_pos' || obj.type === 'short_pos') {
      if (typeof syncBacktestWithDrawing === 'function') syncBacktestWithDrawing(obj);
    }
    return;
  }

  // Hover detection
  const hit = hitTest(x, y);
  const prevHovered = drawingState.hoveredObjId;
  drawingState.hoveredObjId = hit ? hit.id : null;

  const canvas = document.getElementById('drawing-canvas');
  if (canvas) {
    let cursor = 'default';
    if (hit) {
      // Check if hovering a handle on the active/hovered object
      const pixels = hit.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
      const hi = getHandleIndex(x, y, pixels, hit);
      const isPos = (hit.type === 'long_pos' || hit.type === 'short_pos');
        if (hi !== -1) {
          if (isPos) {
            cursor = hi !== 1 ? 'ns-resize' : 'nesw-resize';
          } else if (hit.type === 'rectangle') {
            cursor = (hi === 0 || hi === 3) ? 'nwse-resize' : 'nesw-resize';
          } else {
            cursor = 'move';
          }
        } else {
          cursor = 'move';
        }
    }
    canvas.style.cursor = cursor;
  }

  if (prevHovered !== drawingState.hoveredObjId) {
    updateCanvasPointerEvents();
  }
}

// ── Lógica de dibujo ──────────────────────────────────────────────────────

function handleDrawMouseDown(x, y, pt) {
  // Relaxed validation: Allow creating objects even if only price/logical are available
  if (!pt || pt.price == null || (pt.time === null && pt.logical === null)) return;

  const tool = drawingState.tool;

  if (tool === 'eraser') {
    const hit = hitTest(x, y);
    if (hit) {
      pushUndo();
      drawingState.objects = drawingState.objects.filter(o => o.id !== hit.id);
      if (drawingState.activeObjId === hit.id) drawingState.activeObjId = null;
      saveDrawings();
    }
    return;
  }

  if (tool === 'text') {
    showInlineTextInput(x, y, pt);
    return;
  }

  if (tool === 'hline') {
    pushUndo();
    completeObject([pt]);
    return;
  }

  if (tool === 'vline') {
    pushUndo();
    completeObject([pt]);
    return;
  }

  // 2-point tools (trendline family + new arrow & date/price range)
  if (tool === 'trendline' || tool === 'ray' || tool === 'measure' || tool === 'fibonacci' ||
      tool === 'arrow' || tool === 'date_range' || tool === 'price_range') {
    if (drawingState.phase === 'idle') {
      drawingState.points = [pt];
      drawingState.phase = 'first_point';
    } else if (drawingState.phase === 'first_point') {
      pushUndo();
      completeObject([drawingState.points[0], pt]);
    }
    return;
  }

  // 2-click tools (rectangle and positions are now click-click)
  if (tool === 'rectangle' || tool === 'long_pos' || tool === 'short_pos') {
    if (drawingState.phase === 'idle') {
      drawingState.points = [pt];
      drawingState.phase = 'first_point';
    } else if (drawingState.phase === 'first_point') {
      pushUndo();
      completeObject([drawingState.points[0], pt]);
    }
    return;
  }

  if (tool === 'parallel') {
    if (drawingState.phase === 'idle') {
      drawingState.points = [pt];
      drawingState.phase = 'first_point';
    } else if (drawingState.phase === 'first_point') {
      drawingState.points.push(pt);
      drawingState.phase = 'second_point';
    } else if (drawingState.phase === 'second_point') {
      pushUndo();
      completeObject([drawingState.points[0], drawingState.points[1], pt]);
    }
    return;
  }

  // 3-click tool
  if (tool === 'triangle') {
    if (drawingState.phase === 'idle') {
      drawingState.points = [pt];
      drawingState.phase = 'first_point';
    } else if (drawingState.phase === 'first_point') {
      drawingState.points.push(pt);
      drawingState.phase = 'second_point';
    } else if (drawingState.phase === 'second_point') {
      pushUndo();
      completeObject([drawingState.points[0], drawingState.points[1], pt]);
    }
    return;
  }
}

function completeObject(points) {
  const obj = {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + Math.random()).toString(36),
    type: drawingState.tool,
    points: points.map(p => ({ 
      time: p.time, 
      price: p.price, 
      logical: p.logical,
      offsetSeconds: p.offsetSeconds || 0
    })),
    settings: { ...drawingState.settings },
    visible: true,
    locked: false,
    selected: false,
    text: ''
  };

  // For position tools: fix TP direction and add auto-computed SL as 3rd point
  if (obj.type === 'long_pos' || obj.type === 'short_pos') {
    const entry = obj.points[0].price;
    const dist  = Math.max(Math.abs(obj.points[1].price - entry), 0.00001);
    if (obj.type === 'long_pos') {
      obj.points[1].price = entry + dist;                              // TP always above
      obj.points.push({ time: obj.points[0].time, price: entry - dist, logical: obj.points[0].logical }); // SL below
    } else {
      obj.points[1].price = entry - dist;                              // TP always below
      obj.points.push({ time: obj.points[0].time, price: entry + dist, logical: obj.points[0].logical }); // SL above
    }
  }

  drawingState.objects.push(obj);
  drawingState.phase = 'idle';
  drawingState.points = [];
  saveDrawings();

  // Position tools: auto-select & switch to cursor so user can immediately resize
  if (obj.type === 'long_pos' || obj.type === 'short_pos') {
    setTimeout(() => {
      drawingState.objects.forEach(o => { o.selected = false; });
      obj.selected = true;
      drawingState.activeObjId = obj.id;
      setDrawingTool('cursor');
      // Sincronizar inmediatamente con el panel de backtest
      if (typeof syncBacktestWithDrawing === 'function') syncBacktestWithDrawing(obj);
    }, 20);
  }
}

// ── Inline text input ─────────────────────────────────────────────────────

function showInlineTextInput(x, y, pt) {
  let inp = document.getElementById('drawing-text-input');
  if (inp) inp.remove();

  const canvas = document.getElementById('drawing-canvas');
  if (!canvas) return;

  inp = document.createElement('input');
  inp.id = 'drawing-text-input';
  inp.type = 'text';
  inp.placeholder = 'Type text, Enter to confirm';
  inp.style.cssText = `
    position: absolute;
    left: ${x}px;
    top: ${y - 14}px;
    z-index: 20;
    background: #1e222d;
    border: 1px solid #2196F3;
    color: #D9D9D9;
    font-size: 13px;
    padding: 2px 6px;
    border-radius: 3px;
    outline: none;
    min-width: 120px;
  `;

  const container = document.getElementById('main-chart');
  container.appendChild(inp);
  inp.focus();

  function finish() {
    const txt = inp.value.trim();
    inp.remove();
    if (txt) {
      pushUndo();
      const obj = {
        id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + Math.random()).toString(36),
        type: 'text',
        points: [{ time: pt.time, price: pt.price }],
        settings: { ...drawingState.settings },
        text: txt,
        visible: true,
        locked: false,
        selected: false
      };
      drawingState.objects.push(obj);
      saveDrawings();
    }
    drawingState.phase = 'idle';
    drawingState.points = [];
  }

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') { inp.remove(); drawingState.phase = 'idle'; drawingState.points = []; }
  });
  inp.addEventListener('blur', finish);
}

// ── Hit testing ───────────────────────────────────────────────────────────

function hitTest(x, y) {
  for (let i = drawingState.objects.length - 1; i >= 0; i--) {
    const obj = drawingState.objects[i];
    if (!obj.visible || obj.locked) continue;
    const pixels = obj.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
    if (isPointNearObject(x, y, obj, pixels)) return obj;
  }
  return null;
}

function getHandleIndex(x, y, pixels, obj = null) {
  const HANDLE_R = 12;
  
  if (obj && obj.type === 'rectangle' && pixels.length >= 2) {
    const p1 = pixels[0], p2 = pixels[1];
    if (p1 && p2 && p1.x != null && p2.x != null) {
      // 4 points for rectangle: (0:TL, 1:TR, 2:BL, 3:BR) - relative to min/max
      const corners = [
        { x: p1.x, y: p1.y }, // 0: Original p1
        { x: p2.x, y: p1.y }, // 1: Virtual TR (if p2 > p1)
        { x: p1.x, y: p2.y }, // 2: Virtual BL
        { x: p2.x, y: p2.y }  // 3: Original p2
      ];
      for (let i = 0; i < corners.length; i++) {
        if (Math.hypot(x - corners[i].x, y - corners[i].y) < HANDLE_R) return i;
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (p && p.x != null && Math.hypot(x - p.x, y - p.y) < HANDLE_R) return i;
  }
  return -1;
}

function isPointNearObject(x, y, obj, pixels) {
  const T = 12; // Increased tolerance for better cursor UX
  switch (obj.type) {
    case 'hline': {
      const p = pixels[0];
      return p && p.y != null && Math.abs(y - p.y) < T;
    }
    case 'vline': {
      const p = pixels[0];
      return p && p.x != null && Math.abs(x - p.x) < T;
    }
    case 'arrow':
    case 'ray':
    case 'trendline':
    case 'measure': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) return false;
      return distanceToSegment(x, y, p1, p2) < T;
    }
    case 'fibonacci': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.y == null || p2.y == null) return false;
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
      return levels.some(ratio => {
        const py = candleSeries.priceToCoordinate(obj.points[0].price + (obj.points[1].price - obj.points[0].price) * ratio);
        return py != null && Math.abs(y - py) < T;
      });
    }
    case 'date_range': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null) return false;
      return Math.abs(x - p1.x) < T || Math.abs(x - p2.x) < T ||
             (x >= Math.min(p1.x, p2.x) && x <= Math.max(p1.x, p2.x) && Math.abs(y - p1.y) < T);
    }
    case 'price_range': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.y == null) return false;
      return Math.abs(y - p1.y) < T || Math.abs(y - p2.y) < T;
    }
    case 'long_pos':
    case 'short_pos': {
      // Full bounding box includes the SL zone (points[2]), not just points[0]-points[1]
      const p1h = pixels[0], p2h = pixels[1];
      if (!p1h || !p2h || p1h.x == null || p2h.x == null) return false;
      const entryPH = obj.points[0].price;
      const tpPH    = obj.points[1].price;
      const slPH    = obj.points[2]?.price ?? (entryPH - (tpPH - entryPH));
      const topPriceH = Math.max(tpPH, slPH, entryPH);
      const botPriceH = Math.min(tpPH, slPH, entryPH);
      const topYH = candleSeries.priceToCoordinate(topPriceH);
      const botYH = candleSeries.priceToCoordinate(botPriceH);
      if (topYH == null || botYH == null) return false;
      const minX = Math.min(p1h.x, p2h.x) - T;
      const maxX = Math.max(p1h.x, p2h.x) + T;
      return x >= minX && x <= maxX && y >= topYH - T && y <= botYH + T;
    }
    case 'rectangle': {
      const p1r = pixels[0], p2r = pixels[1];
      if (!p1r || !p2r || p1r.x == null || p2r.x == null) return false;
      const minXr = Math.min(p1r.x, p2r.x) - T, maxXr = Math.max(p1r.x, p2r.x) + T;
      const minYr = Math.min(p1r.y, p2r.y) - T, maxYr = Math.max(p1r.y, p2r.y) + T;
      return x >= minXr && x <= maxXr && y >= minYr && y <= maxYr;
    }
    case 'triangle': {
      const p1 = pixels[0], p2 = pixels[1], p3 = pixels[2];
      if (!p1 || !p2 || !p3) return false;
      return distanceToSegment(x, y, p1, p2) < T ||
             distanceToSegment(x, y, p2, p3) < T ||
             distanceToSegment(x, y, p3, p1) < T;
    }
    case 'parallel': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) return false;
      if (distanceToSegment(x, y, p1, p2) < T) return true;
      if (pixels[2] && pixels[2].x != null) {
        const p3 = pixels[2];
        const dy = p3.y - interpolateY(p3.x, p1, p2);
        const p1s = { x: p1.x, y: p1.y + dy };
        const p2s = { x: p2.x, y: p2.y + dy };
        return distanceToSegment(x, y, p1s, p2s) < T;
      }
      return false;
    }
    case 'text': {
      const p = pixels[0];
      if (!p || p.x == null) return false;
      const ctx = document.getElementById('drawing-canvas')?.getContext('2d');
      const fontSize = obj.settings.fontSize || 13;
      if (!ctx) return Math.hypot(x - p.x, y - p.y) < 30;
      ctx.font = `${fontSize}px sans-serif`;
      const tw = ctx.measureText(obj.text || '').width;
      // Define a slightly larger box for easier grabbing
      return x >= p.x - T && x <= p.x + tw + T && y >= p.y - fontSize - T && y <= p.y + T;
    }
    default:
      return false;
  }
}

function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function interpolateY(x, p1, p2) {
  if (p2.x === p1.x) return p1.y;
  return p1.y + (p2.y - p1.y) * (x - p1.x) / (p2.x - p1.x);
}

// ── Undo ──────────────────────────────────────────────────────────────────

function pushUndo() {
  drawingState.undoStack.push(JSON.stringify(drawingState.objects));
  if (drawingState.undoStack.length > 50) drawingState.undoStack.shift();
}

function undoDrawing() {
  if (drawingState.undoStack.length === 0) return;
  drawingState.objects = JSON.parse(drawingState.undoStack.pop());
  drawingState.activeObjId = null;
  saveDrawings();
}

// ── Render loop ───────────────────────────────────────────────────────────

function renderLoop() {
  try {
    const canvas = document.getElementById('drawing-canvas');
    if (!canvas) { requestAnimationFrame(renderLoop); return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { requestAnimationFrame(renderLoop); return; }
    
    updateCurrentRef();
    
    // Ensure canvas dimensions match the container perfectly
    const mainEl = document.getElementById('main-chart');
    if (mainEl) {
        const rect = mainEl.getBoundingClientRect();
        if (canvas.width !== rect.width || canvas.height !== rect.height) {
            canvas.width = rect.width;
            canvas.height = rect.height;
        }
    }
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const PRICE_SCALE_WIDTH = 60;
    const TIME_SCALE_HEIGHT = 26;
    const chartWidth = canvas.width - PRICE_SCALE_WIDTH;
    const chartHeight = canvas.height - TIME_SCALE_HEIGHT;

    // 1. Render Objects with clipping (so they don't overlap scales)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, chartWidth, chartHeight);
    ctx.clip();

    if (drawingState.objects && Array.isArray(drawingState.objects)) {
      for (const obj of drawingState.objects) {
        try {
          if (obj && obj.visible) {
            renderObject(ctx, obj, chartWidth);
          }
        } catch (e) {
          if (!obj._lastRenderError) {
              console.error("Error rendering object:", obj.id, obj.type, e);
              obj._lastRenderError = true;
          }
        }
      }
    }
    
    // Preview inside clipping
    try {
      if (drawingState.mode === 'draw' && drawingState.phase !== 'idle' && drawingState.points && drawingState.points.length > 0) {
        renderPreview(ctx, chartWidth);
      }
    } catch (e) {
      console.error("Error rendering preview:", e);
    }
    
    ctx.restore();

    // 2. Render Current Price Label (Outside clipping, always on top of the scale)
    try {
      renderCurrentPriceLabel(ctx);
    } catch (e) {
      console.error("Error rendering current price label:", e);
    }
  } catch (e) {
    console.error("Global render loop error:", e);
  }

  requestAnimationFrame(renderLoop);
}

// Mimics TradingView current price label on the axis
function renderCurrentPriceLabel(ctx) {
    if (window.backtestActive || (window.backtestState && window.backtestState.active)) return;
    if (typeof candleData === 'undefined' || candleData.length === 0) return;
    
    const lastCandle = candleData[candleData.length - 1];
    const price = lastCandle.close;
    const y = candleSeries.priceToCoordinate(price);
    if (y === null || y < 0 || y > ctx.canvas.height) return;

    const isUp = lastCandle.close >= lastCandle.open;
    const color = isUp ? '#26a69a' : '#ef5350';
    const canvas = ctx.canvas;
    const scaleWidth = 75; 

    ctx.save();
    
    // 1. Draw horizontal dashed line across chart area
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width - scaleWidth, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Prepare the expandable block
    const countdown = window.currentCountdown || "";
    const showCountdown = countdown !== "";
    const ph = showCountdown ? 32 : 18; 
    const lx = canvas.width - scaleWidth;
    const ly = y - ph / 2;

    // Background Block (Full Width)
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, scaleWidth, ph);

    // Text Rendering
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    
    let precision = 5;
    if (price > 100) precision = 2;
    else if (price > 10) precision = 3;
    const priceLabel = price.toFixed(precision);

    if (showCountdown) {
        ctx.font = 'bold 12px sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(priceLabel, lx + scaleWidth/2, y + 1);
        
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(countdown, lx + scaleWidth/2, y + 3);
    } else {
        ctx.font = 'bold 12px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(priceLabel, lx + scaleWidth/2, y);
    }
    
    ctx.restore();
}

function applyLineStyle(ctx, style, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (style === 'dashed') ctx.setLineDash([6, 4]);
  else if (style === 'dotted') ctx.setLineDash([2, 3]);
  else ctx.setLineDash([]);
}

function renderObject(ctx, obj, chartWidth) {
  const s = obj.settings;
  const pixels = obj.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
  const canvas = ctx.canvas;
  const actualWidth = chartWidth || canvas.width;

  ctx.save();
  applyLineStyle(ctx, s.lineStyle, s.lineWidth, s.color);

  switch (obj.type) {

    case 'hline': {
      const p = pixels[0];
      if (!p || p.y == null) break;
      ctx.beginPath();
      ctx.moveTo(0, p.y);
      ctx.lineTo(actualWidth, p.y);
      ctx.stroke();
      if (obj.selected) drawHandle(ctx, actualWidth / 2, p.y, s.color);
      break;
    }

    case 'vline': {
      const p = pixels[0];
      if (!p || p.x == null) break;
      ctx.beginPath();
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, canvas.height);
      ctx.stroke();
      if (obj.selected) drawHandle(ctx, p.x, canvas.height / 2, s.color);
      break;
    }

    case 'trendline': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      const [ep1, ep2] = extendLine(p1, p2, actualWidth, canvas.height, s.extendLeft, s.extendRight);
      ctx.beginPath();
      ctx.moveTo(ep1.x, ep1.y);
      ctx.lineTo(ep2.x, ep2.y);
      ctx.stroke();
      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
      }
      break;
    }

    case 'ray': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      const ext = extendRay(p1, p2, actualWidth);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(ext.x, ext.y);
      ctx.stroke();
      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
      }
      break;
    }

    case 'rectangle': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      const rx = Math.min(p1.x, p2.x), ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x), rh = Math.abs(p2.y - p1.y);
      ctx.fillStyle = s.fillColor;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p1.y, s.color);
        drawHandle(ctx, p1.x, p2.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
      }
      break;
    }

    case 'fibonacci': {
      const pt1 = obj.points[0], pt2 = obj.points[1];
      if (!pt1 || !pt2) break;
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
      const colors = ['#ef5350', '#ff9800', '#ffeb3b', '#4caf50', '#2196F3', '#9c27b0', '#ef5350'];
      const fillLevels = [[0.382, 0.618]];

      // Shaded area between 38.2% and 61.8%
      const yA = candleSeries.priceToCoordinate(pt1.price + (pt2.price - pt1.price) * 0.382);
      const yB = candleSeries.priceToCoordinate(pt1.price + (pt2.price - pt1.price) * 0.618);
      if (yA != null && yB != null) {
        ctx.fillStyle = 'rgba(33,150,243,0.07)';
        ctx.fillRect(0, Math.min(yA, yB), actualWidth, Math.abs(yB - yA));
      }

      levels.forEach((ratio, idx) => {
        const priceLevel = pt1.price + (pt2.price - pt1.price) * ratio;
        const fy = candleSeries.priceToCoordinate(priceLevel);
        if (fy == null) return;
        ctx.setLineDash(ratio === 0 || ratio === 1 ? [] : [4, 3]);
        ctx.strokeStyle = colors[idx] || s.color;
        ctx.lineWidth = ratio === 0 || ratio === 1 ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(0, fy);
        ctx.lineTo(actualWidth, fy);
        ctx.stroke();
        if (s.showLabels) {
          ctx.setLineDash([]);
          ctx.font = '10px sans-serif';
          ctx.fillStyle = colors[idx] || s.color;
          const pct = (ratio * 100).toFixed(1);
          ctx.fillText(`${pct}% — ${priceLevel.toFixed(5)}`, 4, fy - 3);
        }
      });

      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
      }
      break;
    }

    case 'parallel': {
      const p1 = pixels[0], p2 = pixels[1], p3 = pixels[2];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      if (p3 && p3.x != null) {
        const dy = p3.y - interpolateY(p3.x, p1, p2);
        const p1s = { x: p1.x, y: p1.y + dy };
        const p2s = { x: p2.x, y: p2.y + dy };
        ctx.beginPath();
        ctx.moveTo(p1s.x, p1s.y);
        ctx.lineTo(p2s.x, p2s.y);
        ctx.stroke();
        // Fill area
        ctx.fillStyle = s.fillColor;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p2s.x, p2s.y);
        ctx.lineTo(p1s.x, p1s.y);
        ctx.closePath();
        ctx.fill();
      }
      if (obj.selected) {
        pixels.forEach(p => { if (p && p.x != null) drawHandle(ctx, p.x, p.y, s.color); });
      }
      break;
    }

    case 'text': {
      const p = pixels[0];
      if (!p || p.x == null) break;
      const fontSize = s.fontSize || 13;
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillStyle = s.color;
      ctx.fillText(obj.text || '', p.x, p.y);
      if (obj.selected) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        const tw = ctx.measureText(obj.text || '').width;
        ctx.strokeRect(p.x - 2, p.y - fontSize, tw + 4, fontSize + 4);
      }
      break;
    }

    case 'measure': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      // tick marks
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI / 2;
      [p1, p2].forEach(p => {
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(angle) * 6, p.y + Math.sin(angle) * 6);
        ctx.lineTo(p.x - Math.cos(angle) * 6, p.y - Math.sin(angle) * 6);
        ctx.stroke();
      });
      const pt1 = obj.points[0], pt2 = obj.points[1];
      const pips = Math.abs(pt2.price - pt1.price) * 10000;
      const pct = Math.abs((pt2.price - pt1.price) / pt1.price * 100);
      const label = `${pips.toFixed(1)} pips | ${pct.toFixed(2)}%`;
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      ctx.setLineDash([]);
      ctx.font = '11px sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(19,23,34,0.85)';
      ctx.fillRect(mx - tw / 2 - 5, my - 10, tw + 10, 18);
      ctx.fillStyle = s.color;
      ctx.fillText(label, mx - tw / 2, my + 3);
      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
      }
      break;
    }
    case 'arrow': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      // Arrowhead
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const aLen = 12 + s.lineWidth * 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - aLen * Math.cos(angle - 0.45), p2.y - aLen * Math.sin(angle - 0.45));
      ctx.lineTo(p2.x - aLen * Math.cos(angle + 0.45), p2.y - aLen * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
      }
      break;
    }

    case 'triangle': {
      const p1 = pixels[0], p2 = pixels[1], p3 = pixels[2];
      if (!p1 || !p2 || !p3 || p1.x == null) break;
      ctx.fillStyle = s.fillColor;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (obj.selected) {
        drawHandle(ctx, p1.x, p1.y, s.color);
        drawHandle(ctx, p2.x, p2.y, s.color);
        drawHandle(ctx, p3.x, p3.y, s.color);
      }
      break;
    }

    case 'long_pos': {
      if (!obj.points[0] || !obj.points[1]) break;
      const entryPL = obj.points[0].price, tpPL = obj.points[1].price, slPL = obj.points[2]?.price ?? (entryPL - (tpPL - entryPL));
      const entryYl = candleSeries.priceToCoordinate(entryPL), tpYl = candleSeries.priceToCoordinate(tpPL), slYl = candleSeries.priceToCoordinate(slPL);
      if (entryYl == null || tpYl == null || slYl == null) break;
      const x0 = Math.min(pixels[0].x, pixels[1].x), x1 = Math.max(pixels[0].x, pixels[1].x), wV = x1 - x0;
      if (wV < 2) break;

      ctx.setLineDash([]);
      ctx.fillStyle = hexToRgba('#26a69a', 0.18);
      ctx.fillRect(x0, tpYl, wV, entryYl - tpYl);
      ctx.strokeStyle = '#26a69a99';
      ctx.strokeRect(x0, tpYl, wV, entryYl - tpYl);

      ctx.fillStyle = hexToRgba('#ef5350', 0.18);
      ctx.fillRect(x0, entryYl, wV, slYl - entryYl);
      ctx.strokeStyle = '#ef535099';
      ctx.strokeRect(x0, entryYl, wV, slYl - entryYl);

      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = s.color || 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(x0, entryYl); ctx.lineTo(x1, entryYl); ctx.stroke();
      ctx.setLineDash([]);

      if (obj.selected) {
        const tpPips = Math.abs(tpPL-entryPL)*10000, tpPct = Math.abs((tpPL-entryPL)/entryPL*100);
        drawPosLabel(ctx, x1-4, tpYl, `TP: ${tpPL.toFixed(5)} (+${tpPips.toFixed(0)}p, ${tpPct.toFixed(3)}%)`, '#26a69a');
        const slPips = Math.abs(entryPL-slPL)*10000, slPct = Math.abs((entryPL-slPL)/entryPL*100);
        drawPosLabel(ctx, x1-4, slYl, `SL: ${slPL.toFixed(5)} (-${slPips.toFixed(0)}p, ${slPct.toFixed(3)}%)`, '#ef5350');
        drawPosLabel(ctx, x1-4, entryYl, `LONG Apertura: ${entryPL.toFixed(5)}`, s.color || '#2196F3');
      }
      if (obj.selected) {
        drawSquareHandle(ctx, x0, entryYl); drawSquareHandle(ctx, x1, tpYl); drawSquareHandle(ctx, x0, slYl);
      }
      break;
    }

    case 'short_pos': {
      if (!obj.points[0] || !obj.points[1]) break;
      const entryPS = obj.points[0].price, tpPS = obj.points[1].price, slPS = obj.points[2]?.price ?? (entryPS + (entryPS-tpPS));
      const entryYs = candleSeries.priceToCoordinate(entryPS), tpYs = candleSeries.priceToCoordinate(tpPS), slYs = candleSeries.priceToCoordinate(slPS);
      if (entryYs == null || tpYs == null || slYs == null) break;
      const x0 = Math.min(pixels[0].x, pixels[1].x), x1 = Math.max(pixels[0].x, pixels[1].x), wV = x1 - x0;
      if (wV < 2) break;

      ctx.setLineDash([]);
      // SL zone (red, ABOVE entry for short)
      ctx.fillStyle = hexToRgba('#ef5350', 0.18);
      ctx.fillRect(x0, slYs, wV, entryYs - slYs);
      ctx.strokeStyle = '#ef535099';
      ctx.strokeRect(x0, slYs, wV, entryYs - slYs);

      // TP zone (green, BELOW entry for short)
      ctx.fillStyle = hexToRgba('#26a69a', 0.18);
      ctx.fillRect(x0, entryYs, wV, tpYs - entryYs);
      ctx.strokeStyle = '#26a69a99';
      ctx.strokeRect(x0, entryYs, wV, tpYs - entryYs);

      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = s.color || 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(x0, entryYs); ctx.lineTo(x1, entryYs); ctx.stroke();
      ctx.setLineDash([]);

      if (obj.selected) {
        const tpPips = Math.abs(entryPS-tpPS)*10000, tpPct = Math.abs((entryPS-tpPS)/entryPS*100);
        drawPosLabel(ctx, x1-4, tpYs, `OBJ (TP): ${tpPS.toFixed(5)} (+${tpPips.toFixed(0)}p, ${tpPct.toFixed(3)}%)`, '#26a69a');
        const slPips = Math.abs(slPS-entryPS)*10000, slPct = Math.abs((slPS-entryPS)/entryPS*100);
        drawPosLabel(ctx, x1-4, slYs, `STOP (SL): ${slPS.toFixed(5)} (-${slPips.toFixed(0)}p, ${slPct.toFixed(3)}%)`, '#ef5350');
        drawPosLabel(ctx, x1-4, entryYs, `SHORT Apertura: ${entryPS.toFixed(5)}`, s.color || '#2196F3');
      }
      if (obj.selected) {
        drawSquareHandle(ctx, x0, entryYs); drawSquareHandle(ctx, x1, tpYs); drawSquareHandle(ctx, x0, slYs);
      }
      break;
    }

    case 'date_range': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.x == null || p2.x == null) break;
      const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
      ctx.fillStyle = 'rgba(33,150,243,0.08)';
      ctx.fillRect(x1, 0, x2 - x1, canvas.height);
      ctx.setLineDash([4, 3]);
      [x1, x2].forEach(xv => {
        ctx.beginPath();
        ctx.moveTo(xv, 0);
        ctx.lineTo(xv, canvas.height);
        ctx.stroke();
      });
      // Label: number of bars (approx)
      const pt1d = obj.points[0], pt2d = obj.points[1];
      if (pt1d && pt2d) {
        const barsDiff = Math.abs(pt2d.time - pt1d.time);
        ctx.setLineDash([]);
        ctx.font = '10px sans-serif';
        ctx.fillStyle = s.color;
        ctx.fillText(`${barsDiff}s`, (x1 + x2) / 2 - 12, 14);
      }
      if (obj.selected) {
        drawHandle(ctx, p1.x, canvas.height / 2, s.color);
        drawHandle(ctx, p2.x, canvas.height / 2, s.color);
      }
      break;
    }

    case 'price_range': {
      const p1 = pixels[0], p2 = pixels[1];
      if (!p1 || !p2 || p1.y == null || p2.y == null) break;
      const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
      ctx.fillStyle = 'rgba(156,39,176,0.09)';
      ctx.fillRect(0, y1, canvas.width, y2 - y1);
      ctx.setLineDash([4, 3]);
      [y1, y2].forEach(yv => {
        ctx.beginPath();
        ctx.moveTo(0, yv);
        ctx.lineTo(canvas.width, yv);
        ctx.stroke();
      });
      const pt1r = obj.points[0], pt2r = obj.points[1];
      if (pt1r && pt2r) {
        const pips = Math.abs(pt2r.price - pt1r.price) * 10000;
        const pct = Math.abs((pt2r.price - pt1r.price) / pt1r.price * 100);
        ctx.setLineDash([]);
        ctx.font = '10px sans-serif';
        const label = `${pips.toFixed(1)}p | ${pct.toFixed(2)}%`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(19,23,34,0.85)';
        ctx.fillRect(canvas.width / 2 - tw / 2 - 4, (y1 + y2) / 2 - 8, tw + 8, 16);
        ctx.fillStyle = s.color;
        ctx.fillText(label, canvas.width / 2 - tw / 2, (y1 + y2) / 2 + 4);
      }
      if (obj.selected) {
        drawHandle(ctx, canvas.width / 2, p1.y, s.color);
        drawHandle(ctx, canvas.width / 2, p2.y, s.color);
      }
      break;
    }

  }

  ctx.restore();
}

function drawHandle(ctx, x, y, color) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#131722';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// Square handle for position tools (TradingView-style blue square)
function drawSquareHandle(ctx, x, y) {
  const S = 8;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = '#1e222d';
  ctx.fillRect(x - S / 2, y - S / 2, S, S);
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - S / 2, y - S / 2, S, S);
  ctx.restore();
}

// Rounded-rect fill helper (no roundRect() needed)
function _fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
}

// Pill badge label — anchored to the RIGHT edge of the box
function drawPosLabel(ctx, right, yCenter, text, color) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
  const tw = ctx.measureText(text).width;
  const ph = 16, pw = tw + 10, r = 3;
  const lx = right - pw - 2;
  const ly = yCenter - ph / 2;
  ctx.fillStyle = color;
  _fillRoundRect(ctx, lx, ly, pw, ph, r);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, lx + 5, yCenter);
  ctx.restore();
}

function extendLine(p1, p2, width, height, extLeft, extRight) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  if (dx === 0 && dy === 0) return [p1, p2];
  let a = p1, b = p2;
  if (extRight) {
    const t = (width - p1.x) / (dx || 1);
    b = { x: width, y: p1.y + t * dy };
  }
  if (extLeft) {
    const t = -p1.x / (dx || 1);
    a = { x: 0, y: p1.y + t * dy };
  }
  return [a, b];
}

function extendRay(p1, p2, width) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  if (dx === 0 && dy === 0) return p2;
  const t = (width - p1.x) / (dx || 0.0001);
  return { x: p1.x + dx * t * 10, y: p1.y + dy * t * 10 };
}

// ── Preview während Zeichnen ───────────────────────────────────────────────

function renderPreview(ctx, chartWidth) {
  const mx = drawingState.mouseX, my = drawingState.mouseY;
  const tool = drawingState.tool;
  const s = drawingState.settings;
  const canvas = ctx.canvas;
  const actualWidth = chartWidth || canvas.width;
  const pt1 = drawingState.points[0];
  if (!pt1) return;
  const p1 = chartToPixel(pt1.time, pt1.price, pt1.logical);
  if (!p1 || p1.x == null) return;
  const p2 = { x: mx, y: my };

  ctx.save();
  ctx.globalAlpha = 0.75;
  applyLineStyle(ctx, 'dashed', 1, s.color);

  switch (tool) {
    case 'trendline':
    case 'ray':
    case 'arrow':
    case 'measure':
    case 'date_range':
    case 'price_range':
    case 'fibonacci': {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      drawHandle(ctx, p1.x, p1.y, s.color);
      break;
    }
    case 'long_pos':
    case 'short_pos': {
      // Live preview: show TP zone + SL zone (mirrored) as user drags
      const entryPrice = pt1.price;
      const cursorPt = pixelToChart(mx, my);
      if (!cursorPt.price) break;
      const dist = Math.max(Math.abs(cursorPt.price - entryPrice), 0.00001);
      const isLong = (tool === 'long_pos');

      const tpPriceV = isLong ? entryPrice + dist : entryPrice - dist;
      const slPriceV = isLong ? entryPrice - dist : entryPrice + dist;

      const entryYV = candleSeries.priceToCoordinate(entryPrice);
      const tpYV    = candleSeries.priceToCoordinate(tpPriceV);
      const slYV    = candleSeries.priceToCoordinate(slPriceV);
      if (entryYV == null || tpYV == null || slYV == null) break;

      const x0 = Math.min(p1.x, p2.x);
      const x1 = Math.max(p1.x, p2.x);
      const wV = Math.max(x1 - x0, 4);

      ctx.globalAlpha = 0.7;
      ctx.setLineDash([]);

      // TP zone
      ctx.fillStyle = 'rgba(38,166,154,0.18)';
      ctx.strokeStyle = 'rgba(38,166,154,0.6)';
      ctx.lineWidth = 1;
      if (isLong) {
        ctx.fillRect(x0, tpYV, wV, entryYV - tpYV);
        ctx.strokeRect(x0, tpYV, wV, entryYV - tpYV);
      } else {
        ctx.fillRect(x0, entryYV, wV, tpYV - entryYV);
        ctx.strokeRect(x0, entryYV, wV, tpYV - entryYV);
      }

      // SL zone
      ctx.fillStyle = 'rgba(239,83,80,0.18)';
      ctx.strokeStyle = 'rgba(239,83,80,0.6)';
      if (isLong) {
        ctx.fillRect(x0, entryYV, wV, slYV - entryYV);
        ctx.strokeRect(x0, entryYV, wV, slYV - entryYV);
      } else {
        ctx.fillRect(x0, slYV, wV, entryYV - slYV);
        ctx.strokeRect(x0, slYV, wV, entryYV - slYV);
      }

      // Entry line dashed
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, entryYV); ctx.lineTo(x1, entryYV); ctx.stroke();
      ctx.setLineDash([]);

      // Mini pip count labels
      const pips = (dist * 10000).toFixed(0);
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#26a69a';
      if (isLong) ctx.fillText(`TP +${pips}p`, x0 + 4, (tpYV + entryYV) / 2 + 4);
      else        ctx.fillText(`TP -${pips}p`, x0 + 4, (entryYV + tpYV) / 2 + 4);
      ctx.fillStyle = '#ef5350';
      if (isLong) ctx.fillText(`SL -${pips}p`, x0 + 4, (entryYV + slYV) / 2 + 4);
      else        ctx.fillText(`SL +${pips}p`, x0 + 4, (slYV + entryYV) / 2 + 4);
      break;
    }
    case 'rectangle': {
      const rx = Math.min(p1.x, p2.x), ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x), rh = Math.abs(p2.y - p1.y);
      ctx.fillStyle = s.fillColor;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      break;
    }
    case 'triangle': {

      if (drawingState.phase === 'first_point') {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      } else if (drawingState.phase === 'second_point') {
        const pt2 = drawingState.points[1];
        const pp2 = chartToPixel(pt2.time, pt2.price, pt2.logical);
        if (pp2 && pp2.x != null) {
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(pp2.x, pp2.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.closePath();
          ctx.fillStyle = s.fillColor;
          ctx.fill();
          ctx.stroke();
        }
      }
      break;
    }
    case 'parallel': {
      if (drawingState.phase === 'first_point') {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      } else if (drawingState.phase === 'second_point') {
        const pt2 = drawingState.points[1];
        const pp2 = chartToPixel(pt2.time, pt2.price, pt2.logical);
        if (pp2 && pp2.x != null) {
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(pp2.x, pp2.y);
          ctx.stroke();
          const dy = p2.y - interpolateY(p2.x, p1, pp2);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y + dy);
          ctx.lineTo(pp2.x, pp2.y + dy);
          ctx.stroke();
        }
      }
      break;
    }
  }

  ctx.restore();
}

// ── Panel de propiedades ──────────────────────────────────────────────────

function showPropertiesPanel(obj, x, y) {
  let panel = document.getElementById('drawing-props-panel');
  if (!panel) return;

  panel.style.display = 'flex';
  const s = obj.settings;

  const colorInput = panel.querySelector('#prop-color');
  const widthInput = panel.querySelector('#prop-width');
  if (colorInput) colorInput.value = s.color || '#2196F3';
  if (widthInput) widthInput.value = s.lineWidth || 1;

  // Position near object
  const canvas = document.getElementById('drawing-canvas');
  const cr = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
  const panelW = 160, panelH = 40;
  let px = cr.left + x + 10;
  let py = cr.top + y - panelH - 10;
  if (px + panelW > window.innerWidth) px = window.innerWidth - panelW - 8;
  if (py < 0) py = cr.top + y + 14;
  panel.style.left = px + 'px';
  panel.style.top = py + 'px';
}

function hidePropertiesPanel() {
  const panel = document.getElementById('drawing-props-panel');
  if (panel) panel.style.display = 'none';
}

function hexToRgba(hex, alpha) {
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.substring(1, 3), 16);
    g = parseInt(hex.substring(3, 5), 16);
    b = parseInt(hex.substring(5, 7), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyPropColor(val) {
  if (!drawingState.activeObjId) return;
  const obj = drawingState.objects.find(o => o.id === drawingState.activeObjId);
  if (obj) {
    obj.settings.color = val;
    // Auto-update fillColor for tools with background areas
    if (['rectangle', 'triangle', 'fibonacci', 'parallel'].includes(obj.type)) {
      obj.settings.fillColor = hexToRgba(val, 0.15);
    }
    saveDrawings();
  }
}

function applyPropWidth(val) {
  if (!drawingState.activeObjId) return;
  const obj = drawingState.objects.find(o => o.id === drawingState.activeObjId);
  if (obj) { obj.settings.lineWidth = parseInt(val) || 1; saveDrawings(); }
}

function deleteSelectedObject() {
  if (!drawingState.activeObjId) return;
  pushUndo();
  drawingState.objects = drawingState.objects.filter(o => o.id !== drawingState.activeObjId);
  drawingState.activeObjId = null;
  hidePropertiesPanel();
  saveDrawings();
}

window.applyPropColor = applyPropColor;
window.applyPropWidth = applyPropWidth;
window.deleteSelectedObject = deleteSelectedObject;

// ── Keyboard shortcuts ────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  switch (e.key) {
    case 'Escape':
      drawingState.phase = 'idle';
      drawingState.points = [];
      setDrawingTool('cursor');
      break;
    case 'Delete':
    case 'Backspace':
      deleteSelectedObject();
      break;
    case 'z':
    case 'Z':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); undoDrawing(); }
      break;
    case 'a':
    case 'A':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        drawingState.objects.forEach(o => o.selected = true);
        if (drawingState.objects.length) drawingState.activeObjId = drawingState.objects[drawingState.objects.length - 1].id;
      }
      break;
    case 'l': case 'L': setDrawingTool('trendline'); break;
    case 'h': case 'H': setDrawingTool('hline'); break;
    case 'v': case 'V': if (!e.ctrlKey) setDrawingTool('vline'); break;
    case 'f': case 'F': setDrawingTool('fibonacci'); break;
    case 'r': case 'R': setDrawingTool('rectangle'); break;
    case 't': case 'T': setDrawingTool('text'); break;
    case 'm': case 'M': setDrawingTool('measure'); break;
    case 'ArrowUp': if (!e.ctrlKey) { e.preventDefault(); chartZoomIn(); } break;
    case 'ArrowDown': if (!e.ctrlKey) { e.preventDefault(); chartZoomOut(); } break;
    case '=':
    case '+': if (e.ctrlKey) { e.preventDefault(); chartZoomIn(); } break;
    case '-': if (e.ctrlKey) { e.preventDefault(); chartZoomOut(); } break;
    case '0': if (e.ctrlKey) { e.preventDefault(); chartFitContent(); } break;
  }

  // Symbol search shortcuts
  if (e.key === '/' && !e.ctrlKey) {
    e.preventDefault();
    if (typeof openSymbolSearch === 'function') openSymbolSearch();
  }
  if (e.key === 'k' && e.ctrlKey) {
    e.preventDefault();
    if (typeof openSymbolSearch === 'function') openSymbolSearch();
  }
});

// ── Init on DOM ready ─────────────────────────────────────────────────────

function onCrosshairMove(param) {
  const mode = drawingState.mode;
  if (!param.point || mode !== 'select' || drawingState.isDragging) return;
  const { x, y } = param.point;
  
  const hit = hitTest(x, y);
  const prevHovered = drawingState.hoveredObjId;
  drawingState.hoveredObjId = hit ? hit.id : null;

  if (prevHovered !== drawingState.hoveredObjId) {
    updateCanvasPointerEvents();
  }

  const canvas = document.getElementById('drawing-canvas');
  if (canvas) {
    if (hit) {
      const pixels = hit.points.map(p => chartToPixel(p.time, p.price, p.offsetSeconds, p.logical));
      const hi = getHandleIndex(x, y, pixels, hit);
      const isPos = (hit.type === 'long_pos' || hit.type === 'short_pos');
      if (hi !== -1) {
        if (isPos) {
          cursor = hi !== 1 ? 'ns-resize' : 'nesw-resize';
        } else if (hit.type === 'rectangle') {
          cursor = (hi === 0 || hi === 3) ? 'nwse-resize' : 'nesw-resize';
        } else {
          cursor = 'move';
        }
      } else {
        cursor = 'move';
      }
      canvas.style.cursor = cursor;
    } else {
      canvas.style.cursor = 'default';
    }
  }
}

(function waitForChart() {
  if (typeof mainChart !== 'undefined' && typeof candleSeries !== 'undefined') {
    initDrawingCanvas();
    mainChart.subscribeCrosshairMove(onCrosshairMove);
    // Default: cursor tool active
    setDrawingTool('cursor');
    // Carga inicial de dibujos
    loadDrawings();
  } else {
    setTimeout(waitForChart, 100);
  }
})();

// Note: resetAllCharts wrapper removed to prevent race conditions.
// Drawings are now loaded explicitly where needed.

function showCustomConfirm(title, message, onOk) {
    const modal = document.getElementById('custom-confirm-modal');
    if (!modal) return;
    
    const titleEl = document.getElementById('custom-confirm-title');
    const messageEl = document.getElementById('custom-confirm-message');
    const okBtn = document.getElementById('custom-confirm-ok');
    const cancelBtn = document.getElementById('custom-confirm-cancel');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    modal.style.display = 'flex';

    // Cleanup previous listeners by cloning
    const newOkBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newOkBtn.onclick = () => {
        modal.style.display = 'none';
        if (onOk) onOk();
    };

    newCancelBtn.onclick = () => {
        modal.style.display = 'none';
    };
    
    // Close on overlay click
    modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
    };
}
