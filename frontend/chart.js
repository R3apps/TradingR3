// Pre-define to avoid ReferenceError
window.initSubscription = window.sendSubscription = function() {
    // Actualizar título dinámicamente
    if (window.currentInstrument) {
        const newTitle = `TradingR3 - ${window.currentInstrument.replace('_', '/')}`;
        document.title = newTitle;
        if (window.pywebview && pywebview.api && pywebview.api.set_title) {
            pywebview.api.set_title(newTitle);
        }
    }
    
    debug('Attempting subscription', { instrument: currentInstrument, timeframe: currentTimeframe, readyState: window.socket ? window.socket.readyState : 'null' });
    if (window.socket && window.socket.readyState === WebSocket.OPEN) {
        resetAllCharts();
        window.socket.send(JSON.stringify({
            type: 'subscribe',
            instrument: window.currentInstrument,
            timeframe: window.currentTimeframe
        }));
    } else {
        debug('Socket not ready, queuing subscription');
        if (window.socket && window.socket.readyState === WebSocket.CONNECTING) {
            setTimeout(window.sendSubscription, 500);
        } else {
            if (!window.socket || window.socket.readyState === WebSocket.CLOSED) {
                console.error("Socket not connected");
            }
        }
    }
};
function saveSession() {
    if (window.backtestActive || (window.backtestState && window.backtestState.active)) return;
    if (!window.socket || window.socket.readyState !== WebSocket.OPEN) return;

    const state = {
        tabs: window.tabs,
        activeTabId: window.activeTabId,
        currentInstrument: window.currentInstrument,
        currentTimeframe: window.currentTimeframe
    };
    window.socket.send(JSON.stringify({
        type: 'save_session',
        state: state
    }));
}
window.saveSession = saveSession;

function handleSessionRestored(state) {
    console.log("[SESSION] Restoring session from server disk...");
    if (state.tabs && state.tabs.length > 0) {
        window.tabs = state.tabs;
        window.activeTabId = state.activeTabId;
        window.currentInstrument = state.currentInstrument;
        window.currentTimeframe = state.currentTimeframe;
        
        // Refrescar UI inmediatamente
        if (typeof renderTabs === 'function') renderTabs();
        if (typeof updateTimeframeUI === 'function') updateTimeframeUI(window.currentTimeframe);
        
        // Suscribirse al activo restaurado
        window.initSubscription();
    }
}
window.handleSessionRestored = handleSessionRestored;


// Initial state (Defaults - will be overwritten by session_restored)
window.currentInstrument = 'GBP_USD';
window.currentTimeframe = 'M5';
window.tabs = [{ id: Date.now(), symbol: 'GBP_USD', timeframe: 'M5' }];
window.activeTabId = window.tabs[0].id;

let isUpdating = false;

// Flags for historical scroll
let isLoadingMore = false;
let hasMoreData = true;

// --- INFINITE SCROLL ENGINE CONSTANTS ---
const PREFETCH_THRESHOLD = 80;    // Cargar cuando quedan 80 velas a la izquierda
const PREFETCH_BATCH = 300;        // Pedir 300 velas por batch
let prefetchTimer = null;          // Debounce timer
let prefetchInFlight = false;      // Petición en vuelo (no isLoadingMore)
let prefetchQueue = 0;             // Peticiones pendientes en cola

let candleData = [];
let rsiData = [];
let stochKData = [];
let stochDData = [];
window.lastCandleTime = null;
window.countdownPriceLine = null;

const isBacktestActive = () => {
    return !!(window.backtestActive || (window.backtestState && window.backtestState.active));
};
let clockSyncOffset = 0;

// Debug logging wrapper
function debug(message, data = null) {
    const time = new Date().toLocaleTimeString();
    if (data) {
        console.log(`[${time}] DEBUG: ${message}`, data);
    } else {
        console.log(`[${time}] DEBUG: ${message}`);
    }
}

// Data validation helpers
function sortAndDeduplicate(data) {
  if (!data || !Array.isArray(data)) return [];
  const sorted = [...data].sort((a, b) => a.time - b.time);
  const result = [];
  const seen = new Set();
  for (const item of sorted) {
    if (!seen.has(item.time)) {
      result.push(item);
      seen.add(item.time);
    }
  }
  return result;
}

function filterCandles(candles) {
  if (!candles || !Array.isArray(candles)) return [];
  return sortAndDeduplicate(candles.map(c => {
    if (!c || c.time == null || c.open == null || c.high == null || c.low == null || c.close == null) return null;
    const t = Math.floor(Number(c.time));
    const o = Number(c.open);
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);
    const v = Number(c.volume || 0);
    
    if (isFinite(t) && t > 0 && isFinite(o) && o > 0 && isFinite(h) && h > 0 && 
        isFinite(l) && l > 0 && isFinite(cl) && cl > 0) {
      return { time: t, open: o, high: h, low: l, close: cl, volume: v };
    }
    return null;
  }).filter(c => c !== null));
}

function filterSeries(data) {
  if (!data || !Array.isArray(data)) return [];
  return sortAndDeduplicate(data.map(d => {
    if (!d || d.time == null || d.value == null) return null;
    const t = Math.floor(Number(d.time));
    const v = Number(d.value);
    if (isFinite(t) && t > 0 && isFinite(v)) {
      return { time: t, value: v };
    }
    return null;
  }).filter(d => d !== null));
}

function safeSetRange(timeScale, range) {
  if (!range || isUpdating) return;
  const from = Number(range.from);
  const to = Number(range.to);
  if (!isFinite(from) || !isFinite(to)) return;
  if (from >= to) return;
  try {
    timeScale.setVisibleLogicalRange({ from, to });
  } catch(e) { /* ignore */ }
}

// Chart Initialization
const sharedChartOptions = {
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#D9D9D9' },
    grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#2a2e39', minimumWidth: 75, borderVisible: true },
    timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 10 },
};

const mainChart = LightweightCharts.createChart(document.getElementById('main-chart'), sharedChartOptions);
const candleSeries = mainChart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350', borderVisible: false,
    priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    priceLineVisible: false,
    lastValueVisible: false, // Disabling to use custom drawing.js block
    countdownVisible: false,
    title: '', 
});
const volumeSeries = mainChart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' });
mainChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

function updateSeriesPrecision(price) {
    if (!candleSeries) return;
    let precision = 5;
    let minMove = 0.00001;
    
    if (price > 100) {
        precision = 2;
        minMove = 0.01;
    } else if (price > 10) {
        precision = 3;
        minMove = 0.001;
    }
    
    candleSeries.applyOptions({
        priceFormat: {
            type: 'price',
            precision: precision,
            minMove: minMove
        },
        lastValueVisible: false, // REINFORCE: Never show native label
        priceLineVisible: false,
        countdownVisible: false
    });
}

const indicatorOptions = {
    ...sharedChartOptions,
    timeScale: { ...sharedChartOptions.timeScale, visible: false },
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#D9D9D9' },
    rightPriceScale: { 
        ...sharedChartOptions.rightPriceScale, 
        autoScale: true,
        lastValueVisible: true,
        priceLineVisible: true
    }
};

const rsiChart = LightweightCharts.createChart(document.getElementById('rsi-chart'), {
    ...indicatorOptions, rightPriceScale: { ...indicatorOptions.rightPriceScale, scaleMargins: { top: 0.2, bottom: 0.2 } }
});
const rsiSeries = rsiChart.addLineSeries({ 
    color: '#7e57c2', 
    lineWidth: 2, 
    lastValueVisible: true,
    priceLineVisible: true,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 } 
});

const stochChart = LightweightCharts.createChart(document.getElementById('stoch-chart'), {
    ...indicatorOptions, rightPriceScale: { ...indicatorOptions.rightPriceScale, scaleMargins: { top: 0.2, bottom: 0.2 } }
});
const stochKSeries = stochChart.addLineSeries({ 
    color: '#2196F3', 
    lineWidth: 1, 
    lastValueVisible: true,
    priceLineVisible: true,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 } 
});
const stochDSeries = stochChart.addLineSeries({ 
    color: '#FF6D00', 
    lineWidth: 1, 
    lastValueVisible: true,
    priceLineVisible: true,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 } 
});

const allCharts = [mainChart, rsiChart, stochChart];

// EXPORTACIÓN CRÍTICA PARA COMUNICACIÓN ENTRE SCRIPTS
window.mainChart = mainChart;
window.candleSeries = candleSeries;
window.volumeSeries = volumeSeries;
window.rsiSeries = rsiSeries;
window.stochKSeries = stochKSeries;
window.stochDSeries = stochDSeries;
window.allCharts = allCharts;

// --- CHARTS SYNCHRONIZATION ---

function syncCharts() {
    allCharts.forEach(sourceChart => {
        sourceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
            if (!range || isUpdating) return;
            allCharts.forEach(targetChart => {
                if (targetChart === sourceChart) return;
                try {
                    const targetTimeScale = targetChart.timeScale();
                    const currentRange = targetTimeScale.getVisibleLogicalRange();
                    if (!currentRange || 
                        Math.abs(currentRange.from - range.from) > 0.001 || 
                        Math.abs(currentRange.to - range.to) > 0.001) {
                        targetTimeScale.setVisibleLogicalRange(range);
                    }
                } catch(e) {}
            });
        });
    });

    allCharts.forEach(sourceChart => {
        sourceChart.subscribeCrosshairMove(param => {
            if (isUpdating) return;
            isUpdating = true;
            try {
                if (!param.point || !param.time) {
                    allCharts.forEach(targetChart => {
                        if (targetChart !== sourceChart) targetChart.clearCrosshairPosition();
                    });
                    return;
                }
                
                allCharts.forEach(targetChart => {
                    if (targetChart === sourceChart) return;
                    
                    const targetSeries = targetChart === mainChart ? candleSeries : 
                                       targetChart === rsiChart ? rsiSeries : 
                                       stochKSeries;
                                       
                    if (targetChart && targetSeries && param.time) {
                        try {
                            targetChart.setCrosshairPosition(null, param.time, targetSeries);
                        } catch (e) { /* ignore sync errors during transitions */ }
                    }
                });
            } finally {
                isUpdating = false;
            }
        });
    });
    // --- PRICE SCALE SYNC ---
    // Ensure all charts have the same right price scale width to align time axes perfectly
    function syncPriceScales() {
        if (allCharts.length === 0) return;
        
        // REFUERZO: Primero bajamos el mínimo de todos para que LW charts nos diga su ancho "natural" actual
        allCharts.forEach(c => {
            c.priceScale('right').applyOptions({ minimumWidth: 40 });
        });

        // Obtenemos el ancho máximo actual (ahora que pueden haber encogido)
        let maxWidth = 75;
        allCharts.forEach(c => {
            const w = c.priceScale('right').width();
            if (w > maxWidth) maxWidth = w;
        });
        
        // Aplicamos ese ancho como mínimo a todos para mantener la alineación vertical
        allCharts.forEach(c => {
            c.priceScale('right').applyOptions({ minimumWidth: maxWidth });
        });
    }

    // Monitorizar cambios en las escalas de precios (ej: de BTC 90000 a 1.2500)
    setInterval(syncPriceScales, 2000);
}
syncCharts();

// --- INTERACTIVE FEATURES ---

function setupAxisReset() {
    const charts = [
        { id: 'main-chart', chart: mainChart, series: candleSeries },
        { id: 'rsi-chart', chart: rsiChart, series: rsiSeries },
        { id: 'stoch-chart', chart: stochChart, series: stochKSeries }
    ];

    charts.forEach(({ id, chart, series }) => {
        const el = document.getElementById(id);
        if (!el) return;

        el.addEventListener('dblclick', (e) => {
            const rect = el.getBoundingClientRect();
            const axisWidth = 60; // Ancho aproximado del eje derecho
            
            // Si el click es en el margen derecho (el eje de precios)
            if (e.clientX > rect.right - axisWidth) {
                chart.timeScale().scrollToRealTime();
                if (series) {
                    series.priceScale().applyOptions({ autoScale: true });
                }
            }
        });
    });
}
setupAxisReset();

// --- CORE FUNCTIONS ---

function resetAllCharts() {
    debug('Resetting all charts', { instrument: currentInstrument, timeframe: currentTimeframe });
    isUpdating = true;
    isLoadingMore = false;
    hasMoreData = true;
    candleData = [];
    rsiData = [];
    stochKData = [];
    stochDData = [];
    lastCandleTime = null;
    
    // Limpiar estado de prefetch al cambiar de instrumento/timeframe
    prefetchInFlight = false;
    isLoadingMore = false;
    hasMoreData = true;
    clearTimeout(prefetchTimer);
    if (window._pendingAppendRaf) {
        cancelAnimationFrame(window._pendingAppendRaf);
        window._pendingAppendRaf = null;
    }
    
    try {
        if (countdownPriceLine) {
            candleSeries.removePriceLine(countdownPriceLine);
            countdownPriceLine = null;
        }
        allCharts.forEach(c => c.clearCrosshairPosition());
        candleSeries.setData([]);
        volumeSeries.setData([]);
        rsiSeries.setData([]);
        stochKSeries.setData([]);
        stochDSeries.setData([]);
    } finally {
        isUpdating = false;
    }
}

// --- TABS LOGIC ---

function renderTabs() {
    const container = document.getElementById('tabs-container');
    if (!container) {
        setTimeout(renderTabs, 100);
        return;
    }
    container.innerHTML = '';
    if (!window.tabs) window.tabs = [];
    
    window.tabs.forEach(tab => {
        const div = document.createElement('div');
        div.className = `tab ${tab.id === window.activeTabId ? 'active' : ''}`;
        div.innerHTML = `
            <span>${tab.symbol.replace('_', '/')}</span>
            <span class="tab-close" data-id="${tab.id}">×</span>
        `;
        div.onclick = (e) => {
            if (e.target.classList.contains('tab-close')) {
                closeTab(tab.id);
            } else {
                switchTab(tab.id);
            }
        };
        container.appendChild(div);
    });
}

function switchTab(id) {
    window.activeTabId = id;
    const tab = window.tabs.find(t => t.id === id);
    if (!tab) return;
    
    window.currentInstrument = tab.symbol;
    window.currentTimeframe = tab.timeframe || 'M5'; 
    
    // Update window title
    const newTitle = `TradingR3 - ${tab.symbol.replace('_', '/')}`;
    document.title = newTitle;
    if (window.pywebview && pywebview.api && pywebview.api.set_title) {
        pywebview.api.set_title(newTitle);
    }
    
    // Sync the instrument button label in toolbar
    const instrBtn = document.getElementById('active-instrument-label');
    if (instrBtn) instrBtn.textContent = tab.symbol.replace('_', '/');

    updateTimeframeUI(window.currentTimeframe);
    renderTabs();
    saveSession();
    
    // No title for axis (User requested removal)
    if (window.candleSeries) {
        window.candleSeries.applyOptions({ title: '' });
    }

    // window.initSubscription calls resetAllCharts() internally, so we don't need it twice here
    window.initSubscription();
}

function closeTab(id) {
    if (window.tabs.length === 1) return;
    const index = window.tabs.findIndex(t => t.id === id);
    window.tabs = window.tabs.filter(t => t.id !== id);
    if (window.activeTabId === id) {
        switchTab(window.tabs[Math.max(0, index - 1)].id);
    } else {
        renderTabs();
        saveSession();
    }
}

// --- TOGGLE INDICATORS ---

function toggleIndicator(id) {
    const isVol = id === 'volume-chart';
    const container = isVol ? null : document.getElementById(id.replace('-chart', '-container'));
    
    if (isVol) {
        const isCurrentlyVisible = volumeSeries.options().visible;
        volumeSeries.applyOptions({ visible: !isCurrentlyVisible });
        return;
    }

    if (container) {
        const isCurrentlyHidden = container.style.display === 'none';
        container.style.display = isCurrentlyHidden ? 'flex' : 'none';
        
        setTimeout(() => {
            const mainEl = document.getElementById('main-chart');
            const w = mainEl.clientWidth;
            mainChart.resize(w, mainEl.clientHeight);
            
            const rsiC = document.getElementById('rsi-container');
            if (rsiC && rsiC.style.display !== 'none') {
                const rsiChartEl = document.getElementById('rsi-chart');
                rsiChart.resize(w, rsiChartEl.clientHeight || 106);
            }
            const stochC = document.getElementById('stoch-container');
            if (stochC && stochC.style.display !== 'none') {
                const stochChartEl = document.getElementById('stoch-chart');
                stochChart.resize(w, stochChartEl.clientHeight || 106);
            }
        }, 50);
    }
}
window.toggleIndicator = toggleIndicator;

// --- DATA PROCESSING ---

function updateChartsHistory(candles, indicators, append = false) {
    debug('updateChartsHistory called', { candlesCount: candles?.length, append });
    if (isUpdating) {
        console.warn('updateChartsHistory blocked: isUpdating is true');
        return;
    }
    isUpdating = true;
    
    try {
        const filteredCandles = filterCandles(candles);
        if (filteredCandles.length === 0) return;
        
        const filteredRsi = filterSeries(indicators?.rsi);
        const filteredStochK = filterSeries(indicators?.stoch_k);
        const filteredStochD = filterSeries(indicators?.stoch_d);

        if (append) {
            const visibleRange = mainChart.timeScale().getVisibleLogicalRange();
            const newCount = filteredCandles.length;

            const oldFirstTime = candleData.length > 0 ? candleData[0].time : null;
            
            // 1. Merge datos en memoria INMEDIATAMENTE (sin render aún)
            candleData = sortAndDeduplicate([...filteredCandles, ...candleData]);
            rsiData    = sortAndDeduplicate([...filteredRsi,    ...rsiData]);
            stochKData = sortAndDeduplicate([...filteredStochK, ...stochKData]);
            stochDData = sortAndDeduplicate([...filteredStochD, ...stochDData]);
            
            // Calcular cuántas velas nuevas SE AÑADIERON REALMENTE al principio
            const actualNewCount = oldFirstTime ? candleData.findIndex(c => c.time === oldFirstTime) : 0;
            
            if (actualNewCount <= 0 && filteredCandles.length > 0) {
                // Si no se añadió nada nuevo tras pedirlos, marcar que no hay más para evitar bucles
                hasMoreData = false;
                prefetchInFlight = false;
                isLoadingMore = false;
                return;
            }

            if (candleData.length > 0) lastCandleTime = candleData[candleData.length - 1].time;

            // 2. Desbloquear prefetch INMEDIATAMENTE (no esperar al render)
            prefetchInFlight = false;
            isLoadingMore = false;

            // 3. Render diferido con requestAnimationFrame para no bloquear el hilo
            if (window._pendingAppendRaf) cancelAnimationFrame(window._pendingAppendRaf);

            window._pendingAppendRaf = requestAnimationFrame(() => {
                window._pendingAppendRaf = null;

                // Deshabilitar scroll durante el setData para evitar glitches
                mainChart.applyOptions({ handleScroll: false, handleScale: false });

                try {
                    candleSeries.setData(candleData);
                    volumeSeries.setData(candleData.map(c => ({
                        time: c.time,
                        value: Number(c.volume || 0),
                        color: c.close >= c.open ? '#26a69a80' : '#ef535080'
                    })));
                    rsiSeries.setData(rsiData);
                    stochKSeries.setData(stochKData);
                    stochDSeries.setData(stochDData);
                } finally {
                    mainChart.applyOptions({ handleScroll: true, handleScale: true });
                }

                // 4. Restaurar posición del scroll DESPUÉS del render
                if (visibleRange && actualNewCount > 0) {
                    requestAnimationFrame(() => {
                        safeSetRange(mainChart.timeScale(), {
                            from: visibleRange.from + actualNewCount,
                            to:   visibleRange.to   + actualNewCount
                        });
                    });
                }
            });
            isUpdating = false; 
            return; 
        } else {
            const isInitialLoad = candleData.length === 0;
            candleData = filteredCandles;
            rsiData = filteredRsi;
            stochKData = filteredStochK;
            stochDData = filteredStochD;
            if (candleData.length > 0) {
              lastCandleTime = candleData[candleData.length - 1].time;
            }

            mainChart.applyOptions({ handleScroll: false, handleScale: false });
            candleSeries.setData(candleData);
            if (candleData.length > 0) {
            updateSeriesPrecision(candleData[candleData.length - 1].close);
        }
        
        // Ensure precision is applied to the series explicitly
        const lastPrice = candleData[candleData.length - 1].close;
        updateSeriesPrecision(lastPrice);

        volumeSeries.setData(candleData.map(c => ({
                time: c.time, value: Number(c.volume || 0), color: c.close >= c.open ? '#26a69a80' : '#ef535080'
            })));
            rsiSeries.setData(rsiData);
            stochKSeries.setData(stochKData);
            stochDSeries.setData(stochDData);
            
            // Forzar auto-escala del eje de precios para el nuevo instrumento
            candleSeries.priceScale().applyOptions({ autoScale: true });
            
            mainChart.applyOptions({ handleScroll: true, handleScale: true });

            setTimeout(() => {
                const mainEl  = document.getElementById('main-chart');
                const rsiEl   = document.getElementById('rsi-chart');
                const stochEl = document.getElementById('stoch-chart');
                const w = mainEl ? mainEl.clientWidth : 0;
                if (w > 0) {
                    try { mainChart.resize(w, mainEl.clientHeight); } catch(e) {}
                    if (rsiEl && rsiEl.clientHeight > 0)
                        try { rsiChart.resize(w, rsiEl.clientHeight); } catch(e) {}
                    if (stochEl && stochEl.clientHeight > 0)
                        try { stochChart.resize(w, stochEl.clientHeight); } catch(e) {}

                    if (isInitialLoad) {
                        const count = candleData.length;
                        const defaultRange = 150; // Mostrar unas 150 velas por defecto
                        
                        // Centrar eje de precios
                        candleSeries.priceScale().applyOptions({ autoScale: true });
                        
                        // Ajustar rango temporal para ver el final (derecha)
                        mainChart.timeScale().setVisibleLogicalRange({
                            from: count - defaultRange,
                            to: count + 5 // Un pequeño margen a la derecha
                        });
                        
                        if (window.rsiChart) {
                            rsiSeries.priceScale().applyOptions({ autoScale: true });
                            rsiChart.timeScale().setVisibleLogicalRange({
                                from: count - defaultRange,
                                to: count + 5
                            });
                        }
                        if (window.stochChart) {
                            stochKSeries.priceScale().applyOptions({ autoScale: true });
                            stochChart.timeScale().setVisibleLogicalRange({
                                from: count - defaultRange,
                                to: count + 5
                            });
                        }
                    }
                }
                if (window.loadDrawings) window.loadDrawings();
            }, 100);
        }
    } finally {
        setTimeout(() => { isUpdating = false; }, 50);
    }
}

function updateChartsLive(msg) {
  if (isUpdating || isBacktestActive()) return; // Discard if history is loading or backtest is running
  
  // Strict instrument check
  if (!msg.instrument || msg.instrument !== currentInstrument) {
    if (msg.instrument && msg.instrument !== 'null') {
       console.debug(`[${new Date().toLocaleTimeString()}] Discarding update for ${msg.instrument} (Current: ${currentInstrument})`);
    }
    return;
  }
  
  const candle = msg.candle;
  if (candle && 
      candle.time != null && 
      isFinite(Number(candle.open)) && 
      isFinite(Number(candle.high)) && 
      isFinite(Number(candle.low)) && 
      isFinite(Number(candle.close))) {
    try {
      if (msg.tick && msg.tick.time) {
        let serverT = Number(msg.tick.time);
        if (serverT > 200000000000) serverT = serverT / 1000; 
        
        const localT = performance.now() / 1000;
        
        // SINCRO INERCIAL: Solo ajustar si el desfase es REALMENTE grande (> 2.0s)
        const currentPredictedServer = window.masterClockSync ? (window.masterClockSync.server + (localT - window.masterClockSync.local)) : 0;
        const drift = Math.abs(serverT - currentPredictedServer);
        
        // FILTRO DE SEGURIDAD: Ignorar si el salto es sospechosamente igual a una vela (ej: 300s, 900s)
        const duration = timeframeToSeconds(window.currentTimeframe || "M5");
        const isSuspiciousJump = Math.abs(drift % duration) < 1.0 || Math.abs(drift % duration - duration) < 1.0;
        
        if (!window.masterClockSync || (drift > 2.0 && !isSuspiciousJump) || drift > 1000) {
            window.masterClockSync = { server: serverT, local: localT };
            if (drift > 2.0) console.log(`[SYNC] Clock adjusted. Drift was: ${(serverT - currentPredictedServer).toFixed(2)}s`);
        }
      }
      
      // REFUERZO: Usar el tiempo de la vela (siempre segundos) para anclar el reloj si no hay ticks
      if (!window.masterClockSync && candleObj.time) {
          window.masterClockSync = { server: candleObj.time, local: performance.now() / 1000 };
      }
      
      const candleObj = {
        time: Math.floor(Number(candle.time)),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume || 0)
      };
      
      // Safety: Ensure time and prices are valid
      if (isNaN(candleObj.time) || candleObj.time <= 0 || candleObj.close <= 0) return;

      if (candleData.length > 0) {
        const last = candleData[candleData.length - 1];
        if (last.time === candleObj.time) {
          candleData[candleData.length - 1] = candleObj;
        } else if (candleObj.time > last.time) {
          candleData.push(candleObj);
        }
      } else {
        candleData.push(candleObj);
      }

      candleSeries.update(candleObj);
      updateSeriesPrecision(candleObj.close); // Force precision sync in real-time
      window.lastCandleTime = candleObj.time;
      updateCandleCountdown();
      
      if (candle.volume != null && isFinite(Number(candle.volume))) {
          const isUp = candleObj.close >= candleObj.open;
          volumeSeries.update({
            time: candleObj.time,
            value: Number(candle.volume),
            color: isUp ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)'
          });
      }
    } catch(e) { console.warn('candleSeries.update error:', e.message); }
  }

  // Indicators update
  if (candleData.length === 0) return;

  const indicators = msg.indicators_update || msg.indicators;
  if (indicators) {
    try {
      // RSI
      let rsiPoint = null;
      const rsiRaw = indicators.rsi;
      if (rsiRaw) {
        if (Array.isArray(rsiRaw) && rsiRaw.length > 0) {
          const last = rsiRaw[rsiRaw.length - 1];
          if (last.time != null && last.value != null && isFinite(Number(last.value))) {
            const t = Math.floor(Number(last.time));
            if (!isNaN(t) && t > 0) rsiPoint = { time: t, value: Number(last.value) };
          }
        } else if (rsiRaw.time != null && rsiRaw.value != null && isFinite(Number(rsiRaw.value))) {
          const t = Math.floor(Number(rsiRaw.time));
          if (!isNaN(t) && t > 0) rsiPoint = { time: t, value: Number(rsiRaw.value) };
        }
      }
      if (rsiPoint) rsiSeries.update(rsiPoint);

      // Stochastic K
      let stochKPoint = null;
      const kRaw = indicators.stoch_k;
      if (kRaw) {
        if (Array.isArray(kRaw) && kRaw.length > 0) {
          const last = kRaw[kRaw.length - 1];
          if (last.time != null && last.value != null && isFinite(Number(last.value))) {
            const t = Math.floor(Number(last.time));
            if (!isNaN(t) && t > 0) stochKPoint = { time: t, value: Number(last.value) };
          }
        } else if (kRaw.time != null && kRaw.value != null && isFinite(Number(kRaw.value))) {
          const t = Math.floor(Number(kRaw.time));
          if (!isNaN(t) && t > 0) stochKPoint = { time: t, value: Number(kRaw.value) };
        }
      }
      if (stochKPoint) stochKSeries.update(stochKPoint);

      // Stochastic D
      let stochDPoint = null;
      const dRaw = indicators.stoch_d;
      if (dRaw) {
        if (Array.isArray(dRaw) && dRaw.length > 0) {
          const last = dRaw[dRaw.length - 1];
          if (last.time != null && last.value != null && isFinite(Number(last.value))) {
            const t = Math.floor(Number(last.time));
            if (!isNaN(t) && t > 0) stochDPoint = { time: t, value: Number(last.value) };
          }
        } else if (dRaw.time != null && dRaw.value != null && isFinite(Number(dRaw.value))) {
          const t = Math.floor(Number(dRaw.time));
          if (!isNaN(t) && t > 0) stochDPoint = { time: t, value: Number(dRaw.value) };
        }
      }
      if (stochDPoint) stochDSeries.update(stochDPoint);

    } catch(e) { 
        // Silently skip if error occurs, but we've already done most checks
    }
  }
}

// --- SYNC ENGINE ---

mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range) return;

    // --- INFINITE SCROLL ENGINE ---
    // Disparar cuando quedan PREFETCH_THRESHOLD velas a la izquierda
    if (!prefetchInFlight && hasMoreData && range.from <= PREFETCH_THRESHOLD) {
        // Debounce: no disparar si el usuario sigue scrolleando rápido
        clearTimeout(prefetchTimer);
        prefetchTimer = setTimeout(() => {
            // Segunda verificación dentro del timeout (el usuario puede haber parado)
            const currentRange = mainChart.timeScale().getVisibleLogicalRange();
            if (!currentRange || currentRange.from > PREFETCH_THRESHOLD) return;
            if (prefetchInFlight || !hasMoreData) return;

            const oldestCandle = candleData[0];
            if (!oldestCandle || !window.socket || window.socket.readyState !== WebSocket.OPEN) return;

            prefetchInFlight = true;
            console.debug(`[Prefetch] Requesting ${PREFETCH_BATCH} candles before ${oldestCandle.time}`);

            window.socket.send(JSON.stringify({
                type: 'load_more',
                instrument: currentInstrument,
                timeframe: currentTimeframe,
                before_time: oldestCandle.time,
                count: PREFETCH_BATCH
            }));

            // Safety timeout: si en 8s no llega respuesta, desbloquear
            setTimeout(() => {
                if (prefetchInFlight) {
                    console.warn('[Prefetch] Timeout — unlocking');
                    prefetchInFlight = false;
                    isLoadingMore = false;
                }
            }, 8000);
        }, 80); // 80ms debounce
    }

    // --- CHART SYNC ---
    if (isUpdating) return;
    isUpdating = true;
    try {
        if (rsiChart) safeSetRange(rsiChart.timeScale(), range);
        if (stochChart) safeSetRange(stochChart.timeScale(), range);
    } catch(e) {}
    isUpdating = false;
});

[rsiChart, stochChart].forEach(c => {
    c.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (isUpdating || !range) return;
        isUpdating = true;
        try {
            safeSetRange(mainChart.timeScale(), range);
            allCharts.filter(other => other !== mainChart && other !== c).forEach(other => {
                safeSetRange(other.timeScale(), range);
            });
        } catch(e) {}
        isUpdating = false;
    });
});

allCharts.forEach((chart) => {
    chart.subscribeCrosshairMove(param => {
        if (isUpdating) return;
        isUpdating = true;
        try {
            if (!param || !param.time || !param.point) {
                allCharts.forEach(c => c.clearCrosshairPosition());
                return;
            }
            
            const time = param.time;
            
            allCharts.forEach(c => {
                if (c !== chart) {
                    let series = null;
                    if (c === mainChart) series = candleSeries;
                    else if (c === rsiChart) series = rsiSeries;
                    else if (c === stochChart) series = stochKSeries;
                    
                    if (series) {
                        try {
                            c.setCrosshairPosition(null, time, series);
                        } catch(e) {}
                    }
                }
            });
        } finally {
            isUpdating = false;
        }
    });
});

// --- UI EVENT LISTENERS ---

const symbolSearch = document.getElementById('symbol-search');
const instrLabel = document.getElementById('instr-label');

if (symbolSearch) {
    symbolSearch.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const symbol = symbolSearch.value.trim().toUpperCase();
            if (symbol) {
                const newTab = { id: Date.now(), symbol: symbol, timeframe: window.currentTimeframe };
                window.tabs.push(newTab);
                switchTab(newTab.id);
                symbolSearch.value = '';
                symbolSearch.blur();
            }
        }
    });
}

function updateTimeframeUI(tf) {
    if (!tf) return;
    window.currentTimeframe = tf;
    const tab = window.tabs.find(t => t.id === window.activeTabId);
    if (tab) {
        tab.timeframe = tf;
        saveSession();
    }
    const provider = tab.symbol.includes('_') ? 'OANDA' : 'BINANCE';
    const displaySymbol = tab.symbol.replace('_', '/');
    
    if (instrLabel) {
        instrLabel.innerText = `${displaySymbol} · ${tf.replace('M', '').replace('H', 'h')} · ${provider}`;
    }
    
    // No title for axis (User requested removal)
    if (window.candleSeries) {
        window.candleSeries.applyOptions({ title: '' });
    }

    const activeInstrumentLabel = document.getElementById('active-instrument-label');
    if (activeInstrumentLabel) {
        activeInstrumentLabel.textContent = displaySymbol;
    }
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tf') === tf);
    });
}

window.addEventListener('resize', () => {
    const mainEl = document.getElementById('main-chart');
    if (!mainEl) return;
    const w = mainEl.clientWidth;
    mainChart.resize(w, mainEl.clientHeight);
    
    // REINFORCE: Ensure scale width is stable during resize
    mainChart.priceScale('right').applyOptions({ minimumWidth: 75 });
    
    const rsiEl = document.getElementById('rsi-chart');
    if (rsiEl && rsiEl.clientHeight > 0) {
        rsiChart.resize(w, rsiEl.clientHeight);
        rsiChart.priceScale('right').applyOptions({ minimumWidth: 75 });
    }
    
    const stochEl = document.getElementById('stoch-chart');
    if (stochEl && stochEl.clientHeight > 0) {
        stochChart.resize(w, stochEl.clientHeight);
        stochChart.priceScale('right').applyOptions({ minimumWidth: 75 });
    }
});

// --- WINDOW DRAG ---

const dragSpacer = document.getElementById('drag-spacer');
let isMovingWindow = false;
let startX, startY, winStartX, winStartY;

dragSpacer.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    isMovingWindow = true;
    startX = e.screenX; startY = e.screenY;
    if (window.pywebview && pywebview.api) {
        const pos = await pywebview.api.get_position();
        winStartX = pos[0]; winStartY = pos[1];
    }
});

window.addEventListener('mousemove', (e) => {
    if (!isMovingWindow) return;
    const deltaX = e.screenX - startX;
    const deltaY = e.screenY - startY;
    if (window.pywebview && pywebview.api) {
        pywebview.api.move_window(winStartX + deltaX, winStartY + deltaY);
    }
});

window.addEventListener('mouseup', () => isMovingWindow = false);

const addTabBtn = document.getElementById('add-tab');
if (addTabBtn) addTabBtn.onclick = () => {
    if (typeof openSymbolSearch === 'function') openSymbolSearch();
    else if (symbolSearch) symbolSearch.focus();
};

renderTabs();
window.addEventListener('load', () => {
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 500);
});

window.updateChartsHistory = updateChartsHistory;
window.updateChartsLive = updateChartsLive;
window.updateTimeframeUI = updateTimeframeUI;
window.updatePriceDisplay = updatePriceDisplay;
window.resetAllCharts = resetAllCharts;
window.updateCandleCountdown = updateCandleCountdown;

function timeframeToSeconds(tf) {
  const m = tf.match(/(\d+)?([mshdwMSHDW])(\d+)?/);
  if (!m) return 300;
  const val = parseInt(m[1] || m[3]) || 1;
  const unit = m[2].toUpperCase();
  switch (unit) {
    case 'S': return val;
    case 'M': return val * 60;
    case 'H': return val * 3600;
    case 'D': return val * 86400;
    case 'W': return val * 604800;
    default: return 300;
  }
}

function removeCountdownPriceLine() {
    if (window.countdownPriceLine) {
        try { candleSeries.removePriceLine(window.countdownPriceLine); } catch(e) {}
        window.countdownPriceLine = null;
    }
}
window.removeCountdownPriceLine = removeCountdownPriceLine;

function updateCandleCountdown() {
  if (isBacktestActive()) {
    removeCountdownPriceLine();
    return;
  }
  
  // 1. Garantizar sincronización base
  if (!window.masterClockSync) {
      window.masterClockSync = { server: Date.now() / 1000, local: performance.now() / 1000 };
  }
  
  if (!currentTimeframe || !candleData.length) return;
  
  // 2. Calcular tiempo actual sincronizado
  const nowLocal = performance.now() / 1000;
  const nowServer = window.masterClockSync.server + (nowLocal - window.masterClockSync.local);
  const duration = timeframeToSeconds(currentTimeframe);
  
  // 3. Lógica de Módulo (Estándar TradingView)
  const timeLeft = duration - (nowServer % duration);
  const displaySeconds = Math.max(0, Math.floor(timeLeft));

  let countdownStr = "";
  if (displaySeconds >= 3600) {
      const h = Math.floor(displaySeconds / 3600);
      const m = Math.floor((displaySeconds % 3600) / 60);
      const s = displaySeconds % 60;
      countdownStr = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  } else {
      const m = Math.floor(displaySeconds / 60);
      const s = displaySeconds % 60;
      countdownStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  
  if (window.currentCountdown !== countdownStr) {
    window.currentCountdown = countdownStr;
  }
  // Borrar línea manual antigua si todavía existe por algún motivo
  removeCountdownPriceLine();
}

function updatePriceDisplay(tick) {
  if (!tick) return;
  const priceEl = document.getElementById('last-price');
  if (priceEl) {
    const price = Number(tick.value || tick.close || 0);
    priceEl.textContent = price.toFixed(5);
    const prevPrice = parseFloat(priceEl.dataset.prev) || price;
    priceEl.style.color = price >= prevPrice ? '#26a69a' : '#ef5350';
    priceEl.dataset.prev = price;
  }
}

setInterval(updateCandleCountdown, 1000);

// Observer para redimensionar cuando aparece la barra de backtest (Corrige el "padding" visual)
const btBar = document.getElementById('backtest-replay-bar');
if (btBar) {
    const observer = new MutationObserver(() => {
        window.dispatchEvent(new Event('resize'));
    });
    observer.observe(btBar, { attributes: true, attributeFilter: ['style'] });
}

// REFUERZO VISUAL AGRESIVO PARA MODO BACKTEST (Garantiza que nada residual aparezca)
setInterval(() => {
    if (isBacktestActive()) {
        // Borrar línea de cuenta regresiva residual si existe
        if (window.countdownPriceLine) {
            try { 
                candleSeries.removePriceLine(window.countdownPriceLine); 
                window.countdownPriceLine = null;
            } catch(e) {}
        }
        // Forzar desactivación de etiquetas de precio y líneas nativas
        if (window.candleSeries) {
            candleSeries.applyOptions({
                priceLineVisible: false,
                lastValueVisible: false,
                countdownVisible: false
            });
        }
        if (window.volumeSeries) {
            volumeSeries.applyOptions({
                priceLineVisible: false,
                lastValueVisible: false
            });
        }
    }
}, 100);

// --- INITIAL UI SYNC ---
setTimeout(() => {
    if (typeof renderTabs === 'function') renderTabs();
    // updateTimeframeUI se llama dentro de handleSessionRestored cuando llega el mensaje
}, 200);
