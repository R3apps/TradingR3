const backtestState = {
  active: false,
  currentIndex: 0,
  totalCandles: 0,
  isPlaying: false,
  speed: 1,
  balance: 10000,
  initialBalance: 10000,
  openTrades: [],
  closedTrades: [],
  tradePriceLines: {},   // { trade_id: { entry, sl, tp } }
  selectedTradeId: null,
  isInitialLoad: true,
  globalOffset:       0,      // velas que hay ANTES de la ventana en all_candles
  hasMoreHistory:     false,  // si el backend tiene velas más antiguas
  isLoadingHistory:   false,  // anti-duplicado de peticiones
};
window.backtestState = backtestState;

let _btSyncLock    = false;
let _btRsiData     = [];
let _btStochKData  = [];
let _btStochDData  = [];
let preBacktestState = null;

function enterBacktestMode() {
  backtestState.active = true;
  window.backtestActive = true; // Bloquear live updates inmediatamente al entrar
  window.currentCountdown = ''; // Limpiar countdown del live

  // 1. Snapshot del estado Live ANTES de cualquier cambio
  preBacktestState = {
    symbol: window.currentInstrument,
    timeframe: window.currentTimeframe,
    tabId: window.activeTabId,
    tabs: JSON.parse(JSON.stringify(window.tabs || []))
  };

  // 2. Aislar interfaz: Mostrar solo la pestaña de Backtest
  window.tabs = [{
      id: 'backtest-temp-tab',
      symbol: document.getElementById('bt-config-instrument').value || window.currentInstrument,
      timeframe: window.currentTimeframe
  }];
  window.activeTabId = 'backtest-temp-tab';
  if (window.renderTabs) renderTabs();
  
  // Wipe drawing layer immediately to avoid seeing live drawings in backtest config/session
  if (typeof drawingState !== 'undefined') {
    drawingState.objects = [];
    drawingState.activeObjId = null;
    if (window.updateObjectTree) updateObjectTree();
  }

  // Reset UI loading state on open
  const container = document.getElementById('bt-loading-container');
  if (container) container.style.display = 'none';

  const barModal = document.getElementById('bt-progress-fill');
  const infoModal = document.getElementById('bt-loading-percent');
  if (barModal) barModal.style.width = '0%';
  if (infoModal) infoModal.innerText = '0%';
  
  document.getElementById('backtest-config-modal').style.display = 'flex';
  const priceDisp = document.getElementById('price-display');
  if (priceDisp) priceDisp.style.display = 'none';
  
  // Update UI if needed
  const btn = document.getElementById('btn-backtest');
  if (btn) {
    btn.style.background = '#FF6D00';
    btn.style.color = 'white';
    btn.textContent = 'EXIT BACKTEST';
  }
  
  if (typeof window.updateCandleCountdown === 'function') {
    window.updateCandleCountdown();
  }

  // Force visual cleanup of series options immediately
  if (window.candleSeries) {
    candleSeries.applyOptions({
      priceLineVisible: false,
      lastValueVisible: false,
      countdownVisible: false,
      title: ''
    });
  }
}

function exitBacktestMode() {
  backtestState.active = false;
  backtestState.isPlaying = false;
  backtestState.openTrades = [];
  backtestState.closedTrades = [];
  backtestState.isInitialLoad = true; // Reset para la próxima sesión
  window.backtestActive = false;      // ¡CRUCIAL: Apagar flag global!
  
  // Reset drawing reference only (DO NOT wipe objects to prevent accidental deletion)
  if (window.resetDrawingReference) resetDrawingReference();
  clearAllPriceLines();
  
  // UI Reset
  const replayBar = document.getElementById('backtest-replay-bar');
  if (replayBar) replayBar.style.display = 'none';
  
  const orderPanel = document.getElementById('backtest-order-panel');
  if (orderPanel) orderPanel.style.display = 'none';
  
  const historyPanel = document.getElementById('backtest-history-panel');
  if (historyPanel) historyPanel.style.display = 'none';
  
  const loadingContainer = document.getElementById('bt-loading-container');
  if (loadingContainer) loadingContainer.style.display = 'none';
  
  const configSpinner = document.getElementById('config-spinner');
  if (configSpinner) configSpinner.style.display = 'none';
  
  const startBtn = document.getElementById('config-start-btn');
  if (startBtn) startBtn.disabled = false;
  
  const exitPriceUI = document.getElementById('price-display');
  if (exitPriceUI) exitPriceUI.style.display = 'flex';
  
  const exitBtn = document.getElementById('btn-backtest');
  if (exitBtn) {
    exitBtn.style.background = 'transparent';
    exitBtn.style.color = '#787B86';
    exitBtn.textContent = 'BACKTEST';
  }
  
  if (window.socket && window.socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'backtest_stop' }));
    
    // RESTAURACIÓN CRUCIAL DE PESTAÑAS
    if (preBacktestState) {
      window.tabs = JSON.parse(JSON.stringify(preBacktestState.tabs));
      window.activeTabId = preBacktestState.tabId;
      window.currentInstrument = preBacktestState.symbol;
      window.currentTimeframe = preBacktestState.timeframe;
      
      // Limpiar rastro de backtest de la variable preBacktestState
      preBacktestState = null;

      // Forzar reconstrucción de la UI
      if (window.renderTabs) renderTabs();
      if (window.updateTimeframeUI) updateTimeframeUI(window.currentTimeframe);
      const instrBtn = document.getElementById('active-instrument-label');
      if (instrBtn) instrBtn.textContent = window.currentInstrument.replace('_', '/');
      
      // FIX ZOOM BUG: Limpiar datos y forzar encuadre
      if (window.mainChart) {
          window.mainChart.timeScale().scrollToRealTime();
          setTimeout(() => {
              window.mainChart.timeScale().fitContent();
          }, 100);
      }
    }

    socket.send(JSON.stringify({ 
      type: 'subscribe', 
      instrument: window.currentInstrument, 
      timeframe: window.currentTimeframe 
    }));
  }
  
  window.dispatchEvent(new Event('resize'));
}

function toggleBacktestMode() {
  if (backtestState.active) {
    exitBacktestMode();
  } else {
    enterBacktestMode();
  }
}

window.toggleBacktestMode = toggleBacktestMode;
window.enterBacktestMode = enterBacktestMode;
window.exitBacktestMode = exitBacktestMode;
window.handleBacktestLoaded = handleBacktestLoaded;
window.handleReplayBatch = handleReplayBatch;
window.handleReplayCandle = handleReplayCandle;
window.handleBacktestProgress = handleBacktestProgress;
window.handleBacktestCancelled = handleBacktestCancelled;
window.handleTradeOpened = handleTradeOpened;
window.handleTradeClosed = handleTradeClosed;
window.handleBacktestHistoricalPrepend = handleBacktestHistoricalPrepend;

function startBacktest() {
  const instrument = document.getElementById('bt-config-instrument').value || currentInstrument;
  const timeframe = currentTimeframe;
  const from_date_el = document.getElementById('bt-manual-date-input');
  const from_date = from_date_el ? from_date_el.value : '';
  const balance = parseFloat(document.getElementById('config-balance').value) || 10000;
  
  // Bloquear inmediatamente cualquier actualización del Live
  backtestState.active = true;
  window.backtestActive = true;

  if (!from_date) {
    if (window.showNotification) showNotification('Por favor seleccione una fecha de inicio', 'error');
    // Si falla, restaurar flags (aunque técnicamente estaríamos aún en el modal)
    backtestState.active = false;
    window.backtestActive = false;
    return;
  }

  // UI Loading State
  document.getElementById('config-spinner').style.display = 'none';
  document.getElementById('bt-loading-container').style.display = 'block';
  document.getElementById('bt-progress-fill').style.width = '0%';
  document.getElementById('bt-loading-percent').textContent = '0%';
  document.getElementById('config-start-btn').disabled = true;

  // LIMPIEZA INMEDIATA DEL GRÁFICO (EVITAR VER EL PRESENTE)
  if (window.candleSeries) {
    candleSeries.setData([]);
    candleSeries.applyOptions({
      priceLineVisible: false,
      lastValueVisible: false,
      countdownVisible: false,
      title: ''
    });
    // Forzar eliminación de líneas de precio manuales (como la de la cuenta atrás)
    if (window.removeCountdownPriceLine) window.removeCountdownPriceLine();
  }
  
  if (window.updateCandleCountdown) window.updateCandleCountdown();
  
  if (window.volumeSeries) {
    volumeSeries.setData([]);
    volumeSeries.applyOptions({ priceLineVisible: false, lastValueVisible: false });
  }
  if (window.rsiSeries) rsiSeries.setData([]);
  if (window.stochKSeries) stochKSeries.setData([]);
  if (window.stochDSeries) stochDSeries.setData([]);
  
  backtestState.isInitialLoad = true;
  backtestState.initialBalance = balance;
  backtestState.balance = balance;
  
  console.log(`[Backtest] Starting with instrument: ${instrument}, from: ${from_date}`);

  socket.send(JSON.stringify({ 
    type: 'backtest_start', 
    instrument, 
    timeframe, 
    from_date, 
    balance 
  }));
}

function cancelBacktestLoading() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'backtest_cancel_load' }));
  }
  // Reset UI immediately
  document.getElementById('bt-loading-container').style.display = 'none';
  document.getElementById('config-start-btn').disabled = false;
  document.getElementById('bt-progress-fill').style.width = '0%';
  
  // Cerrar modal y volver a modo normal
  document.getElementById('backtest-config-modal').style.display = 'none';
  exitBacktestMode();
}

function handleBacktestProgress(msg) {
  const percent = msg.percent || 0;
  const fill = document.getElementById('bt-progress-fill');
  const text = document.getElementById('bt-loading-percent');
  const status = document.getElementById('bt-loading-status');
  
  if (fill) fill.style.width = percent + '%';
  if (text) text.textContent = percent + '%';
  if (status) status.textContent = `VELAS: ${msg.total.toLocaleString()}`;
}

function handleBacktestCancelled() {
  document.getElementById('bt-loading-container').style.display = 'none';
  document.getElementById('config-start-btn').disabled = false;
  console.log("Backtest loading cancelled.");
}

function handleBacktestLoaded(msg) {
  document.getElementById('bt-loading-container').style.display = 'none';
  document.getElementById('config-spinner').style.display = 'none';
  document.getElementById('config-start-btn').disabled = false;
  document.getElementById('backtest-config-modal').style.display = 'none';
  
  // Reforzar estado activo
  backtestState.active = true;
  window.backtestActive = true;
  backtestState.totalCandles = msg.total_candles;
  backtestState.allCandles = []; // Limpiar para el nuevo lote
  
  if (window.updateCandleCountdown) window.updateCandleCountdown();
  
  document.getElementById('backtest-replay-bar').style.display = 'flex';
  document.getElementById('backtest-order-panel').style.display = 'flex';
  document.getElementById('backtest-history-panel').style.display = 'flex';
  
  // AISLAMIENTO TOTAL: Reemplazar todas las pestañas por una única de backtest
  window.currentInstrument = msg.instrument;
  window.currentTimeframe = msg.timeframe;
  window.tabs = [{
      id: 'backtest-temp-tab',
      symbol: msg.instrument,
      timeframe: msg.timeframe
  }];
  window.activeTabId = 'backtest-temp-tab';
  
  // Actualizar UI de cabecera y pestañas
  if (typeof updateTimeframeUI === 'function') updateTimeframeUI(msg.timeframe);
  if (typeof renderTabs === 'function') renderTabs();
  
  // Foco automático en la última vela (evita ver miles de velas minúsculas)
  if (window.mainChart) {
      window.mainChart.timeScale().scrollToRealTime();
  }
  
  document.getElementById('replay-instrument-info').textContent = 
    `${msg.instrument} ${msg.timeframe} · ${msg.total_candles} velas desde ${msg.from_date}`;
    
  updateTimelineSlider();

  // Trigger resize to adapt to the new replay bar
  window.dispatchEvent(new Event('resize'));
  if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();

  // Limpieza visual profunda para modo backtest
  if (window.candleSeries) {
    candleSeries.applyOptions({
      priceLineVisible: false,
      lastValueVisible: false,
      countdownVisible: false,
      title: ''
    });
  }
}

function showLoadingOverlay() {
  const overlay = document.getElementById('backtest-loading-overlay');
  if (overlay) overlay.style.display = 'flex';
  const prog = document.getElementById('loading-progress');
  if (prog) prog.innerText = '0%';
  const det = document.getElementById('loading-count');
  if (det) det.innerText = 'Buscando velas...';
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('backtest-loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

function handleBacktestProgress(data) {
  // 1. Actualizar Overlay (Cristal)
  const progOverlay = document.getElementById('loading-progress');
  if (progOverlay) progOverlay.innerText = `${data.percent || 0}%`;
  
  const detOverlay = document.getElementById('loading-count');
  if (detOverlay && data.count !== undefined) {
    detOverlay.innerText = `${data.count.toLocaleString()} velas recibidas`;
  }

  // 2. Actualizar Modal (Configuración)
  const container = document.getElementById('bt-loading-container');
  if (container) container.style.display = 'block';

  const barModal = document.getElementById('bt-progress-fill');
  const infoModal = document.getElementById('bt-loading-percent');
  
  if (barModal) barModal.style.width = `${data.percent || 0}%`;
  if (infoModal) infoModal.innerText = `${data.percent || 0}%`;
}

function initBacktestReplay(config) {
  showLoadingOverlay();
  // Clear any existing session ...
  if (typeof candleSeries !== 'undefined') candleSeries.setData([]);
  if (typeof volumeSeries !== 'undefined') volumeSeries.setData([]);
  if (typeof rsiSeries !== 'undefined') rsiSeries.setData([]);
  if (typeof stochKSeries !== 'undefined') stochKSeries.setData([]);
  if (typeof stochDSeries !== 'undefined') stochDSeries.setData([]);
  
  if (typeof candleData !== 'undefined') {
    candleData.length = 0; // Faster wipe
  }
  
  window.lastCandleTime = null;
  
  const payload = {
    type: 'init_backtest',
    instrument: currentInstrument,
    timeframe: config.timeframe || currentTimeframe,
    start_date: config.startDate,
    end_date: config.endDate,
    initial_balance: config.initialBalance
  };
  window.socket.send(JSON.stringify(payload));
  hideAllModals();
}

function handleReplayCandle(msg) {
  if (!backtestState.active) return;
  // console.log("[BT] Candle received:", msg.current_index);
  
  const candle = msg.candle;
  if (candle && candle.time != null && isFinite(Number(candle.close))) {
    const cleanCandle = {
      time: Number(candle.time), // Enforce number
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close)
    };
    
    // Safety check: Don't update if time is zero or NaN
    if (isNaN(cleanCandle.time) || cleanCandle.time <= 0) return;

    try {
      // Avoid "Cannot update oldest data" error: only update if time is >= last update
      if (window.lastCandleTime !== null && cleanCandle.time < window.lastCandleTime && backtestState.isPlaying) {
         // Silently ignore out-of-order updates during replay transitions
         return;
      }
      
      candleSeries.update(cleanCandle);
      window.lastCandleTime = Number(cleanCandle.time);
      
      // Update volume
      const volValue = Number(candle.volume || 0);
      const color = cleanCandle.close >= cleanCandle.open ? '#26a69a80' : '#ef535080';
      volumeSeries.update({ 
        time: cleanCandle.time, 
        value: isFinite(volValue) ? volValue : 0, 
        color: color 
      });

      // Synchronize candleData for drawing engine (IMPORTANT: use window reference)
      if (typeof window.candleData !== 'undefined') {
        const last = window.candleData.length > 0 ? window.candleData[window.candleData.length - 1] : null;
        if (last && last.time === cleanCandle.time) {
          window.candleData[window.candleData.length - 1] = { ...cleanCandle, volume: volValue };
        } else if (!last || cleanCandle.time > last.time) {
          window.candleData.push({ ...cleanCandle, volume: volValue });
        }
      }
      
      // Update indicators with strict validation
      if (msg.indicators) {
        if (msg.indicators.rsi && msg.indicators.rsi.time != null && msg.indicators.rsi.value != null) {
          try { rsiSeries.update({ time: msg.indicators.rsi.time, value: Number(msg.indicators.rsi.value) }); } catch(e) {}
        }
        if (msg.indicators.stoch_k && msg.indicators.stoch_k.time != null && msg.indicators.stoch_k.value != null) {
          try { stochKSeries.update({ time: msg.indicators.stoch_k.time, value: Number(msg.indicators.stoch_k.value) }); } catch(e) {}
        }
        if (msg.indicators.stoch_d && msg.indicators.stoch_d.time != null && msg.indicators.stoch_d.value != null) {
          try { stochDSeries.update({ time: msg.indicators.stoch_d.time, value: Number(msg.indicators.stoch_d.value) }); } catch(e) {}
        }
      }
    } catch(e) { console.warn("Error updating replay candle:", e); }
  }
  
  // Actualizar estado local (SIEMPRE local al gráfico)
  const localIdx = msg.current_index - (backtestState.globalOffset || 0);
  backtestState.currentIndex = localIdx;
  backtestState.balance = msg.balance;
  
  // Auto-desplazar el gráfico si estamos reproduciendo
  if (backtestState.isPlaying) {
    centerChartOnIndex(msg.current_index);
  }
  
  // Sincronizar trades (por si hubo SL/TP)
  if (msg.open_trades) {
    try {
      const closedCount = backtestState.openTrades.length - msg.open_trades.length;
      if (closedCount > 0) {
        clearOrderInputs();
        syncTradePriceLines(msg.open_trades);
        showNotification("Operación cerrada por SL/TP", "info");
      }
      backtestState.openTrades = msg.open_trades;
    } catch(e) { console.warn("Error syncing trades:", e); }
  }
  if (msg.closed_trades) {
    backtestState.closedTrades = msg.closed_trades;
    updateTradeHistoryTable();
  }

  updateOrderPanel();
  updateStatsPanel(msg.stats);
  
  const posEl = document.getElementById('replay-position');
  if (posEl) posEl.innerText = `${msg.current_index + 1} / ${msg.total}`;
}

// Eliminado handleBacktestLoaded duplicado para evitar conflictos de lógica

function handleBacktestCancelled(msg) {
  hideLoadingOverlay();
  showNotification('Carga cancelada', 'info');
}

function handleReplayBatch(msg) {
  // Ocultar overlay si el primer batch llega
  if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
  
  // ACTIVACIÓN DE ESTADO INMEDIATA (SOLUCIONA BLOQUEO DE PLAY)
  if (!window.backtestState) window.backtestState = {};
  backtestState.active = true;
  window.backtestActive = true;
  if (window.updateCandleCountdown) window.updateCandleCountdown();

  const validCandles = [];
  // Soporte para lotes (msg.candles) o vela única (msg.candle)
  const incoming = msg.candles || (msg.candle ? [msg.candle] : []);
  
  if (Array.isArray(incoming)) {
    for (let i = 0; i < incoming.length; i++) {
        const c = incoming[i];
        const t = Math.floor(Number(c.time));
        if (!isNaN(t) && t > 0) {
            validCandles.push({
                time: t,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: Number(c.volume || 0)
            });
        }
    }
  }

      // 1. GESTIÓN DE CARGA MASIVA (INICIO O CAMBIO DE TEMPORALIDAD)
  if (validCandles.length > 50) {
      // Limpiar price lines de live antes de cargar datos de backtest
      if (typeof removeCountdownPriceLine === 'function') removeCountdownPriceLine();
      if (window.countdownPriceLine) {
          try { candleSeries.removePriceLine(window.countdownPriceLine); } catch(e) {}
          window.countdownPriceLine = null;
      }

      // Si es cambio de temporalidad: reset completo igual que sesión nueva
      if (msg.is_tf_change) {
          // Eliminar price line del countdown ANTES de limpiar la serie
          // para evitar que lightweight-charts la restaure al hacer setData
          if (typeof removeCountdownPriceLine === 'function') removeCountdownPriceLine();
          if (window.countdownPriceLine) {
              try { candleSeries.removePriceLine(window.countdownPriceLine); } catch(e) {}
              window.countdownPriceLine = null;
          }

          // Limpiar estado de paginación
          backtestState.globalOffset    = 0;
          backtestState.hasMoreHistory  = false;
          backtestState.isLoadingHistory = false;
          window._btRsiData    = [];
          window._btStochKData = [];
          window._btStochDData = [];
          window.candleData    = [];
          // Desuscribir listeners del TF anterior
          if (window._btHistoryScrollUnsub) {
              try { window._btHistoryScrollUnsub(); } catch(e) {}
              window._btHistoryScrollUnsub = null;
          }
          if (window._backtestSyncUnsub) {
              try { window._backtestSyncUnsub(); } catch(e) {}
              window._backtestSyncUnsub = null;
          }
          // Limpiar series visuales
          try { if (window.candleSeries)  candleSeries.setData([]); }  catch(e) {}
          try { if (window.volumeSeries)  volumeSeries.setData([]); }  catch(e) {}
          try { if (window.rsiSeries)     rsiSeries.setData([]); }     catch(e) {}
          try { if (window.stochKSeries)  stochKSeries.setData([]); }  catch(e) {}
          try { if (window.stochDSeries)  stochDSeries.setData([]); }  catch(e) {}
      }

      backtestState.allCandles = [...validCandles];

      // El backend ya manda el índice LOCAL correcto dentro de la ventana
      let focusIndex = msg.current_index || 0;
      backtestState.globalOffset    = msg.global_offset    || 0;
      backtestState.hasMoreHistory  = msg.has_more_history || false;
      backtestState.totalCandles    = msg.total            || validCandles.length;
      // NO buscar por target_date — el backend ya calculó el índice correcto

      backtestState.currentIndex = focusIndex;
      
      // IMPORTANTE: Solo mostramos hasta el focusIndex. El resto es "el futuro"
      const historyToSet = validCandles.slice(0, focusIndex + 1);

      // Cargar datos en las series y desactivar líneas de precio/etiquetas (limpieza visual total)
      if (window.candleSeries) {
          candleSeries.applyOptions({
              priceLineVisible: false,
              lastValueVisible: false,
              title: ''
          });
          candleSeries.setData(historyToSet);
          
          // AUTO-CENTRADO: Ir a la última vela cargada
          mainChart.timeScale().scrollToRealTime();

          if (window.updateSeriesPrecision && historyToSet.length > 0) {
              updateSeriesPrecision(historyToSet[historyToSet.length - 1].close);
          }
      }
      if (window.volumeSeries) {
          volumeSeries.applyOptions({
              lastValueVisible: false,
              priceLineVisible: false
          });
          volumeSeries.setData(historyToSet.map(c => ({
              time: Number(c.time),
              value: Number(c.volume || 0),
              color: c.close >= c.open ? '#26a69a80' : '#ef535080'
          })));
      }

      // Procesar indicadores con timestamps normalizados
      const source = msg.all_indicators || msg.indicators || {};
      const eS2 = (t) => (t > 10000000000 ? Math.floor(t / 1000) : Math.floor(t));
      const fInd = (arr) => {
          if (!Array.isArray(arr)) return [];
          return arr
              .filter(d => d && d.value != null && isFinite(Number(d.value)))
              .map(d => ({ time: eS2(Number(d.time)), value: Number(d.value) }))
              .filter(d => d.time > 0);
      };
      window._btRsiData    = fInd(source.rsi    || []);
      window._btStochKData = fInd(source.stoch_k || []);
      window._btStochDData = fInd(source.stoch_d || []);

      if (window.rsiSeries    && window._btRsiData.length)    rsiSeries.setData(window._btRsiData);
      if (window.stochKSeries && window._btStochKData.length)  stochKSeries.setData(window._btStochKData);
      if (window.stochDSeries && window._btStochDData.length)  stochDSeries.setData(window._btStochDData);

      // Guardar velas en candleData global
      window.candleData = [...historyToSet];

      // Forzar resize de todos los charts para que ocupen el espacio correcto
      const forceResize = () => {
          try {
              const mainEl  = document.getElementById('main-chart');
              const rsiEl   = document.getElementById('rsi-chart');
              const stochEl = document.getElementById('stoch-chart');
              const w = mainEl ? mainEl.clientWidth : 0;
              if (w > 0) {
                  mainChart.resize(w, mainEl.clientHeight || 500);
                  if (rsiEl && rsiEl.clientHeight > 0)   rsiChart.resize(w, rsiEl.clientHeight);
                  if (stochEl && stochEl.clientHeight > 0) stochChart.resize(w, stochEl.clientHeight);
              }
          } catch(e) {}
          updateTimelineSlider();
      };
      setTimeout(forceResize, 100);

      // Posicionar DESPUÉS del resize (200ms y 600ms como respaldo)
      syncAndFocusSimulation(focusIndex);
      initBacktestHistoryScroll();
      
  } else if (validCandles.length > 0) {
      // 2. GESTIÓN DE REPRODUCCIÓN (LOTE PEQUEÑO)
      const getLastTime = () => {
          if (window.candleData && window.candleData.length > 0) {
              return window.candleData[window.candleData.length - 1].time;
          }
          return 0;
      };
      
      const lastTime = getLastTime();

      validCandles.forEach(c => {
          // SOLO ACTUALIZAR SI ES EL PRESENTE O FUTURO
          if (c.time >= lastTime) {
              try {
                  candleSeries.update(c);
                  if (window.updateSeriesPrecision) updateSeriesPrecision(c.close);
                  const col = c.close >= c.open ? '#26a69a80' : '#ef535080';
                  volumeSeries.update({ time: c.time, value: c.volume, color: col });
                  
                  if (typeof candleData !== 'undefined') {
                      const last = candleData.length > 0 ? candleData[candleData.length - 1] : null;
                      if (last && last.time === c.time) candleData[candleData.length - 1] = { ...c };
                      else if (!last || c.time > last.time) candleData.push({ ...c });
                  }
              } catch(e) {}
          }
      });
      
      // Actualizar indicadores con el mismo guardián de tiempo
      if (msg.indicators) {
          const updateSeries = (series, data) => {
              if (!series || !data) return;
              const items = Array.isArray(data) ? data : [data];
              items.forEach(item => { 
                  if (item && !isNaN(item.value) && item.time >= lastTime) {
                      try { series.update(item); } catch(e) {}
                  }
              });
          };

          updateSeries(window.rsiSeries, msg.indicators.rsi);
          updateSeries(window.stochKSeries, msg.indicators.stoch_k);
          updateSeries(window.stochDSeries, msg.indicators.stoch_d);
      }
      
      // Refuerzo: Asegurar que el lateral sigue limpio durante el play
      if (window.candleSeries) {
          candleSeries.applyOptions({ lastValueVisible: false, priceLineVisible: false, countdownVisible: false });
      }
  }

  // Sincronizar trades y balance (Actualización visual de líneas de precio)
  if (msg.open_trades) {
      backtestState.openTrades = msg.open_trades;
      
      // LIMPIAR Y REDIBUJAR LÍNEAS PARA EVITAR "FANTASMAS" DE ÓRDENES CERRADAS
      if (typeof clearAllPriceLines === 'function') {
          clearAllPriceLines();
          backtestState.openTrades.forEach(t => {
              if (typeof addPriceLinesForTrade === 'function') addPriceLinesForTrade(t);
          });
      }
      
      updateOrderPanel();
  }
  if (msg.closed_trades) {
      backtestState.closedTrades = msg.closed_trades;
      updateTradeHistoryTable();
  }

  backtestState.currentIndex = msg.current_index;
  backtestState.balance = msg.balance;
  
  // syncAndFocusSimulation ya posiciona correctamente en cambio de TF
  
  updateStatsPanel(msg.stats);
  updateTimelineSlider();
}

// ── Lazy-scroll history loader ────────────────────────────────────────

function initBacktestHistoryScroll() {
    if (window._btHistoryScrollUnsub) {
        try { window._btHistoryScrollUnsub(); } catch(e) {}
        window._btHistoryScrollUnsub = null;
    }

    const THRESHOLD = 30;
    const COUNT     = 300;

    const onRange = (range) => {
        if (!range || !backtestState.active) return;
        if (backtestState.isLoadingHistory || !backtestState.hasMoreHistory) return;
        if (range.from > THRESHOLD) return;

        backtestState.isLoadingHistory = true;
        setTimeout(() => { backtestState.isLoadingHistory = false; }, 8000);

        if (window.socket && window.socket.readyState === WebSocket.OPEN) {
            window.socket.send(JSON.stringify({
                type:           'backtest_load_more_history',
                current_offset: backtestState.globalOffset,
                count:          COUNT,
            }));
        }
    };

    try {
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
        window._btHistoryScrollUnsub = () => {
            try { mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch(e) {}
        };
    } catch(e) {}
}

// ── Synchronized chart focus ────────────────────────────────────────

function syncAndFocusSimulation(focusIndex) {
    if (!window.mainChart) return;
    const candles = window.candleData || [];
    if (candles.length === 0) return;

    if (window._backtestSyncUnsub) {
        try { window._backtestSyncUnsub(); } catch(e) {}
        window._backtestSyncUnsub = null;
    }

    const rangeFrom = Math.max(0, focusIndex - 70);
    const rangeTo   = Math.min(candles.length - 1, focusIndex + 50);

    console.log('[BT-SYNC] syncAndFocusSimulation called', {
        focusIndex,
        candlesCount: candles.length,
        rsiCount: (window._btRsiData || []).length,
        stochKCount: (window._btStochKData || []).length,
        rangeFrom,
        rangeTo,
        firstCandleTime: candles[0]?.time,
        lastCandleTime: candles[candles.length-1]?.time,
    });

    const applyRange = (label) => {
        const lr = { from: rangeFrom, to: rangeTo };
        try {
            mainChart.timeScale().setVisibleLogicalRange(lr);
            const mainActual = mainChart.timeScale().getVisibleLogicalRange();
            const rsiActual  = window.rsiChart   ? rsiChart.timeScale().getVisibleLogicalRange()   : null;
            const stochActual= window.stochChart ? stochChart.timeScale().getVisibleLogicalRange() : null;
            console.log(`[BT-SYNC] ${label} BEFORE rsi/stoch set:`, { mainActual, rsiActual, stochActual });
        } catch(e) { console.warn('[BT-SYNC] mainChart error:', e); }

        try { if (window.rsiChart)   rsiChart.timeScale().setVisibleLogicalRange(lr); }   catch(e) { console.warn('[BT-SYNC] rsiChart error:', e); }
        try { if (window.stochChart) stochChart.timeScale().setVisibleLogicalRange(lr); } catch(e) { console.warn('[BT-SYNC] stochChart error:', e); }

        try {
            const mainFinal  = mainChart.timeScale().getVisibleLogicalRange();
            const rsiFinal   = window.rsiChart   ? rsiChart.timeScale().getVisibleLogicalRange()   : null;
            const stochFinal = window.stochChart ? stochChart.timeScale().getVisibleLogicalRange() : null;
            console.log(`[BT-SYNC] ${label} AFTER all set:`, { mainFinal, rsiFinal, stochFinal });
        } catch(e) {}
    };

    // Múltiples disparos: después del forceResize (100ms), después del backtest_loaded,
    // y safety nets adicionales para cubrir cualquier auto-fit o resize tardío.
    setTimeout(() => applyRange('150ms'),  150);
    setTimeout(() => applyRange('400ms'),  400);
    setTimeout(() => applyRange('900ms'),  900);
    setTimeout(() => applyRange('1800ms'), 1800);

    if (typeof updateTimelineSlider === 'function') updateTimelineSlider();
}

// ── Historical prepend handler (lazy scroll from backend) ────────────────────

function handleBacktestHistoricalPrepend(msg) {
    backtestState.isLoadingHistory = false;

    if (!msg.candles || msg.candles.length === 0) {
        backtestState.hasMoreHistory = false;
        return;
    }

    backtestState.hasMoreHistory = msg.has_more  || false;
    backtestState.globalOffset   = msg.new_offset || 0;

    const eS3 = (t) => (t > 10000000000 ? Math.floor(t / 1000) : Math.floor(t));

    const newCandles = (msg.candles || [])
        .map(c => ({
            time:   eS3(Number(c.time)),
            open:   Number(c.open),
            high:   Number(c.high),
            low:    Number(c.low),
            close:  Number(c.close),
            volume: Number(c.volume || 0),
        }))
        .filter(c => c.time > 0 && isFinite(c.open));

    if (newCandles.length === 0) return;

    const fInd2 = (arr) => {
        if (!Array.isArray(arr)) return [];
        return arr
            .filter(d => d && d.value != null && isFinite(Number(d.value)))
            .map(d => ({ time: eS3(Number(d.time)), value: Number(d.value) }))
            .filter(d => d.time > 0);
    };

    const newRsi    = fInd2(msg.indicators?.rsi    || []);
    const newStochK = fInd2(msg.indicators?.stoch_k || []);
    const newStochD = fInd2(msg.indicators?.stoch_d || []);

    // Guardar posición visible ANTES del prepend
    const visibleRange = mainChart.timeScale().getVisibleLogicalRange();
    const offset       = newCandles.length;

    // Prepend en candleData
    window.candleData = [...newCandles, ...(window.candleData || [])];

    // Prepend en arrays de indicadores
    window._btRsiData    = [...newRsi,    ...(window._btRsiData    || [])];
    window._btStochKData = [...newStochK, ...(window._btStochKData || [])];
    window._btStochDData = [...newStochD, ...(window._btStochDData || [])];

    requestAnimationFrame(() => {
        try {
            if (window.candleSeries) candleSeries.setData(window.candleData);
            if (window.volumeSeries) volumeSeries.setData(window.candleData.map(c => ({
                time:  c.time,
                value: c.volume || 0,
                color: c.close >= c.open ? '#26a69a80' : '#ef535080',
            })));
            if (window.rsiSeries    && window._btRsiData.length)    rsiSeries.setData(window._btRsiData);
            if (window.stochKSeries && window._btStochKData.length)  stochKSeries.setData(window._btStochKData);
            if (window.stochDSeries && window._btStochDData.length)  stochDSeries.setData(window._btStochDData);
        } catch(e) { console.warn('[BT-PREPEND]', e); }

        Promise.resolve().then(() => {
            // Restaurar posición: compensar las velas añadidas al inicio
            if (visibleRange) {
                requestAnimationFrame(() => {
                    try {
                        const nr = { from: visibleRange.from + offset, to: visibleRange.to + offset };
                        mainChart.timeScale().setVisibleLogicalRange(nr);
                        // chart.js syncCharts propaga a RSI/Stoch automáticamente
                    } catch(e) {}
                });
            }
        });
    });
}

function clearOrderInputs() {
  const ids = ['bt-entry-price', 'bt-sl', 'bt-tp'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function handleReplayRewind(msg) {
  if (!backtestState.active) return;
  
  const validCandles = filterCandles(msg.candles);
  candleSeries.setData(validCandles);
  
  volumeSeries.setData(validCandles.map(c => ({
    time: c.time, 
    value: (typeof c.volume === 'number' && isFinite(c.volume)) ? c.volume : 0, 
    color: c.close >= c.open ? '#26a69a80' : '#ef535080'
  })));
  
  if (msg.indicators) {
    if (msg.indicators.rsi) rsiSeries.setData(filterSeries(msg.indicators.rsi));
    if (msg.indicators.stoch_k) stochKSeries.setData(filterSeries(msg.indicators.stoch_k));
    if (msg.indicators.stoch_d) stochDSeries.setData(filterSeries(msg.indicators.stoch_d));
  }
  
  // Auto-foco tras rewind
  if (window.mainChart) window.mainChart.timeScale().scrollToRealTime();

  backtestState.openTrades = msg.open_trades || [];
  backtestState.closedTrades = msg.closed_trades || []; // Corregido: closedTrades en lugar de closed_trades
  backtestState.balance = msg.balance;
  backtestState.currentIndex = msg.current_index;
  
  clearAllPriceLines();
  backtestState.openTrades.forEach(t => drawTradeOnChart(t));
  
  updateTimelineSlider();
  updateOrderPanel();
  updateTradeHistoryTable();
  updateStatsPanel(msg.stats);

  // Mantener el scroll sincronizado al rebobinar
  if (validCandles.length > 0) {
    setTimeout(() => {
      mainChart.timeScale().scrollToPosition(0, false);
    }, 50);
  }
}

function handleTradeOpened(msg) {
  backtestState.openTrades.push(msg.trade);
  backtestState.balance = msg.balance;
  drawTradeOnChart(msg.trade);
  updateOrderPanel();
  updateStatsPanel(msg.stats);
}

function handleTradeClosed(msg) {
  backtestState.openTrades = backtestState.openTrades.filter(t => t.id !== msg.trade.id);
  backtestState.closedTrades.push(msg.trade);
  backtestState.balance = msg.balance;
  removePriceLinesForTrade(msg.trade.id);
  updateOrderPanel();
  updateTradeHistoryTable();
  updateStatsPanel(msg.stats);

  // AVISO VISUAL (Toast)
  if (window.showNotification) {
      const sym = (msg.trade.instrument || 'TRADE').replace('_', '/');
      if (msg.type === 'trade_sl_hit') {
          showNotification(`🛑 Operación cerrada en Stop Loss (${sym})`, 'error');
      } else if (msg.type === 'trade_tp_hit') {
          showNotification(`✅ ¡Operación cerrada en Take Profit! (${sym})`, 'success');
      } else if (msg.type === 'trade_closed') {
          showNotification(`📦 Operación cerrada manualmente (${sym})`, 'info');
      }
  }
}

function drawTradeOnChart(trade) {
  const lines = {};
  lines.entry = candleSeries.createPriceLine({
    price: trade.entry_price,
    color: trade.direction === 'BUY' ? '#26a69a' : '#ef5350',
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Solid,
    axisLabelVisible: true,
    title: trade.direction + ' ' + trade.lot_size
  });
  
  if (trade.stop_loss) {
    lines.sl = candleSeries.createPriceLine({
      price: trade.stop_loss,
      color: '#ef5350',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'SL'
    });
  }
  
  if (trade.take_profit) {
    lines.tp = candleSeries.createPriceLine({
      price: trade.take_profit,
      color: '#26a69a',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'TP'
    });
  }
  
  backtestState.tradePriceLines[trade.id] = lines;
}

function removePriceLinesForTrade(trade_id) {
  const lines = backtestState.tradePriceLines[trade_id];
  if (lines) {
    if (lines.entry) try { candleSeries.removePriceLine(lines.entry) } catch(e) {}
    if (lines.sl) try { candleSeries.removePriceLine(lines.sl) } catch(e) {}
    if (lines.tp) try { candleSeries.removePriceLine(lines.tp) } catch(e) {}
    delete backtestState.tradePriceLines[trade_id];
  }
}

function clearAllPriceLines() {
  Object.keys(backtestState.tradePriceLines).forEach(id => removePriceLinesForTrade(id));
}

function syncTradePriceLines(activeTrades) {
  const activeIds = activeTrades.map(t => t.id);
  Object.keys(backtestState.tradePriceLines).forEach(id => {
    if (!activeIds.includes(id)) {
      removePriceLinesForTrade(id);
    }
  });
}

function centerChartOnIndex(globalIndex) {
  if (!window.mainChart) return;
  
  const offset = backtestState.globalOffset || 0;
  const localIndex = globalIndex - offset;
  
  const timeScale = mainChart.timeScale();
  const visibleRange = timeScale.getVisibleLogicalRange();
  if (!visibleRange) return;
  
  const width = visibleRange.to - visibleRange.from;
  // Si el ancho es absurdo (p.ej. por carga inicial), usar un valor por defecto de 120 velas
  const safeWidth = (width > 5 && width < 2000) ? width : 120;
  
  // Para que el usuario vea un poco del "futuro" y la vela no esté pegada al borde derecho:
  // Colocamos el localIndex al 70% del ancho visible (30% de espacio a la derecha)
  const leftBars  = Math.floor(safeWidth * 0.7);
  const rightBars = safeWidth - leftBars;
  
  /*
  console.log('[BT-CENTER]', { 
    globalIndex, 
    offset, 
    localIndex, 
    width: safeWidth,
    range: { from: localIndex - leftBars, to: localIndex + rightBars }
  });
  */
  
  timeScale.setVisibleLogicalRange({
    from: localIndex - leftBars,
    to: localIndex + rightBars
  });
}

// Eliminar referencia a slider que ya no existe
function updateTimelineSlider() {
  const posEl = document.getElementById('replay-position');
  if (posEl && backtestState.totalCandles) {
    posEl.innerText = `${backtestState.currentIndex + 1} / ${backtestState.totalCandles}`;
  }
}

function updateOrderPanel() {
  const balance = (typeof backtestState.balance === 'number') ? backtestState.balance : (backtestState.initialBalance || 0);
  document.getElementById('bt-balance').textContent = '$' + balance.toFixed(2);
  
  // Open PnL
  let openPnl = 0;
  if (backtestState.openTrades.length > 0) {
    const lastPrice = candleData.length > 0 ? candleData[candleData.length - 1].close : 0;
    // Note: Actually, in backtest mode, the last price is the current replay candle's close
    // but the engine handles the calculation in get_statistics.
    // For local display, we'll wait for stats update or do a simple calculation if possible.
  }
  
  renderOpenPositions();
}

function renderOpenPositions() {
  const container = document.getElementById('bt-open-positions');
  container.innerHTML = '';
  
  backtestState.openTrades.forEach(t => {
    const div = document.createElement('div');
    div.className = `open-pos-item ${t.direction === 'BUY' ? 'pos-buy' : 'pos-sell'}`;
    div.innerHTML = `
      <div>
        <strong>${t.direction}</strong> ${t.lot_size} @ ${t.entry_price.toFixed(5)}
      </div>
      <button class="bt-btn" onclick="closeTrade('${t.id}')">CLOSE</button>
    `;
    container.appendChild(div);
  });
}

function updateTradeHistoryTable() {
  const table = document.getElementById('bt-trade-history-table');
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  
  backtestState.closedTrades.slice().reverse().forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.className = (t.pnl_usd || 0) >= 0 ? 'trade-win' : 'trade-loss';
    tr.innerHTML = `
      <td>${t.direction[0]}</td>
      <td>${t.entry_price.toFixed(5)}</td>
      <td>${t.exit_price ? t.exit_price.toFixed(5) : ''}</td>
      <td>${t.lot_size}</td>
      <td>${(t.pnl_pips || 0).toFixed(1)}</td>
      <td>$${(t.pnl_usd || 0).toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function updateStatsPanel(stats) {
  if (!stats) return;
  
  // 1. Panel de Estadísticas General
  const mappings = {
    'bt-win-rate': ((stats.win_rate || 0) * 100).toFixed(1) + '%',
    'bt-profit-factor': (stats.profit_factor || 0).toFixed(2),
    'bt-total-trades': stats.total_trades || 0,
    'bt-max-dd': '$' + (stats.max_drawdown_usd || 0).toFixed(2),
    'bt-rr': (stats.rr_ratio || 0).toFixed(2),
    'bt-avg-win': '$' + (stats.avg_win_usd || 0).toFixed(2),
    'bt-avg-loss': '$' + (stats.avg_loss_usd || 0).toFixed(2)
  };

  for (const [id, value] of Object.entries(mappings)) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // 2. Net PnL (con color)
  const totalPnlEl = document.getElementById('bt-total-pnl');
  if (totalPnlEl) {
    const totalPnl = stats.total_pnl_usd || 0;
    totalPnlEl.textContent = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2);
    totalPnlEl.className = 'stat-value ' + (totalPnl >= 0 ? 'color-up' : 'color-down');
    totalPnlEl.style.color = totalPnl >= 0 ? '#26a69a' : '#ef5350';
  }

  // 3. PNL ABIERTO (Real-time)
  const openPnlEl = document.getElementById('bt-open-pnl');
  if (openPnlEl) {
    const openPnl = stats.open_pnl_usd || 0;
    openPnlEl.textContent = (openPnl >= 0 ? '+' : '') + '$' + openPnl.toFixed(2);
    openPnlEl.style.color = openPnl >= 0 ? '#26a69a' : '#ef5350';
  }
}

function updateOrderPanel() {
  const balance = (typeof backtestState.balance === 'number') ? backtestState.balance : (backtestState.initialBalance || 0);
  const balEl = document.getElementById('bt-balance');
  if (balEl) balEl.textContent = '$' + balance.toFixed(2);
  
  // Renderizamos solo la lista de posiciones, el PnL lo lleva updateStatsPanel
  renderOpenPositions();
}

function calculateLotsFromRisk() {
  const riskPerc = parseFloat(document.getElementById('bt-risk-percent').value) || 0;
  const entry = parseFloat(document.getElementById('bt-entry-price').value) || 0;
  const sl = parseFloat(document.getElementById('bt-sl').value) || 0;
  
  if (riskPerc <= 0 || entry <= 0 || sl <= 0 || entry === sl) return 0.01;

  const riskAmount = backtestState.balance * (riskPerc / 100);
  const distance = Math.abs(entry - sl);
  
  // Evitar división por cero si la distancia es extremadamente pequeña
  if (distance < 0.00000001) return 0.01;
  
  // Determinamos el factor según el instrumento
  const isForex = (currentInstrument.includes('_') && 
                  ['EUR','GBP','JPY','AUD','NZD','CAD','CHF'].some(p => currentInstrument.includes(p)));
  
  // Factor 100,000 para Forex (estándar Oanda), 1.0 para BTC/Índices
  const factor = isForex ? 100000 : 1.0;
  
  let lots = riskAmount / (distance * factor);
  
  // Redondeo lógico: 2 decimales para lotes
  lots = Math.max(0.01, Math.round(lots * 100) / 100);
  
  return lots;
}

window.calculateLotsFromRisk = calculateLotsFromRisk;

function syncBacktestWithDrawing(obj) {
  if (!backtestState.active) return;
  if (obj.type !== 'long_pos' && obj.type !== 'short_pos') return;

  const entry = obj.points[0].price;
  const tp = obj.points[1].price;
  const sl = obj.points[2]?.price ?? (entry - (tp - entry));

  const entryInp = document.getElementById('bt-entry-price');
  const slInp = document.getElementById('bt-sl');
  const tpInp = document.getElementById('bt-tp');

  if (entryInp) entryInp.value = entry.toFixed(5);
  if (slInp) slInp.value = sl.toFixed(5);
  if (tpInp) tpInp.value = tp.toFixed(5);
  
  // Auto-calcular lotes si tenemos riesgo definido
  calculateLotsFromRisk();
}
window.syncBacktestWithDrawing = syncBacktestWithDrawing;

// Event Listeners for auto-calculation
document.addEventListener('DOMContentLoaded', () => {
    const slInp = document.getElementById('bt-sl');
    const entryInp = document.getElementById('bt-entry-price');
    if (slInp) slInp.addEventListener('input', calculateLotsFromRisk);
    if (entryInp) entryInp.addEventListener('input', calculateLotsFromRisk);
    
    const slider = document.getElementById('replay-timeline');
    if (slider) {
      slider.addEventListener('input', (e) => {
        replaySeek(parseInt(e.target.value));
      });
    }
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.onclick = () => setReplaySpeed(parseFloat(btn.dataset.speed));
    });

    const orderPanel = document.getElementById('backtest-order-panel');
    const historyPanel = document.getElementById('backtest-history-panel');
    if (orderPanel) makeDraggable(orderPanel);
    if (historyPanel) makeDraggable(historyPanel);
});

function makeDraggable(elmnt) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const header = elmnt.querySelector('.panel-header');
  
  if (header) {
    header.onmousedown = dragMouseDown;
  } else {
    elmnt.onmousedown = dragMouseDown;
  }

  function dragMouseDown(e) {
    e = e || window.event;
    // No draguear si se hace click en un botón dentro del header
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
    elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
    elmnt.style.right = 'auto'; // Importante para que no se estire si tenía fixed right
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

function clearOrderInputs() {
  const sl = document.getElementById('bt-sl');
  const tp = document.getElementById('bt-tp');
  const ent = document.getElementById('bt-entry-price');
  if (sl) sl.value = '';
  if (tp) tp.value = '';
  if (ent) ent.value = '';
}

function openTrade(direction) {
  const riskPercent = parseFloat(document.getElementById('bt-risk-percent').value) || 1.0;
  const lotSize = calculateLotsFromRisk() || 0.01;
  const entry = parseFloat(document.getElementById('bt-entry-price').value) || null;
  const sl = parseFloat(document.getElementById('bt-sl').value) || null;
  const tp = parseFloat(document.getElementById('bt-tp').value) || null;
  
  socket.send(JSON.stringify({ 
    type: 'trade_open', 
    direction, 
    lot_size: lotSize, 
    risk_percent: riskPercent,
    entry_price: entry,
    stop_loss: sl, 
    take_profit: tp 
  }));
}

function closeTrade(tradeId) {
  socket.send(JSON.stringify({ 
    type: 'trade_close', 
    trade_id: tradeId 
  }));
}

// ── Session Management ──────────────────────────────────────────────

function requestSessionsList() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'backtest_list_sessions' }));
  }
}

function handleSessionsList(sessions) {
  const modal = document.getElementById('sessions-modal');
  const container = document.getElementById('sessions-list-container');
  if (!modal || !container) return;
  
  container.innerHTML = '';
  
  if (sessions.length === 0) {
    container.innerHTML = '<div style="padding: 40px; text-align: center; color: #787B86;">No se encontraron sesiones guardadas.</div>';
  } else {
    sessions.forEach(s => {
      const dateStr = s.created_at ? new Date(s.created_at).toLocaleDateString() : s.date;
      const isNegative = Number(s.balance) < (s.initial_balance || 10000);
      
      const card = document.createElement('div');
      card.className = 'session-card';
      card.onclick = (e) => {
        // Evitar cargar si se hace clic en el botón de borrar
        if (e.target.closest('.btn-delete-session-x')) return;
        loadSession(s.filename);
      };
      
      card.innerHTML = `
        <div class="session-info">
          <div class="session-instrument">
            ${s.instrument} <span class="session-tf">${s.timeframe}</span>
          </div>
          <div class="session-meta">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            ${dateStr}
          </div>
        </div>
        <div class="session-stats">
          <div class="session-balance ${isNegative ? 'negative' : ''}">
            $${Number(s.balance).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
          </div>
          <div style="font-size: 10px; opacity: 0.4; letter-spacing: 1px; text-transform: uppercase;">Balance Final</div>
        </div>
        <div class="session-actions">
           <button class="btn-load-session">CARGAR</button>
           <button title="Eliminar sesión" class="btn-delete-session-x" onclick="deleteSession('${s.filename}')">×</button>
        </div>
      `;
      container.appendChild(card);
    });
  }
  
  modal.style.display = 'flex';
}


function loadSession(filename) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    if (typeof backtestState !== 'undefined') backtestState.loadingSession = true;
    
    socket.send(JSON.stringify({ type: 'backtest_load', filename }));
    document.getElementById('sessions-modal').style.display = 'none';
    
    // Desbloquear después de un tiempo prudencial para permitir cambios normales posteriores
    setTimeout(() => {
        if (typeof backtestState !== 'undefined') backtestState.loadingSession = false;
    }, 2000);
  }
}


function deleteSession(filename) {
  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(
      'Eliminar Sesión',
      '¿Estás seguro de que quieres eliminar esta sesión de backtest?\nEsta acción no se puede deshacer.',
      () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'backtest_delete_session', filename }));
        }
      }
    );
  } else {
    // Fallback si por alguna razón no está disponible el modal
    if (!confirm('¿Estás seguro de que quieres eliminar esta sesión de backtest?\nEsta acción no se puede deshacer.')) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'backtest_delete_session', filename }));
    }
  }
}


function handleBacktestSessionLoaded(msg) {
  console.log("Session loaded successfully:", msg.instrument);
  
  // Ocultar modales
  const configModal = document.getElementById('backtest-config-modal');
  if (configModal) configModal.style.display = 'none';
  
  // Restaurar estado
  backtestState.active = true;
  window.backtestActive = true;
  if (window.updateCandleCountdown) window.updateCandleCountdown();
  
  // Visual lockdown inmediato para evitar parpadeos live
  if (window.candleSeries) {
    candleSeries.applyOptions({
        priceLineVisible: false,
        lastValueVisible: false,
        countdownVisible: false,
        title: ''
    });
  }
  if (window.mainChart) {
    mainChart.applyOptions({
      priceScale: { lastValueVisible: false },
      rightPriceScale: { lastValueVisible: false }
    });
  }
  
  backtestState.totalCandles = msg.total;
  backtestState.currentIndex = msg.current_index;
  backtestState.balance = msg.balance;
  backtestState.openTrades = msg.open_trades || [];
  backtestState.closedTrades = msg.closed_trades || [];
  
  if (window.updateCandleCountdown) window.updateCandleCountdown();
  
  // Reforzar visual lockdown inmediatamente
  if (window.candleSeries) {
    candleSeries.applyOptions({
      priceLineVisible: false,
      lastValueVisible: false,
      countdownVisible: false,
      title: ''
    });
  }
  
  // 3. Limpiar datos previos del gráfico para evitar "contaminación" de fechas live
  if (window.candleSeries) candleSeries.setData([]);
  if (window.rsiSeries) rsiSeries.setData([]);
  if (window.stochKSeries) stochKSeries.setData([]);
  if (window.stochDSeries) stochDSeries.setData([]);
  if (window.volumeSeries) volumeSeries.setData([]);

  // RESETEAR VISTA: Asegurar que no hay rangos previos guardados
  if (window.mainChart) {
      mainChart.timeScale().scrollToPosition(0, false);
  }
  
  // Sincronizar UI Principal
  const sessionPriceUI = document.getElementById('price-display');
  if (sessionPriceUI) sessionPriceUI.style.display = 'none';
  
  const sessReplayBar = document.getElementById('backtest-replay-bar');
  if (sessReplayBar) sessReplayBar.style.display = 'flex';
  
  const sessOrderPanel = document.getElementById('backtest-order-panel');
  if (sessOrderPanel) sessOrderPanel.style.display = 'flex';
  
  const sessHistoryPanel = document.getElementById('backtest-history-panel');
  if (sessHistoryPanel) sessHistoryPanel.style.display = 'flex';
  
  const sessBtBtn = document.getElementById('btn-backtest');
  if (sessBtBtn) {
    sessBtBtn.textContent = 'EXIT BACKTEST';
    sessBtBtn.style.color = '#ef5350';
  }


  // 1. CAPTURAR ESTADO LIVE PARA AISLAMIENTO (Igual que en un backtest nuevo)
  if (!preBacktestState && !window.backtestActive) {
      preBacktestState = {
          tabs: JSON.parse(JSON.stringify(window.tabs)),
          tabId: window.activeTabId,
          symbol: window.currentInstrument,
          timeframe: window.currentTimeframe
      };
  }

  // Sincronizar instrumentos
  window.currentInstrument = msg.instrument;
  window.currentTimeframe = msg.granularity;

  // AISLAMIENTO TOTAL: Reemplazar pestañas por la del backtest recuperado
  window.tabs = [{
      id: 'backtest-temp-tab',
      symbol: msg.instrument,
      timeframe: msg.granularity
  }];
  window.activeTabId = 'backtest-temp-tab';

  // Forzar actualización de UI
  if (typeof updateTimeframeUI === 'function') updateTimeframeUI(msg.granularity);
  if (typeof renderTabs === 'function') renderTabs();
  
  const instrLabel = document.getElementById('active-instrument-label');
  if (instrLabel) instrLabel.textContent = msg.instrument.replace('_', '/');

  // Mostrar paneles de backtest
  document.getElementById('backtest-replay-bar').style.display = 'flex';
  document.getElementById('backtest-order-panel').style.display = 'flex';
  document.getElementById('backtest-history-panel').style.display = 'flex';
  if (sessionPriceUI) sessionPriceUI.style.display = 'flex';

  window.backtestActive = true;
  backtestState.active = true;
  backtestState.instrument = msg.instrument;
  backtestState.timeframe = msg.granularity;

  
  // Actualizar gráficas (Fase A: Datos)
  const currentIndex = msg.current_index || 0;
  
  if (msg.candles) {
    const allCandles = msg.candles.map(c => ({
      time: Number(c.time), 
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || c.v || 0)
    }));
    
    backtestState.allCandles = [...allCandles];
    const historyCandles = allCandles.slice(0, currentIndex + 1);
    
    if (window.candleSeries) {
      candleSeries.setData(historyCandles);
      // FORZAR DESACTIVACIÓN DE TODO LO VISIBLE EN EL LATERAL
      candleSeries.applyOptions({
          priceLineVisible: false,
          lastValueVisible: false,
          countdownVisible: false,
          title: ''
      });
    }
    
    if (window.volumeSeries && historyCandles.length > 0) {
      volumeSeries.setData(historyCandles.map(c => ({
        time: c.time,
        value: Number(c.volume || 0), 
        color: c.close >= c.open ? '#26a69a80' : '#ef535080'
      })));
      
      // Auto-foco tras cargar sesión
      if (window.mainChart) window.mainChart.timeScale().scrollToRealTime();
      volumeSeries.applyOptions({
          lastValueVisible: false,
          priceLineVisible: false
      });
    }
    
    // Refuerzo tras setData
    if (window.candleSeries) {
      candleSeries.applyOptions({
          priceLineVisible: false,
          lastValueVisible: false,
          countdownVisible: false,
          title: ''
      });
    }
    
    window.candleData = [...historyCandles];
    
    updateTimelineSlider();
    window.dispatchEvent(new Event('resize'));
    if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
    
    // Forzar foco final
    setTimeout(() => {
        if (window.mainChart) window.mainChart.timeScale().scrollToRealTime();
    }, 100);
  }

  // CARGAR INDICADORES (Solo hasta el punto actual)
  if (msg.all_indicators) {
      const filterInd = (arr) => (Array.isArray(arr) ? arr.slice(0, currentIndex + 1) : []);
      if (window.rsiSeries && msg.all_indicators.rsi) window.rsiSeries.setData(filterInd(msg.all_indicators.rsi));
      if (window.stochKSeries && msg.all_indicators.stoch_k) window.stochKSeries.setData(filterInd(msg.all_indicators.stoch_k));
      if (window.stochDSeries && msg.all_indicators.stoch_d) window.stochDSeries.setData(filterInd(msg.all_indicators.stoch_d));
  }

  // Fase B: Asegurar que las opciones se mantienen tras el renderizado inicial (Refuerzo Visual TOTAL)
  setTimeout(() => {
    if (window.mainChart) {
        // SILENCIAR LA ESCALA COMPLETA DESDE LA RAÍZ
        mainChart.priceScale('right').applyOptions({
            borderVisible: false,
            visible: true,
            entireTextOnly: false,
            alignLabels: false // Evitar que se amontonen las etiquetas
        });

        // Configuración global del gráfico para ignorar valores de último precio
        mainChart.applyOptions({
            priceScale: {
                lastValueVisible: false
            }
        });
    }

    if (window.candleSeries) {
        candleSeries.applyOptions({ 
            priceLineVisible: false, 
            lastValueVisible: false, 
            countdownVisible: false,
            priceLineSource: 1
        });
    }

    if (window.volumeSeries) {
        volumeSeries.applyOptions({ 
            priceLineVisible: false, 
            lastValueVisible: false 
        });
    }
    
    // AÑADIR UN PASO EXTRA: Si hay subscripciones live, silenciarlas
    if (typeof syncIndicatorStatus === 'function') syncIndicatorStatus();
  }, 400);

  // FORZAR CIERRE DE PANELES PARA COHERENCIA (NADA DE INDICADORES AUTOMÁTICOS)
  if (document.getElementById('rsi-container')) document.getElementById('rsi-container').style.display = 'none';
  if (document.getElementById('stoch-container')) document.getElementById('stoch-container').style.display = 'none';
  
  // Sincronizar UI y forzar un refresco interno de los charts de indicadores
  setTimeout(() => {
    if (typeof syncIndicatorStatus === 'function') syncIndicatorStatus();
    if (window.rsiChart) rsiChart.timeScale().fitContent();
    if (window.stochChart) stochChart.timeScale().fitContent();
  }, 500);

  // Pequeño delay para dejar que Lightweight Charts procese setData internamente (Fase B: UI)
  setTimeout(() => {
    // Restaurar dibujos si existen
    if (msg.drawings && typeof drawingState !== 'undefined') {
      drawingState.objects = msg.drawings || [];
      drawingState.activeObjId = null;
      drawingState.hoveredObjId = null;
      
      if (window.updateObjectTree) window.updateObjectTree();
      if (window.redrawCanvas) window.redrawCanvas();
    }
    
    // Forzar el centrado del gráfico en el índice donde se guardó la sesión
    centerChartOnIndex(msg.current_index);
    
    // Limpiar y restaurar líneas de precio
    clearAllPriceLines();
    backtestState.openTrades.forEach(t => addPriceLinesForTrade(t));
    
    // Actualizar paneles estadísticos
    updateOrderPanel();
    updateTradeHistoryTable();
    updateStatsPanel(msg.stats);
    updateTimelineSlider();
    
    showNotification('Sesión restaurada correctamente', 'success');
  }, 150); 
}


function replayPlay() {
  backtestState.isPlaying = true;
  document.getElementById('replay-play-btn').style.display = 'none';
  document.getElementById('replay-pause-btn').style.display = 'flex';
  centerChartOnIndex(backtestState.currentIndex);
  socket.send(JSON.stringify({ 
    type: 'replay_play', 
    speed: backtestState.speed || 1 
  }));
}

function replayPause() {
  backtestState.isPlaying = false;
  document.getElementById('replay-play-btn').style.display = 'flex';
  document.getElementById('replay-pause-btn').style.display = 'none';
  socket.send(JSON.stringify({ type: 'replay_pause' }));
}

function setReplaySpeed(speed) {
  backtestState.speed = speed;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.speed) === speed);
  });
  if (backtestState.isPlaying) {
    socket.send(JSON.stringify({ type: 'replay_play', speed: speed }));
  }
}

function replayStep(direction, bars = 1) {
  socket.send(JSON.stringify({ type: 'replay_step', direction, bars }));
}

function replaySeek(index) {
  socket.send(JSON.stringify({
      type:            'replay_seek',
      index:           parseInt(index),
      frontend_offset: backtestState.globalOffset,
  }));
}

function saveBacktest() {
  const drawings = (typeof drawingState !== 'undefined') ? drawingState.objects : [];
  socket.send(JSON.stringify({ 
    type: 'backtest_save',
    drawings: drawings
  }));
}

function exportBacktest() {
  socket.send(JSON.stringify({ type: 'backtest_export_csv' }));
}

// --- UI INJECTION ---
(function initBacktestUI() {
  const container = document.getElementById('indicators-toggles');
  if (!container) return;

  const backtestBtn = document.createElement('button');
  backtestBtn.id = 'btn-backtest';
  backtestBtn.className = 'indicator-btn';
  backtestBtn.style.color = '#787B86';
  backtestBtn.style.fontWeight = 'bold';
  backtestBtn.style.marginLeft = '10px';
  backtestBtn.textContent = 'BACKTEST';
  
  backtestBtn.onclick = () => {
    if (backtestState.active) exitBacktestMode();
    else enterBacktestMode();
  };
  
  container.appendChild(backtestBtn);

  // Periodically sync the button text/style based on backtestState
  setInterval(() => {
    if (backtestState.active) {
      backtestBtn.textContent = 'EXIT BACKTEST';
      backtestBtn.style.color = '#ef5350';
      backtestBtn.style.borderColor = '#ef5350';
    } else {
      backtestBtn.textContent = 'BACKTEST';
      backtestBtn.style.color = '#787B86';
      backtestBtn.style.border = 'none';
    }
  }, 500);
})();
