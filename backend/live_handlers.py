import asyncio
import json
import os
from .data_manager import DataManager
from .indicators import calculate_indicators, update_last_candle, calculate_indicators_incremental
import pandas as pd
from typing import Dict, Any, List

# Cache global para evitar peticiones repetidas a OANDA durante scroll rápido
_historical_cache: Dict[str, list] = {}  # key: "INSTRUMENT_TF_beforeTime", value: candles list
_CACHE_MAX_ENTRIES = 20  # máximo de entradas en cache

def candles_to_dataframe(candles) -> pd.DataFrame:
    if not candles:
        return pd.DataFrame()
    records = []
    for c in candles:
        if hasattr(c, '__dict__'):
            records.append(c.__dict__)
        elif isinstance(c, dict):
            records.append(c)
    df = pd.DataFrame(records)
    if df.empty:
        return df
    for col in ['open', 'high', 'low', 'close', 'volume', 'time']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')
    return df.sort_values('time').reset_index(drop=True)

async def handle_live_message(data, websocket, state, safe_send, config, oanda, binance, replay_engine=None):
    dtype = data.get("type")
    
    # IMPORTANTE: Ignorar peticiones Live si el motor de backtest está activo para no corromper la sesión
    if replay_engine and replay_engine.state and replay_engine.state.instrument:
        print(f"[SERVER] Ignoring live '{dtype}' request because backtest is active.")
        return

    if dtype in ["subscribe", "change_timeframe"]:
        await handle_subscribe(data, state, safe_send, config, oanda, binance)
    elif dtype == "load_more":
        await handle_load_more(websocket, data, state["dm"], safe_send, config, oanda, binance)

async def handle_subscribe(data, state, safe_send, config, oanda, binance):
    instrument_raw = data.get("instrument", config.get("default_instrument", "GBP_USD"))
    timeframe = data.get("timeframe", config.get("default_timeframe", "M5"))
    instrument = instrument_raw.replace('/', '_')
    
    print(f"\n[SERVER] Subscribing: {instrument}")
    
    if state["stream_task"]:
        state["stream_task"].cancel()
        state["stream_task"] = None

    state["dm"] = DataManager()
    dm = state["dm"]

    try:
        print(f"[SERVER] Fetching candles...")
        candles = await asyncio.wait_for(
            oanda.get_candles(instrument, timeframe, 500) if "_" in instrument else binance.get_candles(instrument, timeframe, 500),
            timeout=10.0
        )
        
        print(f"[SERVER] Received {len(candles)} candles.")
        dm.set_history(candles, instrument, timeframe)
        df = dm.get_dataframe()
        indicators = calculate_indicators(df, config["indicators"])
        
        await safe_send({
            "type": "history", "instrument": instrument, "timeframe": timeframe,
            "candles": df.to_dict('records'), "indicators": indicators
        })
        print(f"[SERVER] History sent to queue.")
        state["stream_task"] = asyncio.create_task(start_local_stream(instrument, timeframe, dm, safe_send, config, oanda, binance))

        # Auto-enviar dibujos al cargar el gráfico
        try:
            draw_path = os.path.join("drawings", f"{instrument}.json")
            if os.path.exists(draw_path):
                with open(draw_path, 'r') as f:
                    saved_drawings = json.load(f)
                    await safe_send({
                        'type': 'drawings_loaded',
                        'instrument': instrument,
                        'drawings': saved_drawings,
                        'is_backtest': False
                    })
                    print(f"[SERVER] Drawings auto-loaded for {instrument}")
        except: pass
        
    except asyncio.TimeoutError:
        await safe_send({"type": "error", "message": f"Timeout loading {instrument}"})
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[SERVER] Error: {e}")
        await safe_send({"type": "error", "message": str(e)})

async def handle_load_more(websocket, data, dm, safe_send, config, oanda, binance):
    if not dm: return
    instrument = data.get("instrument", dm.instrument)
    timeframe  = data.get("timeframe",  dm.timeframe)
    before_time = data.get("before_time")
    count = int(data.get("count", 300))

    if not before_time:
        return

    # 1. Verificar cache
    cache_key = f"{instrument}_{timeframe}_{before_time}"
    if cache_key in _historical_cache:
        print(f"[Cache HIT] {cache_key}")
        cached_candles = _historical_cache[cache_key]
        # Recalcular indicadores incrementalmente con el contexto actual
        if dm.candles:
            # Mandamos las velas más antiguas que ya tenemos como contexto (las de la izquierda)
            context_df = dm.get_dataframe().head(100)
            new_df = candles_to_dataframe(cached_candles)
            indicators = calculate_indicators_incremental(new_df, context_df, config["indicators"])
        else:
            new_df = candles_to_dataframe(cached_candles)
            indicators = calculate_indicators(new_df, config["indicators"])

        await safe_send({
            "type": "historical_data",
            "instrument": instrument,
            "candles": [c.__dict__ if hasattr(c, '__dict__') else c for c in cached_candles],
            "indicators": indicators,
            "has_more": len(cached_candles) >= count
        })
        return

    # 2. Petición a la API
    try:
        print(f"[Cache MISS] Fetching {count} candles before {before_time} for {instrument}")
        new_candles = await (
            oanda.get_candles_before(instrument, timeframe, before_time, count=count)
            if "_" in instrument
            else binance.get_candles_before(instrument, timeframe, before_time, count=count)
        )

        if not new_candles:
            await safe_send({
                "type": "historical_data",
                "instrument": instrument,
                "candles": [],
                "indicators": {"rsi": [], "stoch_k": [], "stoch_d": []},
                "has_more": False
            })
            return

        # 3. Guardar en cache
        _historical_cache[cache_key] = new_candles
        if len(_historical_cache) > _CACHE_MAX_ENTRIES:
            oldest_key = next(iter(_historical_cache))
            del _historical_cache[oldest_key]

        # 4. Calcular indicadores incrementalmente
        if dm.candles:
            context_df = dm.get_dataframe().head(100) # El contexto es lo que ya tenemos a la izquierda
            new_df = candles_to_dataframe(new_candles)
            indicators = calculate_indicators_incremental(new_df, context_df, config["indicators"])
        else:
            new_df = candles_to_dataframe(new_candles)
            indicators = calculate_indicators(new_df, config["indicators"])

        # 5. Actualizar dm
        dm.prepend_candles(new_candles)

        await safe_send({
            "type": "historical_data",
            "instrument": instrument,
            "candles": [c.__dict__ if hasattr(c, '__dict__') else c for c in new_candles],
            "indicators": indicators,
            "has_more": len(new_candles) >= count
        })

    except Exception as e:
        print(f"[ERROR] handle_load_more: {e}")
        await safe_send({
            "type": "historical_data",
            "instrument": instrument,
            "candles": [],
            "indicators": {"rsi": [], "stoch_k": [], "stoch_d": []},
            "has_more": False
        })

async def start_local_stream(instrument: str, timeframe: str, dm: DataManager, safe_send, config, oanda, binance):
    try:
        if "_" in instrument:
            await oanda.stream_prices(instrument, lambda t: local_price_callback(t, instrument, dm, safe_send, config))
        else:
            await binance.stream_klines(instrument, timeframe, lambda t: local_price_callback(t, instrument, dm, safe_send, config))
    except asyncio.CancelledError: raise
    except: pass

async def local_price_callback(tick: Dict[str, Any], instrument: str, dm: DataManager, safe_send, config):
    try:
        if not dm or instrument != dm.instrument: return
        TIMEFRAME_SECONDS = {'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800, 'H1': 3600, 'H4': 14400, 'D': 86400}
        if dm.current_candle:
            duration = TIMEFRAME_SECONDS.get(dm.timeframe, 300)
            if tick["time"] >= dm.current_candle.time + duration: dm.close_candle()
        dm.add_tick(tick)
        df = dm.get_dataframe()
        if df.empty: return
        indicator_update = update_last_candle(df, dm.get_last_candle_dict(), config["indicators"])
        await safe_send({
            "type": "candle_update", "instrument": instrument,
            "candle": dm.get_last_candle_dict(), "indicators_update": indicator_update, "tick": tick
        })
    except: pass
