import asyncio
import httpx
import json
import time
from typing import List, Dict, Any, Callable
from .oanda_client import CandleData

class BinanceClient:
    def __init__(self):
        self.base_url = "https://data-api.binance.vision/api/v3"
        self.ws_url = "wss://stream.binance.com:9443/ws"
        self.interval_map = {
            "M1": "1m",
            "M5": "5m",
            "M15": "15m",
            "M30": "30m",
            "H1": "1h",
            "H4": "4h",
            "D": "1d",
            "W": "1w"
        }

    async def get_candles(self, symbol: str, timeframe: str, count: int = 500) -> List[CandleData]:
        interval = self.interval_map.get(timeframe, "5m")
        url = f"{self.base_url}/klines"
        params = {
            "symbol": symbol.upper(),
            "interval": interval,
            "limit": count
        }
        
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            candles = []
            for i, c in enumerate(data):
                # Binance klines format: [open_time, open, high, low, close, volume, close_time, ...]
                candles.append(CandleData(
                    time=int(c[0] / 1000),
                    open=float(c[1]),
                    high=float(c[2]),
                    low=float(c[3]),
                    close=float(c[4]),
                    volume=int(float(c[5])),
                    complete=(i < len(data) - 1) # Last one might be incomplete
                ))
            return candles

    async def get_candles_before(self, symbol: str, timeframe: str, before_time_unix: int, count: int = 300) -> List[CandleData]:
        interval = self.interval_map.get(timeframe, "5m")
        url = f"{self.base_url}/klines"
        # end_time in ms
        params = {
            "symbol": symbol.upper(),
            "interval": interval,
            "limit": count,
            "endTime": before_time_unix * 1000 - 1
        }
        
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            candles = []
            for c in data:
                candles.append(CandleData(
                    time=int(c[0] / 1000),
                    open=float(c[1]),
                    high=float(c[2]),
                    low=float(c[3]),
                    close=float(c[4]),
                    volume=int(float(c[5])),
                    complete=True
                ))
            return candles

    async def get_candles_by_time(self, symbol: str, timeframe: str, start_time: int, limit: int = 1000) -> List[CandleData]:
        interval = self.interval_map.get(timeframe, "5m")
        url = f"{self.base_url}/klines"
        params = {
            "symbol": symbol.upper(),
            "interval": interval,
            "startTime": start_time,
            "limit": limit
        }
        
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            candles = []
            for c in data:
                candles.append(CandleData(
                    time=int(c[0] / 1000),
                    open=float(c[1]),
                    high=float(c[2]),
                    low=float(c[3]),
                    close=float(c[4]),
                    volume=int(float(c[5])),
                    complete=True
                ))
            return candles

    async def get_exchange_info(self) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/exchangeInfo"
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
            
            symbols = []
            for s in data['symbols']:
                if s['status'] == 'TRADING' and s['quoteAsset'] == 'USDT':
                    symbols.append({
                        'symbol': s['symbol'],
                        'display': f"{s['baseAsset']}/{s['quoteAsset']}",
                        'type': 'CRYPTO',
                        'pip': -int(s['pricePrecision']) if 'pricePrecision' in s else -2
                    })
            
            # Sort by volume or importance? We'll just take top ones for now if too many
            # or return all and filter in frontend.
            return symbols

    async def stream_klines(self, symbol: str, timeframe: str, callback: Callable):
        interval = self.interval_map.get(timeframe, "5m")
        url = f"{self.ws_url}/{symbol.lower()}@kline_{interval}"
        
        import websockets
        
        backoff = 1
        while True:
            try:
                async with websockets.connect(url) as ws:
                    backoff = 1
                    while True:
                        msg = await ws.recv()
                        data = json.loads(msg)
                        k = data['k']
                        
                        tick = {
                            "time": int(data['E'] / 1000),
                            "open": float(k['o']),
                            "high": float(k['h']),
                            "low": float(k['l']),
                            "close": float(k['c']),
                            "volume": float(k['v']),
                            "is_closed": k['x'],
                            # For price display compatibility
                            "bid": float(k['c']),
                            "ask": float(k['c']),
                            "spread": 0
                        }
                        await callback(tick)
            except Exception as e:
                print(f"Binance Stream error: {e}. Reconnecting in {backoff}s...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
