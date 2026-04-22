import pandas as pd
from collections import deque
from typing import List, Dict, Any, Optional
from .oanda_client import CandleData

class DataManager:
    def __init__(self, max_candles: int = 2000):
        self.max_candles = max_candles
        self.candles = deque(maxlen=max_candles)
        self.current_candle: Optional[CandleData] = None
        self.instrument: str = ""
        self.timeframe: str = ""

    def set_history(self, candles: List[CandleData], instrument: str, timeframe: str):
        self.instrument = instrument
        self.timeframe = timeframe
        self.candles.clear()
        self.current_candle = None
        
        if not candles:
            return

        for candle in candles:
            if candle.complete:
                self.candles.append(candle)
            else:
                self.current_candle = candle

    def prepend_candles(self, new_candles: List[CandleData]):
        """Inserta velas antiguas AL INICIO del buffer, evitando duplicados."""
        if not self.candles:
            self.candles = deque(new_candles, maxlen=self.max_candles)
            return

        oldest_time = self.candles[0].time
        filtered_new = [c for c in new_candles if c.time < oldest_time]
        
        # Combinar: nuevas + actuales, limitando al máximo
        combined = filtered_new + list(self.candles)
        self.candles = deque(combined[-self.max_candles:], maxlen=self.max_candles)

    def add_tick(self, tick: Dict[str, Any]) -> bool:
        tick_time = tick["time"]
        price = (tick["bid"] + tick["ask"]) / 2
        
        if not self.current_candle:
            self.current_candle = CandleData(
                time=tick_time,
                open=price,
                high=price,
                low=price,
                close=price,
                volume=1,
                complete=False
            )
            return True
        
        self.current_candle.high = max(self.current_candle.high, price)
        self.current_candle.low = min(self.current_candle.low, price)
        self.current_candle.close = price
        self.current_candle.volume += 1
        return True

    def close_candle(self):
        if self.current_candle:
            self.current_candle.complete = True
            self.candles.append(self.current_candle)
            self.current_candle = None

    def get_dataframe(self) -> pd.DataFrame:
        if not self.candles and not self.current_candle:
            return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])
            
        # Extracción rápida de atributos del dataclass
        data = [
            {"time": c.time, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume}
            for c in self.candles
        ]
        
        if self.current_candle:
            c = self.current_candle
            data.append({"time": c.time, "open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume})
            
        return pd.DataFrame(data)

    def get_last_candle_dict(self) -> Dict[str, Any]:
        if self.current_candle:
            c = self.current_candle
        elif self.candles:
            c = self.candles[-1]
        else:
            return {}
            
        return {
            "time": c.time,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
            "volume": c.volume
        }
