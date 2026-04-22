const tfButtons = document.querySelectorAll('.tf-btn');

// Timeframe change
tfButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const tf = btn.getAttribute('data-tf');
        
        // 1. Guardar dibujos actuales antes del cambio
        if (typeof saveDrawings === 'function') saveDrawings();

        // 2. Gestionar cambio según el modo (Backtest o Live)
        const isBacktest = (window.backtestState && window.backtestState.active) || window.backtestActive;
        
        if (isBacktest) {
            let lastTime = null;
            if (window.backtestState && window.backtestState.current_time) {
                lastTime = window.backtestState.current_time;
            } else if (window.candleData && window.candleData.length > 0 && window.backtestState && window.backtestState.currentIndex !== undefined) {
                const idx = Math.min(window.backtestState.currentIndex, window.candleData.length - 1);
                lastTime = window.candleData[idx] ? window.candleData[idx].time : null;
            } else if (typeof candleSeries !== 'undefined') {
                const data = candleSeries.data();
                if (data && data.length > 0) lastTime = data[data.length - 1].time;
            }

            if (window.socket && window.socket.readyState === WebSocket.OPEN) {
                currentTimeframe = tf;
                updateTimeframeUI(tf);
                if (typeof showLoadingOverlay === 'function') showLoadingOverlay();

                window.socket.send(JSON.stringify({ 
                    type: 'backtest_change_timeframe',
                    instrument: currentInstrument,
                    timeframe: tf,
                    current_time: lastTime
                }));
            }
            return;
        }

        // Modo Live normal
        changeTimeframe(tf);
    });
});

function changeTimeframe(oandaGranularity) {
    currentTimeframe = oandaGranularity;
    if (typeof updateTimeframeUI === 'function') updateTimeframeUI(oandaGranularity);
    isLoadingMore = false;
    hasMoreData = true;
    resetAllCharts();
    
    if (window.socket && window.socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'change_timeframe',
            timeframe: oandaGranularity,
            instrument: currentInstrument
        }));
        // Recargar dibujos para el nuevo estado
        if (window.loadDrawings) window.loadDrawings();
    }
}

// Indicator toggles
document.querySelectorAll('.indicator-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        window.toggleIndicator(btn.dataset.id);
    });
});


function toggleIndicatorsModal() {
  const modal = document.getElementById('indicators-search-modal');
  const isHidden = modal.style.display === 'none';
  modal.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) {
    document.getElementById('indicator-search-input').focus();
    syncIndicatorStatus();
  }
}

function filterIndicators() {
  const input = document.getElementById('indicator-search-input');
  const filter = input.value.toLowerCase();
  const list = document.getElementById('indicators-list');
  const items = list.getElementsByClassName('indicator-item');

  for (let i = 0; i < items.length; i++) {
    const text = items[i].getElementsByTagName('span')[0].textContent;
    if (text.toLowerCase().indexOf(filter) > -1) {
      items[i].style.display = "";
    } else {
      items[i].style.display = "none";
    }
  }
}

function handleIndicatorClick(id, element) {
  if (window.toggleIndicator) {
    toggleIndicator(id);
    // El toggleIndicator en chart.js ya cambia la visibilidad del gráfico
    // Aquí actualizamos la UI del modal
    element.classList.toggle('active');
  }
}

function syncIndicatorStatus() {
  const items = document.getElementsByClassName('indicator-item');
  for (let item of items) {
    const id = item.getAttribute('data-id');
    const containerId = id.replace('-chart', '-container');
    const container = document.getElementById(containerId);
    
    // El volumen es especial ya que es parte del main chart
    if (id === 'volume-chart') {
      const isVisible = volumeSeries && volumeSeries.options().visible;
      item.classList.toggle('active', isVisible);
    } else if (container) {
      item.classList.toggle('active', container.style.display !== 'none');
    }
  }
}

window.toggleIndicatorsModal = toggleIndicatorsModal;
window.filterIndicators = filterIndicators;
window.handleIndicatorClick = handleIndicatorClick;

