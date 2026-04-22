import pandas as pd
try:
    import pandas_ta_classic as ta
    HAS_PANDAS_TA = True
except Exception as e:
    print(f"Warning: pandas_ta_classic could not be loaded ({e}). Using native fallback.")
    HAS_PANDAS_TA = False

import math
from typing import Dict, List, Any

def calculate_rsi_native(series, period=14):
    """Cálculo nativo de RSI (Wilder/RMA) como fallback"""
    delta = series.diff()
    gain = (delta.where(delta > 0, 0))
    loss = (-delta.where(delta < 0, 0))
    
    # Usar EWM para aproximar el RMA de Wilder que usa pandas-ta
    avg_gain = gain.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))

def calculate_stoch_native(df, k=14, d=3, smooth_k=3):
    """Cálculo nativo de Estocástico como fallback"""
    low_min = df['low'].rolling(window=k).min()
    high_max = df['high'].rolling(window=k).max()
    
    k_series = 100 * (df['close'] - low_min) / (high_max - low_min)
    stoch_k = k_series.rolling(window=smooth_k).mean()
    stoch_d = stoch_k.rolling(window=d).mean()
    
    return stoch_k, stoch_d

def safe_series(series):
    """Elimina entradas con valores nulos o NaN"""
    result = []
    for item in series:
        val = item.get('value')
        if val is None:
            continue
        try:
            f = float(val)
            if not math.isnan(f):
                result.append({'time': item['time'], 'value': round(f, 4)})
        except (TypeError, ValueError):
            continue
    return result

def calculate_indicators(df: pd.DataFrame, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Calculates RSI and Stochastic indicators for a given DataFrame efficiently.
    """
    if df.empty:
        return {"rsi": [], "stoch_k": [], "stoch_d": []}
        
    # RSI
    rsi_config = config.get("RSI") or config.get("rsi") or {"period": 14}
    period = rsi_config.get("period", 14)
    
    # STOCH
    stoch_config = config.get("STOCH") or config.get("stochastic") or {"k": 14, "d": 3, "smooth_k": 3}
    k_val = stoch_config.get("k", 14)
    d_val = stoch_config.get("d", 3)
    smooth_k = stoch_config.get("smooth_k", 3)

    if HAS_PANDAS_TA:
        try:
            rsi = df.ta.rsi(length=period)
            stoch = df.ta.stoch(k=k_val, d=d_val, smooth_k=smooth_k)
        except Exception:
            # Fallback si falla el método .ta
            rsi = calculate_rsi_native(df['close'], period)
            sk, sd = calculate_stoch_native(df, k_val, d_val, smooth_k)
            stoch = pd.DataFrame({'STOCHk': sk, 'STOCHd': sd})
    else:
        # Uso directo de fallback
        rsi = calculate_rsi_native(df['close'], period)
        sk, sd = calculate_stoch_native(df, k_val, d_val, smooth_k)
        stoch = pd.DataFrame({'STOCHk': sk, 'STOCHd': sd})

    # Aseguramos continuidad total
    rsi = rsi.reindex(df.index).ffill().bfill() if rsi is not None else None
    if stoch is not None:
        stoch = stoch.reindex(df.index).ffill().bfill()
    
    def process_series(series):
        if series is None:
            return [], [None] * len(df)
            
        formatted = []
        raw = [None] * len(df)
        
        # Use explicit index alignment to prevent shifting/gaps
        for i, idx in enumerate(df.index):
            try:
                # Use series.get(idx) or loc[idx] to ensure we match the right candle
                val = series.loc[idx] if idx in series.index else None
                if val is not None and pd.notna(val):
                    v_float = round(float(val), 4)
                    t_int = int(df.at[idx, "time"])
                    formatted.append({"time": t_int, "value": v_float})
                    raw[i] = v_float
            except Exception:
                continue
        return formatted, raw

    rsi_formatted, rsi_raw = process_series(rsi)
    
    # Manejo robusto de columnas de estocástico
    stoch_k_ser = stoch.iloc[:, 0] if (stoch is not None and not stoch.empty and len(stoch.columns) > 0) else None
    stoch_d_ser = stoch.iloc[:, 1] if (stoch is not None and not stoch.empty and len(stoch.columns) > 1) else None
    
    sk_formatted, sk_raw = process_series(stoch_k_ser)
    sd_formatted, sd_raw = process_series(stoch_d_ser)

    return {
        "rsi": rsi_formatted,
        "stoch_k": sk_formatted,
        "stoch_d": sd_formatted,
        # Raw aligned series for the replay engine
        "raw": {
            "rsi": rsi_raw,
            "stoch_k": sk_raw,
            "stoch_d": sd_raw
        }
    }

def update_last_candle(df: pd.DataFrame, new_candle_data: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Updates the last candle in the DataFrame and recalculates the last 30 periods.
    """
    if df.empty:
        return {}

    try:
        idx = df.index[-1]
        df.loc[idx, "open"] = new_candle_data["open"]
        df.loc[idx, "high"] = new_candle_data["high"]
        df.loc[idx, "low"] = new_candle_data["low"]
        df.loc[idx, "close"] = new_candle_data["close"]
        df.loc[idx, "volume"] = new_candle_data["volume"]
        
        window = 500 
        if len(df) > window:
            df_tail = df.tail(window).copy()
        else:
            df_tail = df.copy()
            
        indicators = calculate_indicators(df_tail, config)
        
        result = {}
        for key in ["rsi", "stoch_k", "stoch_d"]:
            series = indicators.get(key)
            if series and len(series) > 0:
                last_val = series[-1]
                # Asegurar que el valor es válido antes de agregarlo
                if last_val.get("value") is not None and not math.isnan(float(last_val["value"])):
                    result[key] = last_val
        
        return result
    except Exception:
        return {}

def calculate_indicators_incremental(new_candles_df: pd.DataFrame,
                                      context_df: pd.DataFrame,
                                      config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Calcula indicadores SOLO para new_candles_df usando context_df como warmup.
    context_df: últimas ~100 velas del buffer existente (warmup para RSI/Stoch)
    new_candles_df: las velas nuevas añadidas al inicio (históricas antiguas)
    """
    if new_candles_df.empty:
        return {"rsi": [], "stoch_k": [], "stoch_d": []}

    # El período de warmup necesario:
    rsi_config   = config.get("RSI")   or config.get("rsi")   or {"period": 14}
    stoch_config = config.get("STOCH") or config.get("stochastic") or {"k": 14, "d": 3, "smooth_k": 3}

    period   = rsi_config.get("period", 14)
    k, d, sk = stoch_config.get("k", 14), stoch_config.get("d", 3), stoch_config.get("smooth_k", 3)
    warmup   = max(period, k + sk + d) + 5   # +5 margen de seguridad

    # Combinar: contexto (warmup) + velas nuevas
    # Nota: context_df debe ser el extremo izquierdo de los datos actuales (los más antiguos que ya tenemos)
    # y new_candles_df son los que acabamos de traer de OANDA (aún más antiguos).
    # Así que el orden cronológico es: [new_candles_df] + [context_df]
    # Usamos head(warmup) del context_df porque son los más cercanos en el tiempo a los nuevos (antiguos)
    combined = pd.concat([new_candles_df, context_df.head(warmup)]).sort_values('time').reset_index(drop=True)

    # Calcular sobre el combined
    full_result = calculate_indicators(combined, config)

    # Extraer SOLO los puntos que corresponden a new_candles_df (las marcas de tiempo originales)
    new_times = set(int(t) for t in new_candles_df['time'])

    def filter_to_new(series):
        return [item for item in series if item['time'] in new_times]

    return {
        "rsi":     filter_to_new(full_result["rsi"]),
        "stoch_k": filter_to_new(full_result["stoch_k"]),
        "stoch_d": filter_to_new(full_result["stoch_d"]),
    }
