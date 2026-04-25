/**
 * Centralizador de eventos de Backtest para el frontend.
 * Mueve la lógica de procesamiento de mensajes fuera de index.html.
 */

function handleBacktestMessage(data) {
    const type = data.type;

    // 1. Mensajes de Configuración y Estado
    if (type === 'backtest_loaded') {
        if (window.handleBacktestLoaded) handleBacktestLoaded(data);
        return true;
    }
    if (type === 'backtest_progress') {
        if (window.handleBacktestProgress) handleBacktestProgress(data);
        return true;
    }
    if (type === 'backtest_cancelled') {
        if (window.handleBacktestCancelled) handleBacktestCancelled(data);
        return true;
    }
    if (type === 'backtest_stopped') {
        if (window.backtestState && backtestState.active) {
            if (window.exitBacktestMode) exitBacktestMode();
        }
        return true;
    }

    // 2. Reproducción de Velas (Replay)
    if (type === 'replay_candle' || type === 'replay_batch') {
        if (window.handleReplayBatch) handleReplayBatch(data);
        return true;
    }
    if (type === 'replay_rewind') {
        if (window.handleReplayRewind) handleReplayRewind(data);
        return true;
    }

    // 3. Gestión de Operaciones (Trades)
    if (type === 'trade_opened') {
        if (window.handleTradeOpened) handleTradeOpened(data);
        return true;
    }
    if (type === 'trade_cancelled') {
        if (window.handleTradeCancelled) handleTradeCancelled(data);
        return true;
    }
    if (type === 'trade_closed' || type === 'trade_sl_hit' || type === 'trade_tp_hit') {
        if (window.handleTradeClosed) handleTradeClosed(data);
        return true;
    }

    // 4. Sesiones y Archivos
    if (type === 'backtest_saved') {
        showNotification('Sesión guardada: ' + data.filename, 'success');
        return true;
    }
    if (type === 'sessions_list') {
        if (window.handleSessionsList) handleSessionsList(data.sessions);
        return true;
    }
    if (type === 'backtest_loaded_session') {
        if (window.handleBacktestSessionLoaded) handleBacktestSessionLoaded(data);
        return true;
    }
    if (type === 'backtest_historical_prepend') {
        if (window.handleBacktestHistoricalPrepend) handleBacktestHistoricalPrepend(data);
        return true;
    }
    if (type === 'backtest_csv_ready') {
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.save_csv_dialog(data.content).then(success => {
                if (success) showNotification('Reporte CSV guardado exitosamente', 'success');
            });
        }
        return true;
    }

    return false; // El mensaje no es de backtest
}
