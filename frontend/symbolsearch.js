// ============================================================
//  symbolsearch.js — Búsqueda de símbolos conectada a OANDA
//  Depende de: chart.js (ws, currentInstrument, currentTimeframe)
// ============================================================

let allInstruments = [];
let filteredInstruments = [];

async function loadInstruments() {
  if (allInstruments.length > 0) return;
  try {
    const res = await fetch('http://127.0.0.1:8765/api/instruments');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    allInstruments = data.instruments || [];
  } catch (e) {
    console.warn('[symbolsearch] Could not load instruments from API:', e.message);
    allInstruments = [
      { symbol: 'GBP_USD', display: 'GBP/USD', type: 'CURRENCY', pip: -4 },
      { symbol: 'EUR_USD', display: 'EUR/USD', type: 'CURRENCY', pip: -4 },
      { symbol: 'USD_JPY', display: 'USD/JPY', type: 'CURRENCY', pip: -2 },
      { symbol: 'USD_CHF', display: 'USD/CHF', type: 'CURRENCY', pip: -4 },
      { symbol: 'AUD_USD', display: 'AUD/USD', type: 'CURRENCY', pip: -4 },
      { symbol: 'USD_CAD', display: 'USD/CAD', type: 'CURRENCY', pip: -4 },
      { symbol: 'NZD_USD', display: 'NZD/USD', type: 'CURRENCY', pip: -4 },
      { symbol: 'EUR_GBP', display: 'EUR/GBP', type: 'CURRENCY', pip: -4 },
      { symbol: 'EUR_JPY', display: 'EUR/JPY', type: 'CURRENCY', pip: -2 },
      { symbol: 'GBP_JPY', display: 'GBP/JPY', type: 'CURRENCY', pip: -2 },
      { symbol: 'EUR_CHF', display: 'EUR/CHF', type: 'CURRENCY', pip: -4 },
      { symbol: 'XAU_USD', display: 'Gold/USD', type: 'METAL', pip: -2 },
      { symbol: 'XAG_USD', display: 'Silver/USD', type: 'METAL', pip: -4 },
      { symbol: 'BCO_USD', display: 'Brent Oil', type: 'CFD', pip: -3 },
      { symbol: 'WTICO_USD', display: 'WTI Oil', type: 'CFD', pip: -3 },
    ];
  }
}

function filterInstruments(query) {
  if (!query || query.trim() === '') {
    filteredInstruments = allInstruments;
  } else {
    const q = query.toUpperCase().replace('/', '_');
    filteredInstruments = allInstruments.filter(inst =>
      inst.symbol.includes(q) ||
      inst.display.toUpperCase().includes(query.toUpperCase())
    );
  }
  renderInstrumentList();
}

function renderInstrumentList() {
  const list = document.getElementById('symbol-list');
  if (!list) return;
  list.innerHTML = '';

  const groups = { CURRENCY: [], METAL: [], CFD: [], CRYPTO: [] };
  filteredInstruments.forEach(inst => {
    const g = groups[inst.type] || groups.CFD;
    g.push(inst);
  });

  const groupLabels = { CURRENCY: 'Forex', METAL: 'Metales', CFD: 'CFDs / Futuros', CRYPTO: 'Criptomonedas' };
  const groupIcons  = { CURRENCY: '💱', METAL: '🥇', CFD: '📊', CRYPTO: '₿' };

  Object.entries(groups).forEach(([type, instruments]) => {
    if (instruments.length === 0) return;

    const header = document.createElement('div');
    header.className = 'sym-group-header';
    header.textContent = `${groupIcons[type]} ${groupLabels[type]}`;
    list.appendChild(header);

    instruments.forEach(inst => {
      const item = document.createElement('div');
      item.className = 'symbol-item';
      item.dataset.symbol = inst.symbol;
      
      const isOanda = inst.provider === 'OANDA' || inst.symbol.includes('_');
      const badgeClass = isOanda ? 'badge-oanda' : 'badge-binance';
      const providerLabel = inst.provider || (isOanda ? 'OANDA' : 'BINANCE');

      if (inst.symbol === (typeof currentInstrument !== 'undefined' ? currentInstrument : '')) {
        item.classList.add('active');
      }
      item.innerHTML = `
        <div style="display:flex; align-items:center;">
            <span class="sym-display">${inst.display}</span>
            <span class="provider-badge ${badgeClass}">${providerLabel}</span>
        </div>
        <span class="sym-code">${inst.symbol.replace('_', '/')}</span>
      `;
      item.addEventListener('click', () => selectInstrument(inst.symbol, inst.display));
      list.appendChild(item);
    });
  });

  if (filteredInstruments.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:#787B86;font-size:13px;">Sin resultados</div>';
  }
}

let searchTarget = 'chart'; // 'chart' | 'backtest'

function selectInstrument(symbol, display) {
  closeSymbolSearch();

  if (searchTarget === 'backtest') {
    const hiddenInput = document.getElementById('bt-config-instrument');
    const label = document.getElementById('bt-active-instrument-label');
    if (hiddenInput) hiddenInput.value = symbol;
    if (label) label.innerText = display;
    return;
  }

  if (typeof tabs === 'undefined' || typeof switchTab === 'undefined') return;

  // Save drawings for the current instrument before leaving
  if (typeof saveDrawings === 'function') saveDrawings();

  // If a tab for this symbol already exists, just switch to it
  const existing = tabs.find(t => t.symbol === symbol);
  if (existing) {
    switchTab(existing.id);
    return;
  }

  // Otherwise open a NEW tab with the chosen symbol
  const newTab = {
    id: Date.now(),
    symbol: symbol,
    timeframe: (typeof currentTimeframe !== 'undefined' && currentTimeframe) ? currentTimeframe : 'M5'
  };
  tabs.push(newTab);
  switchTab(newTab.id);   // sets currentInstrument, resets charts, sends subscription

  // Load drawings saved for this instrument
  if (typeof loadDrawings === 'function') {
    setTimeout(loadDrawings, 400);
  }
}


function openSymbolSearch(target = 'chart') {
  // Bloquear búsqueda si el backtest está activo para el gráfico principal
  if (target === 'chart' && typeof backtestState !== 'undefined' && backtestState.active) {
    if (window.showNotification) {
      showNotification('Salga del modo Backtest para buscar otro símbolo', 'warning');
    } else {
      alert('Salga del modo Backtest para buscar otro símbolo');
    }
    return;
  }
  
  searchTarget = target;
  const modal = document.getElementById('symbol-search-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const input = document.getElementById('symbol-search-input');
  if (input) {
    input.value = '';
    input.placeholder = 'Cargando instrumentos...';
    input.disabled = true;
    input.focus();
  }
  
  loadInstruments().then(() => {
    if (input) {
      input.placeholder = 'Buscar símbolo...';
      input.disabled = false;
      input.focus();
    }
    filteredInstruments = allInstruments;
    renderInstrumentList();
  });
}

function closeSymbolSearch() {
  const modal = document.getElementById('symbol-search-modal');
  if (modal) modal.style.display = 'none';
}

// Expose globally
window.openSymbolSearch = openSymbolSearch;
window.closeSymbolSearch = closeSymbolSearch;
window.filterInstruments = filterInstruments;

// Close on outside click
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('symbol-search-modal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === this) closeSymbolSearch();
    });
  }
});

// Also wire up the input live filter
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('symbol-search-input');
  if (input) {
    input.addEventListener('input', e => filterInstruments(e.target.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeSymbolSearch();
      if (e.key === 'Enter') {
        // select first result
        const first = filteredInstruments[0];
        if (first) selectInstrument(first.symbol, first.display);
      }
      if (e.key === 'ArrowDown') {
        const first = document.querySelector('.symbol-item');
        if (first) first.focus();
      }
    });
  }
});
