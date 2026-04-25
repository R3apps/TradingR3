import asyncio
import json
import os
import io
import csv
import datetime
from .data_manager import DataManager
from .indicators import calculate_indicators

async def handle_backtest_message(data, websocket, state, replay_engine, safe_send, config, oanda, binance, load_all_candles):
    """
    Dispatcher central para todos los mensajes de Backtest/Replay.
    Mueve la lógica fuera de websocket_server.py para mayor limpieza.
    """
    msg_type = data.get("type")

    if msg_type == 'backtest_start':
        instrument = data.get('instrument', 'GBP_USD').replace('/', '_')
        granularity = data.get('timeframe', 'M5')
        
        # Normalización agresiva de la fecha
        raw_date = data.get('from_date', '2024-01-01')
        target_date_str = str(raw_date).strip().split('T')[0]
        
        # BÚFER HISTÓRICO DINÁMICO: Evitar saturar el límite de 500k velas en temporalidades cortas
        try:
            target_dt = datetime.datetime.strptime(target_date_str, '%Y-%m-%d')
            
            # Ajustar margen según temporalidad para precisión y rendimiento
            days_buffer = 365
            if granularity == 'M1':
                days_buffer = 30  # 30 días en M1 son ~43k velas (Seguro y rápido)
            elif granularity == 'M5':
                days_buffer = 90  # 90 días en M5 son ~26k velas
                
            from_date_dt = target_dt - datetime.timedelta(days=days_buffer)
            from_date = from_date_dt.strftime('%Y-%m-%d')
        except Exception as e:
            print(f"[SERVER] Error calculating buffer date: {e}")
            from_date = '2024-01-01'
            target_date_str = from_date
            
        initial_balance = float(data.get('balance', 10000))
        print(f"[SERVER] Backtest Start: {instrument} | TF: {granularity} | Target: {target_date_str} (Loading from {from_date})")

        async def progress_cb(percent, total):
            try:
                await safe_send({"type": "backtest_progress", "percent": percent, "count": total})
            except: pass

        async def run_loading():
            try:
                # 1. Cargar velas históricas (con el búfer de 1 año)
                all_candles = await load_all_candles(instrument, granularity, from_date, progress_cb)
                if not all_candles:
                    await safe_send({"type": "error", "message": "No se encontraron datos para este periodo"})
                    return
                
                # ORDENAR CRONOLÓGICAMENTE
                all_candles = sorted(all_candles, key=lambda x: x.time)

                # 2. Calcular indicadores
                print(f"Calculando indicadores para {len(all_candles)} velas...")
                dummy_dm = DataManager(max_candles=500000)
                dummy_dm.set_history(all_candles, instrument, granularity)
                df = dummy_dm.get_dataframe()
                indicators = calculate_indicators(df, config["indicators"])
                print("Indicadores calculados.")

                # 3. Preparar lista de velas compacta
                candles_list = [
                    {'time': c.time, 'open': c.open, 'high': c.high, 'low': c.low, 'close': c.close, 'volume': c.volume}
                    for c in all_candles
                ]

                # 4. Inicializar motor
                print("[REPLAY-ENGINE] Iniciando sesión de backtest con historial...")
                replay_engine.start_session(
                    candles_list, 
                    instrument, 
                    granularity, 
                    initial_balance,
                    indicators=indicators,
                    from_date=from_date,
                    start_date=target_date_str
                )
                print(f"[REPLAY-ENGINE] Sesión lista. Índice de inicio localizado.")

                # 5. Enviar mensaje de carga
                await safe_send({
                    'type': 'backtest_loaded',
                    'total_candles': len(all_candles),
                    'instrument': instrument,
                    'timeframe': granularity,
                    'balance': initial_balance,
                    'from_date': from_date,
                    'target_date': target_date_str
                })
                # 6. Enviar lote inicial con ventana de 500 velas (lazy scroll)
                start_idx = replay_engine.state.current_index
                window_data = replay_engine.get_candles_window(start_idx, window=500)

                await safe_send({
                    "type":             "replay_batch",
                    "candles":          window_data["candles"],
                    "indicators":       window_data["indicators"],
                    "all_indicators":   window_data["indicators"], # Compatibilidad con nombres en frontend
                    "target_date":      target_date_str,
                    "current_index":    start_idx, # Global index
                    "global_offset":    window_data["global_offset"],
                    "total":            len(all_candles),
                    "has_more_history": window_data["has_more_history"],
                    "balance":          replay_engine.state.balance,
                    "open_trades":      [t.__dict__ for t in replay_engine.state.open_trades],
                    "pending_trades":   [t.__dict__ for t in replay_engine.state.pending_trades],
                    "closed_trades":    [t.__dict__ for t in replay_engine.state.closed_trades],
                })

                print(f"[REPLAY-ENGINE] Backtest listo. Ventana enviada: {len(window_data['candles'])} velas. Futuro oculto tras el índice global {start_idx}")

            except asyncio.CancelledError:
                print("Carga de backtest cancelada por el usuario.")
            except Exception as e:
                import traceback
                traceback.print_exc()
                await safe_send({"type": "error", "message": f"Error cargando backtest: {str(e)}"})

        websocket.active_backtest_load_task = asyncio.create_task(run_loading())

    elif msg_type == 'backtest_change_timeframe':
        # Cambio de temporalidad en caliente
        if not replay_engine.state or not replay_engine.state.instrument:
            return
            
        new_tf = data.get('timeframe', 'M5')
        instrument = replay_engine.state.instrument
        # OBTENEMOS EL TIMESTAMP EXACTO DE LA VELA ACTUAL
        current_candle = replay_engine.get_current_candle()
        current_ts = current_candle['time'] if current_candle else None
        
        # Fecha base para el búfer (como string YYYY-MM-DD)
        current_date_str = datetime.datetime.fromtimestamp(current_ts).strftime('%Y-%m-%d') if current_ts else replay_engine.state.from_date
        
        # Preservar trades y balance actual
        current_balance = replay_engine.state.balance
        current_open_trades = replay_engine.state.open_trades
        current_closed_trades = replay_engine.state.closed_trades
        replay_engine.stop_play()

        async def run_tf_change():
            try:
                # 1. Calcular búfer dinámico para el nuevo TF (Evitar saturar 500k velas)
                days_buffer = 365
                if new_tf == 'M1':
                    days_buffer = 30
                elif new_tf == 'M5':
                    days_buffer = 90
                    
                target_dt = datetime.datetime.strptime(current_date_str, '%Y-%m-%d')
                buffer_date = (target_dt - datetime.timedelta(days=days_buffer)).strftime('%Y-%m-%d')
                
                print(f"[SERVER] Changing TF to {new_tf}. Focus on Timestamp {current_ts}")
                
                # 2. Cargar nuevas velas con feedback de progreso
                all_candles = await load_all_candles(
                    instrument, new_tf, buffer_date, 
                    progress_cb=lambda p, c: safe_send({
                        "type": "backtest_progress", "percent": p, "count": c
                    })
                )
                all_candles = sorted(all_candles, key=lambda x: x.time)
                
                dummy_dm = DataManager(max_candles=500000)
                dummy_dm.set_history(all_candles, instrument, new_tf)
                indicators = calculate_indicators(dummy_dm.get_dataframe(), config["indicators"])
                
                candles_list = [
                    {'time': c.time, 'open': c.open, 'high': c.high, 'low': c.low, 'close': c.close, 'volume': c.volume}
                    for c in all_candles
                ]

                # 3. Reiniciar motor preservando balance y trades (USANDO EL TIMESTAMP EXACTO)
                replay_engine.start_session(
                    candles_list, instrument, new_tf, current_balance, 
                    indicators=indicators, from_date=buffer_date, start_date=current_ts
                )
                replay_engine.state.open_trades = current_open_trades
                replay_engine.state.closed_trades = current_closed_trades
                
                idx = replay_engine.state.current_index
                window_data = replay_engine.get_candles_window(idx, window=500)

                await safe_send({
                    "type":             "replay_batch",
                    "candles":          window_data["candles"],
                    "indicators":       window_data["indicators"],
                    "all_indicators":   window_data["indicators"],
                    "target_date":      current_date_str,
                    "from_date":        buffer_date,
                    "instrument":       instrument,
                    "timeframe":        new_tf,
                    "current_index":    idx, # Absolute index
                    "global_offset":    window_data["global_offset"],
                    "total":            len(candles_list),
                    "has_more_history": window_data["has_more_history"],
                    "balance":          current_balance,
                    "open_trades":      [t.__dict__ for t in replay_engine.state.open_trades],
                    "pending_trades":   [t.__dict__ for t in replay_engine.state.pending_trades],
                    "closed_trades":    [t.__dict__ for t in replay_engine.state.closed_trades],
                    "is_tf_change":     True,
                })
                
                await safe_send({
                    "type": "backtest_loaded",
                    "instrument": instrument,
                    "timeframe": new_tf,
                    "target_date": current_date_str
                })
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"Error en cambio de TF: {e}")

        asyncio.create_task(run_tf_change())

    elif msg_type == 'backtest_cancel_load':
        if hasattr(websocket, 'active_backtest_load_task') and websocket.active_backtest_load_task:
            websocket.active_backtest_load_task.cancel()
            websocket.active_backtest_load_task = None
        await safe_send({"type": "backtest_cancelled"})

    elif msg_type == 'backtest_stop':
        replay_engine.stop_play()
        replay_engine.state = None
        await safe_send({'type': 'backtest_stopped'})
        state["dm"] = DataManager()

    elif msg_type == 'replay_play':
        if replay_engine.state:
            if hasattr(replay_engine, '_play_task') and replay_engine._play_task:
                replay_engine._play_task.cancel()
            
            replay_engine.state.speed = float(data.get('speed', 1))
            replay_engine.state.is_playing = True
            
            async def send_cb(msg):
                try: await safe_send(msg)
                except: pass
            
            replay_engine._play_task = asyncio.create_task(
                replay_engine.start_play(replay_engine.state.speed, send_cb)
            )

    elif msg_type == 'replay_pause':
        if replay_engine.state:
            replay_engine.stop_play()
            await safe_send({
                'type': 'replay_paused',
                'current_index': replay_engine.state.current_index
            })

    elif msg_type == 'replay_step':
        if replay_engine.state:
            direction = data.get('direction', 'forward')
            bars = int(data.get('bars', 1))
            if direction == 'forward':
                revealed, closed_trades = replay_engine.step_forward(bars)
                for c in revealed:
                    ind = replay_engine.get_current_indicators()
                    await safe_send({
                        'type': 'replay_candle',
                        'candle': c,
                        'indicators': {
                            'rsi': ind['rsi'][-1] if ind['rsi'] else None,
                            'stoch_k': ind['stoch_k'][-1] if ind['stoch_k'] else None,
                            'stoch_d': ind['stoch_d'][-1] if ind['stoch_d'] else None
                        },
                        'current_index': replay_engine.state.current_index,
                        'total': len(replay_engine.state.all_candles),
                        'balance': replay_engine.state.balance,
                        'open_trades': [t.__dict__ for t in replay_engine.state.open_trades],
                        'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades],
                        'closed_trades': [t.__dict__ for t in replay_engine.state.closed_trades],
                        'stats': replay_engine.get_statistics()
                    })
                
                # Notificar trades cerrados en paso manual
                for t in closed_trades:
                    type_hit = 'trade_sl_hit' if t.result == 'SL' else 'trade_tp_hit'
                    await safe_send({
                        'type': type_hit,
                        'trade': t.__dict__,
                        'balance': replay_engine.state.balance,
                        'stats': replay_engine.get_statistics()
                    })
            else:
                new_idx = replay_engine.step_backward(bars)
                visible = replay_engine.get_visible_candles()
                ind = replay_engine.get_current_indicators()
                await safe_send({
                    'type': 'replay_rewind',
                    'candles': visible,
                    'indicators': ind,
                    'current_index': new_idx,
                    'total': len(replay_engine.state.all_candles),
                    'open_trades': [t.__dict__ for t in replay_engine.state.open_trades],
                    'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades],
                    'closed_trades': [t.__dict__ for t in replay_engine.state.closed_trades],
                    'balance': replay_engine.state.balance,
                    'stats': replay_engine.get_statistics()
                })

    elif msg_type == 'backtest_load_more_history':
        if not replay_engine.state:
            return

        current_offset = int(data.get('current_offset', 0))
        count          = int(data.get('count', 300))

        if current_offset <= 0:
            await safe_send({
                "type":       "backtest_historical_prepend",
                "candles":    [],
                "indicators": {},
                "has_more":   False,
                "new_offset": 0,
            })
            return

        page = replay_engine.get_historical_page(current_offset, count)

        await safe_send({
            "type":       "backtest_historical_prepend",
            "candles":    page["candles"],
            "indicators": page["indicators"],
            "has_more":   page["has_more"],
            "new_offset": page["new_offset"],
        })

    elif msg_type == 'replay_seek':
        if replay_engine.state:
            local_index     = int(data.get('index', 0))
            frontend_offset = int(data.get('frontend_offset', 0))
            global_index    = frontend_offset + local_index
            global_index    = max(0, min(global_index, len(replay_engine.state.all_candles) - 1))
            replay_engine.state.current_index = global_index
            visible = replay_engine.get_visible_candles()
            ind = replay_engine.get_current_indicators()
            await safe_send({
                'type': 'replay_rewind',
                'candles': visible,
                'indicators': ind,
                'current_index': replay_engine.state.current_index,
                'total': len(replay_engine.state.all_candles),
                'open_trades': [t.__dict__ for t in replay_engine.state.open_trades],
                'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades],
                'closed_trades': [t.__dict__ for t in replay_engine.state.closed_trades],
                'balance': replay_engine.state.balance,
                'stats': replay_engine.get_statistics()
            })

    elif msg_type == 'trade_open':
        if replay_engine.state:
            trade = replay_engine.open_trade(
                direction=data.get('direction', 'BUY'),
                lot_size=float(data.get('lot_size', 0.01)),
                stop_loss=float(data['stop_loss']) if data.get('stop_loss') else None,
                take_profit=float(data['take_profit']) if data.get('take_profit') else None,
                entry_price=float(data['entry_price']) if data.get('entry_price') else None,
                risk_percent=float(data.get('risk_percent', 0.0))
            )
            await safe_send({
                'type': 'trade_opened',
                'trade': trade.__dict__,
                'balance': replay_engine.state.balance,
                'open_trades': [t.__dict__ for t in replay_engine.state.open_trades],
                'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades],
                'closed_trades': [t.__dict__ for t in replay_engine.state.closed_trades],
                'stats': replay_engine.get_statistics()
            })

    elif msg_type == 'trade_cancel_pending':
        if replay_engine.state:
            success = replay_engine.cancel_pending_trade(data.get('trade_id'))
            if success:
                await safe_send({
                    'type': 'trade_cancelled',
                    'trade_id': data.get('trade_id'),
                    'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades]
                })

    elif msg_type == 'trade_close':
        if replay_engine.state:
            trade = replay_engine.close_trade(data.get('trade_id'))
            if trade:
                await safe_send({
                    'type': 'trade_closed',
                    'trade': trade.__dict__,
                    'balance': replay_engine.state.balance,
                    'open_trades': [t.__dict__ for t in replay_engine.state.open_trades],
                    'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades],
                    'closed_trades': [t.__dict__ for t in replay_engine.state.closed_trades],
                    'stats': replay_engine.get_statistics()
                })

    elif msg_type == 'trade_update_notes':
        if replay_engine.state:
            trade_id = data.get('trade_id')
            notes = data.get('notes', '')
            for t in replay_engine.state.open_trades + replay_engine.state.closed_trades:
                if t.id == trade_id:
                    t.notes = notes
                    break
            await safe_send({'type': 'notes_updated', 'trade_id': trade_id})

    elif msg_type == 'backtest_save':
        if replay_engine.state:
            replay_engine.state.drawings = data.get('drawings', [])
            filename = replay_engine.save_session()
            await safe_send({'type': 'backtest_saved', 'filename': filename})

    elif msg_type == 'backtest_export_csv':
        if replay_engine.state:
            content = replay_engine.export_csv()
            await safe_send({'type': 'backtest_csv_ready', 'content': content})

    elif msg_type == 'backtest_load':
        filename = data.get('filename')
        session_data = None
        
        if filename:
            path = os.path.join("backtests", filename)
            if os.path.exists(path):
                with open(path, 'r') as f:
                    session_data = json.load(f)
            else:
                await safe_send({'type': 'error', 'message': 'Archivo de sesión no encontrado'})
                return
        else:
            session_data = data.get('data', {})
        
        if not session_data:
            await safe_send({'type': 'error', 'message': 'No hay datos para cargar'})
            return

        if state["stream_task"]:
            state["stream_task"].cancel()
            state["stream_task"] = None

        replay_engine.load_session(session_data)
        
        # Enviamos TODO el historial (incluyendo el año extra de indicadores)
        all_c = replay_engine.state.all_candles
        all_i = replay_engine.state.all_indicators
        
        await safe_send({
            'type': 'backtest_loaded_session',
            'candles': all_c,
            'all_indicators': all_i,
            'current_index': replay_engine.state.current_index,
            'total': len(replay_engine.state.all_candles),
            'balance': replay_engine.state.balance,
            'instrument': replay_engine.state.instrument,
            'granularity': replay_engine.state.granularity,
            'open_trades': [t.__dict__ for t in replay_engine.state.open_trades],
            'pending_trades': [t.__dict__ for t in replay_engine.state.pending_trades],
            'closed_trades': [t.__dict__ for t in replay_engine.state.closed_trades],
            'initial_balance': replay_engine.state.initial_balance,
            'stats': replay_engine.get_statistics(),
            'drawings': replay_engine.state.drawings or []
        })

    elif msg_type == 'backtest_delete_session':
        filename = data.get('filename')
        if filename:
            success = replay_engine.delete_session(filename)
            if success:
                sessions = replay_engine.list_sessions()
                await safe_send({'type': 'sessions_list', 'sessions': sessions})

    elif msg_type == 'backtest_list_sessions':
        sessions = replay_engine.list_sessions()
        await safe_send({'type': 'sessions_list', 'sessions': sessions})

    elif msg_type == 'save_drawings':
        instrument = data.get('instrument')
        drawings = data.get('drawings', [])
        is_bt = data.get('is_backtest', False)
        suffix = "_bt" if is_bt else ""
        if instrument:
            os.makedirs("drawings", exist_ok=True)
            path = os.path.join("drawings", f"{instrument}{suffix}.json")
            with open(path, 'w') as f:
                json.dump(drawings, f)
            await safe_send({'type': 'drawings_saved', 'instrument': instrument, 'is_backtest': is_bt})

    elif msg_type == 'load_drawings':
        instrument = data.get('instrument')
        is_bt = data.get('is_backtest', False)
        suffix = "_bt" if is_bt else ""
        if instrument:
            path = os.path.join("drawings", f"{instrument}{suffix}.json")
            drawings = []
            if os.path.exists(path):
                try:
                    with open(path, 'r') as f:
                        drawings = json.load(f)
                except: drawings = []
            
            await safe_send({
                'type': 'drawings_loaded', 
                'instrument': instrument, 
                'drawings': drawings, 
                'is_backtest': bool(is_bt)
            })
