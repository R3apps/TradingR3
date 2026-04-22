import asyncio
import httpx
import json
import datetime
from dataclasses import dataclass
from typing import List, Dict, Any, Callable, Optional

@dataclass
class CandleData:
    time: int  # unix int
    open: float
    high: float
    low: float
    close: float
    volume: int
    complete: bool

class OandaClient:
    def __init__(self, api_key: str, account_id: str, environment: str = "practice"):
        self.api_key = api_key
        self.account_id = account_id
        self.base_url = (
            "https://api-fxpractice.oanda.com/v3"
            if environment == "practice"
            else "https://api-fxtrade.oanda.com/v3"
        )
        self.stream_url = (
            "https://stream-fxpractice.oanda.com/v3"
            if environment == "practice"
            else "https://stream-fxtrade.oanda.com/v3"
        )
        self._client = httpx.AsyncClient(timeout=10.0)

    async def close(self):
        await self._client.aclose()

    @property
    def headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def get_candles(self, instrument: str, granularity: str, count: int = 500) -> List[CandleData]:
        url = f"{self.base_url}/instruments/{instrument}/candles"
        params = {"granularity": granularity, "count": count, "price": "M"}
        
        for attempt in range(3):
            try:
                print(f"[Oanda] Getting candles for {instrument} (Attempt {attempt+1})...")
                response = await self._client.get(url, headers=self.headers, params=params)
                
                if response.status_code == 200:
                    data = response.json()
                    candles = []
                    for c in data.get("candles", []):
                        dt = datetime.datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
                        mid = c["mid"]
                        candles.append(CandleData(
                            time=int(dt.timestamp()),
                            open=float(mid["o"]),
                            high=float(mid["h"]),
                            low=float(mid["l"]),
                            close=float(mid["c"]),
                            volume=int(c["volume"]),
                            complete=c["complete"]
                        ))
                    return candles
                else:
                    err_preview = response.text[:200].replace('\n', ' ')
                    print(f"[Oanda] Error {response.status_code}: {err_preview}...")
                    if response.status_code in [502, 503, 504]:
                        await asyncio.sleep(1) # Wait before retry
                        continue
                    return []
            except Exception as e:
                print(f"[Oanda] get_candles failure (Attempt {attempt+1}): {e}")
                await asyncio.sleep(1)
        return []

    async def get_candles_before(self, instrument: str, granularity: str, before_time_unix: int, count: int = 300) -> List[CandleData]:
        url = f"{self.base_url}/instruments/{instrument}/candles"
        dt = datetime.datetime.fromtimestamp(before_time_unix, tz=datetime.timezone.utc)
        to_str = dt.strftime('%Y-%m-%dT%H:%M:%S.000000000Z')
        params = {"granularity": granularity, "count": count, "to": to_str, "price": "M"}
        try:
            response = await self._client.get(url, headers=self.headers, params=params)
            if response.status_code != 200: return []
            data = response.json()
            candles = []
            for c in data.get("candles", []):
                dt_c = datetime.datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
                ts = int(dt_c.timestamp())
                if ts >= before_time_unix: continue
                mid = c["mid"]
                candles.append(CandleData(
                    time=ts, open=float(mid["o"]), high=float(mid["h"]),
                    low=float(mid["l"]), close=float(mid["c"]),
                    volume=int(c["volume"]), complete=c["complete"]
                ))
            return candles
        except Exception:
            return []

    async def stream_prices(self, instrument: str, callback: Callable):
        url = f"{self.stream_url}/accounts/{self.account_id}/pricing/stream"
        params = {"instruments": instrument}
        while True:
            try:
                # Use a separate client for streaming as it needs infinite timeout
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", url, headers=self.headers, params=params) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line: continue
                            data = json.loads(line)
                            if data.get("type") == "PRICE":
                                dt = datetime.datetime.fromisoformat(data["time"].replace("Z", "+00:00"))
                                tick = {
                                    "time": int(dt.timestamp()),
                                    "bid": float(data["bids"][0]["price"]),
                                    "ask": float(data["asks"][0]["price"]),
                                    "spread": float(data["asks"][0]["price"]) - float(data["bids"][0]["price"])
                                }
                                await callback(tick)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[Oanda] Stream error: {e}. Reconnecting...")
                await asyncio.sleep(2)

    async def get_account_info(self) -> Dict[str, Any]:
        url = f"{self.base_url}/accounts/{self.account_id}/summary"
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=self.headers)
            response.raise_for_status()
            data = response.json()
            summary = data["account"]
            return {
                "balance": float(summary["balance"]),
                "currency": summary["currency"],
                "unrealizedPL": float(summary["unrealizedPL"])
            }
