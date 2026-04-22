// ============================================================
//  drawing_backtest.js — Motor de dibujo ESPECIALIZADO para Backtest
// ============================================================

/**
 * Función auxiliar getLastReproducedCandle()
 * Obtiene la referencia de la última vela reproducida en el backtest.
 */
function getLastReproducedCandle() {
  const state = window.backtestState;
  if (!state || !state.active) return null;
  
  // Usar window.candleData como fuente de verdad absoluta para el dibujo
  const data = window.candleData;
  if (!data || !data.length) return null;
  
  // El índice de referencia debe estar dentro del rango de datos inyectados en el gráfico
  const safeIndex = Math.max(0, Math.min(
    state.currentIndex || 0,
    data.length - 1
  ));
  
  return { 
    candle: data[safeIndex], 
    index: safeIndex 
  };
}



/**
 * Función auxiliar getBarSpacingFromChart()
 * Calcula el barSpacing real midiendo la distancia en píxeles entre dos índices lógicos.
 * No usamos timeScale.options().barSpacing porque a menudo devuelve valores obsoletos al hacer zoom.
 */
function getBarSpacingFromChart(timeScale) {
  try {
    const options = timeScale.options();
    const bs = options.barSpacing;
    
    // Intentamos obtener el real si es posible para mayor precisión
    const range = timeScale.getVisibleLogicalRange();
    if (range) {
      const i1 = Math.floor((range.from + range.to) / 2);
      const x1 = timeScale.logicalToCoordinate(i1);
      const x2 = timeScale.logicalToCoordinate(i1 + 1);
      if (x1 !== null && x2 !== null) {
        return Math.abs(x2 - x1);
      }
    }
    return bs || 6;
  } catch (e) {
    return 6;
  }
}

window.DrawingBT = {
  
  /**
   * DrawingBT.pixelToChart(x, y)
   * Convierte coordenadas de píxel a datos del gráfico con extrapolación de alta precisión.
   */
  pixelToChart: function(x, y) {
    try {
      if (!mainChart || !candleSeries) return { time: null, price: null, logical: null, offsetSeconds: 0 };
      const timeScale = mainChart.timeScale();
      const priceScale = candleSeries.priceScale();
      if (!timeScale || !priceScale) return { time: null, price: null, logical: null, offsetSeconds: 0 };

      // PASO 1 — Conversión directa
      let time = timeScale.coordinateToTime(x);
      let price = candleSeries.coordinateToPrice(y);
      let logical = timeScale.coordinateToLogical(x);

      const ref = getLastReproducedCandle();
      if (!ref) return { time, price, logical, offsetSeconds: 0 };

      // PASO 2 — Extrapolación lógica (para clics fuera del rango visible cargado)
      if (logical === null) {
        const refX = timeScale.logicalToCoordinate(ref.index);
        const bs = getBarSpacingFromChart(timeScale);
        
        if (refX !== null) {
          logical = ref.index + (x - refX) / bs;
        } else {
          const range = timeScale.getVisibleLogicalRange();
          if (range) {
            const centerX = (document.getElementById('drawing-canvas')?.width || 0) / 2;
            const centerLog = (range.from + range.to) / 2;
            logical = centerLog + (x - centerX) / bs;
          }
        }
      }

      // PASO 3 — Extrapolación temporal estable
      if (time === null && logical !== null && ref && ref.candle) {
        const secPerBar = Math.max(typeof getSecondsPerBar === 'function' ? getSecondsPerBar() : 300, 1);
        // Extrapolación lineal basada en la última vela histórica reproducida
        time = Number(ref.candle.time) + Math.round(logical - ref.index) * secPerBar;
      }
      
      return { time: time ? Number(time) : null, price, logical, offsetSeconds: 0 };
    } catch (e) {
      console.error("BT pixelToChart Error:", e);
      return { time: null, price: null, logical: null, offsetSeconds: 0 };
    }
  },

  /**
   * DrawingBT.chartToPixel(time, price, offsetSeconds, logical)
   * Convierte datos del gráfico a píxeles con anclaje de seguridad.
   */
  chartToPixel: function(time, price, offsetSeconds = 0, logical = null) {
    try {
      if (!mainChart || !candleSeries) return { x: null, y: null };
      const timeScale = mainChart.timeScale();

      if (time == null || isNaN(Number(time))) return { x: null, y: null };
      if (price == null || isNaN(Number(price))) return { x: null, y: null };
      
      const y = candleSeries.priceToCoordinate(Number(price));
      
      // Intentamos obtener X directamente del gráfico (si la vela está en el set de datos actual)
      let x = timeScale.timeToCoordinate(Number(time));

      // Si x es null, es que la vela no está en la "ventana" actual del setData
      // o es una vela futura/pasada fuera del rango cargado en la serie.
      if (x === null) {
        const ref = getLastReproducedCandle();
        if (ref && ref.candle) {
          // Usamos la última vela reproducida como ancla ESTABLE
          const refX = timeScale.logicalToCoordinate(ref.index);
          const secPerBar = Math.max(typeof getSecondsPerBar === 'function' ? getSecondsPerBar() : 300, 1);
          const bs = getBarSpacingFromChart(timeScale);

          if (refX !== null) {
            // Calculamos cuántas barras de distancia hay entre el tiempo del dibujo y el ancla
            const barsDiff = (Number(time) - Number(ref.candle.time)) / secPerBar;
            x = refX + (barsDiff * bs);
          } else {
            // Caso extremo: el ancla tampoco está visible, usamos el centro del rango visible
            const range = timeScale.getVisibleLogicalRange();
            if (range) {
                const canvas = document.getElementById('drawing-canvas');
                const centerX = (canvas ? canvas.width : 800) / 2;
                const centerLog = (range.from + range.to) / 2;
                // Proyectamos basándonos en la vela de referencia y su tiempo
                const targetLogicalOffset = (Number(time) - Number(ref.candle.time)) / secPerBar;
                const absoluteTargetLogical = ref.index + targetLogicalOffset;
                x = centerX + (absoluteTargetLogical - centerLog) * bs;
            }
          }
        }
      }

      return { x, y };
    } catch (e) {
      console.error("BT chartToPixel Error:", e);
      return { x: null, y: null };
    }
  }

};

// ============================================================
//  INTEGRACIÓN DE CARGA — No modificar drawing.js
// ============================================================

// Envolvemos el manejador global para añadir la protección de carga de sesiones 
// solo cuando estamos en modo backtest, sin tocar el archivo original.
(function() {
  const originalHandler = window.handleDrawingsLoaded;
  window.handleDrawingsLoaded = function(data) {
    const state = window.backtestState;
    if (state && state.active && state.loadingSession) {
      console.log("[DrawingBT] Ignorando carga automática: Sesión específica en proceso.");
      return;
    }
    if (typeof originalHandler === 'function') {
      originalHandler(data);
    }
  };
})();

