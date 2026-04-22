import os
import json
import asyncio
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from typing import List, Dict, Any
from .oanda_client import OandaClient
from .binance_client import BinanceClient
from .data_manager import DataManager
from .indicators import calculate_indicators, update_last_candle
from .replay_engine import ReplayEngine
import pandas as pd
from datetime import datetime, timezone
from .backtest_handlers import handle_backtest_message


replay_engine = ReplayEngine()
SESSION_FILE = "session.json"

def load_session_file():
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return None

def save_session_file(data):
    try:
        with open(SESSION_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[SERVER] Error saving session: {e}")

import os
import sys

def resource_path(relative_path):
    """ Obtiene la ruta absoluta para recursos, compatible con PyInstaller """
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

app = FastAPI()
app.mount("/frontend", StaticFiles(directory=resource_path("frontend")), name="frontend")

@app.get("/api/config/status")
async def get_config_status():
    """Verifica si OANDA está configurado y devuelve el instrumento por defecto."""
    is_configured = bool(config.get("oanda", {}).get("api_key") and config.get("oanda", {}).get("account_id"))
    hide_wizard = config.get("hide_wizard", False)
    default_inst = config.get("default_instrument", "GBP_USD")
    
    # Si no hay OANDA, forzar BTCUSDT de Binance como sugerencia
    if not is_configured:
        default_inst = "BTCUSDT"
        
    return {
        "oanda_configured": is_configured, 
        "hide_wizard": hide_wizard,
        "default_instrument": default_inst
    }

@app.post("/api/config/save")
async def save_config(new_data: Dict[str, Any]):
    """Guarda la configuración de OANDA en config.json."""
    global config, oanda
    try:
        if "api_key" in new_data:
            config["oanda"]["api_key"] = new_data.get("api_key", "")
        if "account_id" in new_data:
            config["oanda"]["account_id"] = new_data.get("account_id", "")
        if "environment" in new_data:
            config["oanda"]["environment"] = new_data.get("environment", "practice")
        
        if "hide_wizard" in new_data:
            config["hide_wizard"] = bool(new_data["hide_wizard"])
        
        with open("config.json", "w") as f:
            json.dump(config, f, indent=2)
        
        # Re-inicializar cliente OANDA
        oanda = OandaClient(
            api_key=config["oanda"]["api_key"],
            account_id=config["oanda"]["account_id"],
            environment=config["oanda"]["environment"]
        )
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/instruments")
async def get_instruments():
    """Obtiene instrumentos de OANDA y Binance."""
    import httpx
    oanda_instruments = []
    binance_instruments = []
    
    # Intentar OANDA
    if config["oanda"]["api_key"]:
        try:
            url = f"{oanda.base_url}/accounts/{oanda.account_id}/instruments"
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, headers=oanda.headers)
                if response.status_code == 200:
                    data = response.json()
                    for inst in data.get('instruments', []):
                        oanda_instruments.append({
                            'symbol': inst.get('name', ''),
                            'display': inst.get('displayName', ''),
                            'type': inst.get('type', 'CFD'),
                            'pip': inst.get('pipLocation', -4),
                            'provider': 'OANDA'
                        })
        except Exception:
            pass

    # Intentar Binance
    try:
        symbols = await binance.get_exchange_info()
        for s in symbols:
            binance_instruments.append({
                **s,
                'provider': 'BINANCE'
            })
    except Exception:
        pass

    # Sort OANDA
    oanda_instruments.sort(key=lambda x: (
        0 if x['type'] == 'CURRENCY' else 1 if x['type'] == 'METAL' else 2,
        x['symbol']
    ))
    
    return {'instruments': oanda_instruments + binance_instruments}



# Load config
try:
    with open("config.json", "r") as f:
        config = json.load(f)
except Exception:
    config = {
        "oanda": {"api_key": "", "account_id": "", "environment": "practice"},
        "hide_wizard": False,
        "default_instrument": "GBP_USD",
        "default_timeframe": "M5",
        "indicators": {"RSI": {"period": 14}, "STOCH": {"k": 14, "d": 3, "smooth_k": 3}}
    }

oanda = OandaClient(
    api_key=config["oanda"]["api_key"],
    account_id=config["oanda"]["account_id"],
    environment=config["oanda"]["environment"]
)
binance = BinanceClient()

clients: List[WebSocket] = []

TIMEFRAME_SECONDS = {
    "M1": 60, "M5": 300, "M15": 900, "M30": 1800,
    "H1": 3600, "H4": 14400, "D": 86400, "W": 604800
}

async def handle_load_more(websocket: WebSocket, data: Dict[str, Any], local_data_manager: DataManager):
    instrument = local_data_manager.instrument
    timeframe = local_data_manager.timeframe
    before_time = data.get("before_time")
    
    try:
        if "_" in instrument:
            new_candles = await oanda.get_candles_before(instrument, timeframe, before_time, 200)
        else:
            new_candles = await binance.get_candles_before(instrument, timeframe, before_time, 200)
        
        if not new_candles:
            await websocket.send_json({"type": "historical_data", "candles": [], "has_more": False, "instrument": instrument})
            return
        
        local_data_manager.prepend_candles(new_candles)
        
        df = local_data_manager.get_dataframe()
        indicators = calculate_indicators(df, config["indicators"])
        
        await websocket.send_json({
            "type": "historical_data",
            "instrument": instrument,
            "candles": [c.__dict__ for c in new_candles],
            "indicators": indicators,
            "has_more": len(new_candles) >= 190
        })
    except Exception:
        await websocket.send_json({"type": "historical_data", "candles": [], "has_more": False, "instrument": instrument})

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # Restaurar sesión al conectar
    saved_session = load_session_file()
    if saved_session:
        await websocket.send_json({
            "type": "session_restored",
            "state": saved_session
        })
    
    # Cola para envío secuencial de mensajes (evita errores ASGI)
    send_queue = asyncio.Queue()

    async def sender_task():
        try:
            while True:
                msg = await send_queue.get()
                try:
                    await websocket.send_json(msg)
                except (ConnectionResetError, Exception) as e:
                    # Silenciar errores de conexión comunes en Windows
                    break 
                finally:
                    send_queue.task_done()
        except asyncio.CancelledError:
            pass

    # Tarea de envío persistente (capturada para limpieza)
    sender_task_handle = asyncio.create_task(sender_task())

    async def safe_send(msg):
        await send_queue.put(msg)

    # Estado encapsulado
    state = {
        "dm": DataManager(),
        "stream_task": None,
        "sub_task": None
    }

    from .backtest_handlers import handle_backtest_message
    from .live_handlers import handle_live_message

    try:
        while True:
            data = await websocket.receive_json()
            dtype = data.get("type")
            
            # 1. Delegar mensajes de Backtest / Replay
            if dtype and (dtype.startswith('backtest_') or dtype.startswith('replay_') or dtype.startswith('trade_')):
                await handle_backtest_message(
                    data, websocket, state, replay_engine, safe_send, 
                    config, oanda, binance, load_all_candles
                )

            # 2. Delegar persistencia de dibujos (usado por ambos modos)
            elif dtype in ['save_drawings', 'load_drawings']:
                await handle_backtest_message(
                    data, websocket, state, replay_engine, safe_send, 
                    config, oanda, binance, load_all_candles
                )

            # 3. Delegar mensajes de Live Trading
            elif dtype in ["subscribe", "change_timeframe", "load_more"]:
                await handle_live_message(
                    data, websocket, state, safe_send, 
                    config, oanda, binance, replay_engine
                )
            
            # 4. Guardar Sesión (Persistencia en Disco)
            elif dtype == "save_session":
                save_session_file(data.get("state", {}))
    except WebSocketDisconnect:
        # Limpieza al desconectar
        if state["stream_task"]:
            state["stream_task"].cancel()
        if state["sub_task"]:
            state["sub_task"].cancel()
    except Exception as e:
        print(f"[SERVER] WebSocket Endpoint Error: {e}")
    finally:
        # Limpieza total al desconectar o fallar
        if state["stream_task"]:
            state["stream_task"].cancel()
        if state["sub_task"]:
            state["sub_task"].cancel()
        sender_task_handle.cancel()
        print(f"[SERVER] Connection finished.")

async def load_all_candles(instrument, granularity, from_date, progress_cb=None):
    """Carga velas desde from_date hasta hoy usando el cliente apropiado (OANDA o Binance)."""
    import asyncio
    import httpx
    from .oanda_client import CandleData
    from datetime import datetime, timezone, timedelta
    
    # Limpieza extrema de la fecha para evitar el bug de 2026
    clean_date = str(from_date).strip().replace('"', '').replace("'", "").split('T')[0]
    print(f"[LOADER] Procesando solicitud de carga desde fecha limpia: '{clean_date}'")
    
    try:
        dt_start = datetime.strptime(clean_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except Exception as e:
        print(f"[ERROR] Formato de fecha inválido: '{from_date}'. Usando 2024-01-01 por defecto.")
        dt_start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    
    # Decidir qué proveedor usar
    provider = "OANDA" if "_" in instrument else "BINANCE"
    
    all_candles = []
    now = datetime.now(timezone.utc)
    total_days = (now - dt_start).days or 1
    
    # Límite de seguridad: 500.000 velas
    MAX_TOTAL = 500000 
    
    if provider == "OANDA":
        current_from = dt_start.strftime('%Y-%m-%dT%H:%M:%S.000000000Z')
        url = f"{oanda.base_url}/instruments/{instrument}/candles"
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            while len(all_candles) < MAX_TOTAL:
                params = {
                    "granularity": granularity,
                    "count": 5000, 
                    "from": current_from,
                    "price": "M",
                    "includeFirst": "False" if all_candles else "True"
                }
                
                try:
                    print(f"Loading OANDA batch starting at {current_from} (Total so far: {len(all_candles)})")
                    response = await client.get(url, headers=oanda.headers, params=params)
                    
                    if response.status_code == 400:
                        params["count"] = 500
                        response = await client.get(url, headers=oanda.headers, params=params)
                    response.raise_for_status()
                    data = response.json()
                    
                    batch = data.get("candles", [])
                    if not batch:
                        break
                    
                    for c in batch:
                        dt_c = datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
                        mid = c["mid"]
                        all_candles.append(CandleData(
                            time=int(dt_c.timestamp()),
                            open=float(mid["o"]),
                            high=float(mid["h"]),
                            low=float(mid["l"]),
                            close=float(mid["c"]),
                            volume=int(c["volume"]),
                            complete=c["complete"]
                        ))
                    
                    last_time_str = batch[-1]["time"]
                    last_time_dt = datetime.fromisoformat(last_time_str.replace("Z", "+00:00"))
                    
                    # Calcular progreso con precisión de segundos
                    if progress_cb:
                        total_seconds = (now - dt_start).total_seconds()
                        if total_seconds > 0:
                            elapsed_seconds = (last_time_dt - dt_start).total_seconds()
                            pct = min(99, int((elapsed_seconds / total_seconds) * 100))
                            await progress_cb(pct, len(all_candles))

                    if now - last_time_dt < timedelta(minutes=10): break
                    if current_from == last_time_str: break
                    current_from = last_time_str
                    await asyncio.sleep(0.01)
                except asyncio.CancelledError: raise
                except Exception as e:
                    print(f"Error loading OANDA candles: {e}")
                    break
    else:
        # BINANCE
        current_ts = int(dt_start.timestamp() * 1000)
        async with httpx.AsyncClient(timeout=60.0) as client:
            while len(all_candles) < MAX_TOTAL:
                try:
                    interval = binance.interval_map.get(granularity, "5m")
                    params = {
                        "symbol": instrument.upper(),
                        "interval": interval,
                        "startTime": current_ts,
                        "limit": 1000
                    }
                    
                    print(f"Loading Binance batch starting at {datetime.fromtimestamp(current_ts/1000)} (Total so far: {len(all_candles)})")
                    response = await client.get(binance.base_url + "/klines", params=params)
                    response.raise_for_status()
                    data = response.json()
                    
                    if not data:
                        break
                    
                    batch_candles = [CandleData(
                        time=int(c[0] / 1000), open=float(c[1]), high=float(c[2]), low=float(c[3]), 
                        close=float(c[4]), volume=int(float(c[5])), complete=True
                    ) for c in data]
                    
                    all_candles.extend(batch_candles)
                    
                    last_ts = data[-1][0]
                    if last_ts <= current_ts: break
                    current_ts = last_ts + 1
                    
                    last_dt = datetime.fromtimestamp(last_ts/1000, timezone.utc)
                    if progress_cb:
                        elapsed_days = (last_dt - dt_start).days
                        pct = min(99, int((elapsed_days / total_days) * 100))
                        await progress_cb(pct, len(all_candles))

                    if last_dt > now - timedelta(minutes=10):
                        break
                    await asyncio.sleep(0.01)
                except asyncio.CancelledError: raise
                except Exception as e:
                    print(f"Error loading Binance candles: {e}")
                    break

                
    print(f"Total candles loaded: {len(all_candles)}")
    return all_candles
