import asyncio
import json
import uuid
import math
import os
import csv
from datetime import datetime, timezone
import datetime as dt_mod  # Keep a reference for strptime if needed
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any
from pathlib import Path

# Create folders automatically
Path("backtests").mkdir(exist_ok=True)
Path("exports").mkdir(exist_ok=True)

@dataclass
class Trade:
    id: str
    instrument: str
    direction: str               # 'BUY' or 'SELL'
    entry_time: int              # unix timestamp
    entry_price: float
    lot_size: float
    stop_loss: Optional[float]
    take_profit: Optional[float]
    exit_time: Optional[int] = None
    exit_price: Optional[float] = None
    pnl_pips: Optional[float] = None
    pnl_usd: Optional[float] = None
    status: str = 'open'         # 'open' | 'closed' | 'cancelled' | 'future'
    result: Optional[str] = None # 'TP' | 'SL' | 'MANUAL' | None
    risk_percent: float = 0.0
    notes: str = ""

@dataclass
class ReplayState:
    instrument: str
    granularity: str
    all_candles: List[Dict]            # list of dicts with {time,open,high,low,close,volume}
    all_indicators: Dict               # {rsi: [...], stoch_k: [...], stoch_d: [...]}
    current_index: int
    is_playing: bool
    speed: float
    balance: float
    initial_balance: float
    open_trades: List[Trade] = field(default_factory=list)
    closed_trades: List[Trade] = field(default_factory=list)
    future_trades: List[Trade] = field(default_factory=list)
    pending_trades: List[Trade] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    from_date: str = ""
    drawings: List[Dict] = field(default_factory=list)

class ReplayEngine:
    def __init__(self):
        self.state: Optional[ReplayState] = None
        self._play_task = None

    def start_session(self, candles, instrument, granularity, initial_balance, indicators=None, from_date="", start_date=None):
        """Inicializa el estado del replay y busca el índice de inicio real si se provee start_date"""
        
        start_index = 0
        if start_date and candles:
            try:
                # Soporte para timestamp numérico o string de fecha
                if isinstance(start_date, (int, float)):
                    target_ts = float(start_date)
                elif isinstance(start_date, str) and start_date.replace('.','',1).isdigit():
                    target_ts = float(start_date)
                else:
                    # Si es un string de fecha (YYYY-MM-DD), lo convertimos
                    dt_obj = datetime.strptime(start_date.split(' ')[0], '%Y-%m-%d')
                    target_ts = dt_obj.replace(tzinfo=timezone.utc).timestamp()
                
                # Buscar la primera vela que sea >= target_ts
                for i, c in enumerate(candles):
                    if c['time'] >= target_ts:
                        start_index = i
                        print(f"[REPLAY] Found precise starting index {i} for target {target_ts}")
                        break
            except Exception as e:
                print(f"[REPLAY] Error finding start index: {e}")
                start_index = 0

        self.state = ReplayState(
            instrument=instrument,
            granularity=granularity,
            all_candles=candles,
            all_indicators=indicators or {"rsi": [], "stoch_k": [], "stoch_d": []},
            current_index=start_index,
            is_playing=False,
            speed=1.0,
            balance=initial_balance,
            initial_balance=initial_balance,
            open_trades=[],
            closed_trades=[],
            future_trades=[],
            pending_trades=[],
            created_at=datetime.now(timezone.utc).isoformat(),
            from_date=from_date or start_date
        )

    def get_current_candle(self) -> Optional[Dict]:
        """Retorna la vela en current_index"""
        if self.state and 0 <= self.state.current_index < len(self.state.all_candles):
            return self.state.all_candles[self.state.current_index]
        return None

    def get_current_indicators(self) -> Dict:
        """Retorna los indicadores formateados para el frontend hasta current_index inclusive."""
        if not self.state or not self.state.all_indicators:
            return {"rsi": [], "stoch_k": [], "stoch_d": []}
        
        current_candle = self.get_current_candle()
        if not current_candle:
            return {"rsi": [], "stoch_k": [], "stoch_d": []}
            
        # Retornamos los formateados filtrados por tiempo parasetData inicial
        # Pero para steps individuales, esto se puede optimizar
        current_time = current_candle['time']
        
        return {
            "rsi": [x for x in self.state.all_indicators.get("rsi", []) if x['time'] <= current_time],
            "stoch_k": [x for x in self.state.all_indicators.get("stoch_k", []) if x['time'] <= current_time],
            "stoch_d": [x for x in self.state.all_indicators.get("stoch_d", []) if x['time'] <= current_time]
        }

    def _get_current_step_indicator(self, key: str) -> Optional[Dict]:
        """Obtiene el valor del indicador formateado solo para el índice actual (Optimizado)"""
        if not self.state or "raw" not in self.state.all_indicators:
            return None
        
        raw_series = self.state.all_indicators["raw"].get(key, [])
        idx = self.state.current_index
        
        if 0 <= idx < len(raw_series) and raw_series[idx] is not None:
            return {
                "time": self.state.all_candles[idx]["time"],
                "value": raw_series[idx]
            }
        return None

    def get_visible_candles(self) -> List:
        """Retorna todas las velas hasta current_index inclusive"""
        if not self.state:
            return []
        return self.state.all_candles[:self.state.current_index + 1]

    def get_candles_window(self, center_index: int, window: int = 500) -> dict:
        """
        Retorna ventana de velas centrada en center_index.
        Solo velas hasta center_index son visibles (sin spoilers).
        """
        if not self.state:
            return {"candles": [], "indicators": {}, "local_focus": 0, "global_offset": 0, "has_more_history": False}

        import math as _math

        start = max(0, center_index - window)
        end   = center_index + 1

        window_candles = self.state.all_candles[start:end]
        local_focus    = center_index - start
        window_times   = set(c['time'] for c in window_candles)

        def filter_ind(series):
            return [
                x for x in series
                if x.get('time') in window_times
                and x.get('value') is not None
                and not (isinstance(x.get('value'), float) and _math.isnan(x.get('value', 0)))
            ]

        indicators = {
            "rsi":     filter_ind(self.state.all_indicators.get("rsi",     [])),
            "stoch_k": filter_ind(self.state.all_indicators.get("stoch_k", [])),
            "stoch_d": filter_ind(self.state.all_indicators.get("stoch_d", [])),
        }

        return {
            "candles":          window_candles,
            "indicators":       indicators,
            "local_focus":      local_focus,
            "global_offset":    start,
            "has_more_history": start > 0,
        }

    def get_historical_page(self, before_global_index: int, count: int = 300) -> dict:
        """
        Retorna un bloque de velas ANTERIORES a before_global_index.
        Usado cuando el usuario hace scroll hacia atrás en el backtest.
        """
        if not self.state:
            return {"candles": [], "indicators": {}, "has_more": False, "new_offset": 0}

        import math as _math

        end   = before_global_index
        start = max(0, end - count)

        page_candles = self.state.all_candles[start:end]
        page_times   = set(c['time'] for c in page_candles)

        def filter_ind(series):
            return [
                x for x in series
                if x.get('time') in page_times
                and x.get('value') is not None
                and not (isinstance(x.get('value'), float) and _math.isnan(x.get('value', 0)))
            ]

        indicators = {
            "rsi":     filter_ind(self.state.all_indicators.get("rsi",     [])),
            "stoch_k": filter_ind(self.state.all_indicators.get("stoch_k", [])),
            "stoch_d": filter_ind(self.state.all_indicators.get("stoch_d", [])),
        }

        return {
            "candles":    page_candles,
            "indicators": indicators,
            "has_more":   start > 0,
            "new_offset": start,
        }

    def step_forward(self, bars=1) -> tuple[List, List]:
        """Avanza bars velas. Retorna (lista_velas, lista_trades_cerrados)."""
        if not self.state:
            return [], []
            
        revealed = []
        all_closed = []
        for _ in range(bars):
            if self.state.current_index >= len(self.state.all_candles) - 1:
                break
            self.state.current_index += 1
            candle = self.get_current_candle()
            # 1. Restaurar future_trades que correspondan a esta vela
            self._restore_future_trades(candle)
            # 2. Verificar si se activan órdenes pendientes
            self._check_pending_orders(candle)
            # 3. Verificar SL/TP de trades abiertos en esta vela
            closed_in_step = self._check_sl_tp(candle)
            if closed_in_step:
                all_closed.extend(closed_in_step)
            revealed.append(candle)
        return revealed, all_closed

    def step_backward(self, bars=1) -> int:
        """Retrocede bars velas."""
        if not self.state:
            return 0
            
        target = max(0, self.state.current_index - bars)
        new_time = self.state.all_candles[target]['time']

        # Mover trades que están después del nuevo time a future_trades
        self._cancel_trades_after(new_time)

        self.state.current_index = target
        self._recalculate_balance()
        return self.state.current_index

    def seek_to(self, index: int):
        """Salta a un índice específico."""
        if not self.state:
            return
            
        index = max(0, min(index, len(self.state.all_candles) - 1))
        if index < self.state.current_index:
            diff = self.state.current_index - index
            self.step_backward(diff)
        else:
            diff = index - self.state.current_index
            self.step_forward(diff)

    def open_trade(self, direction, lot_size, stop_loss=None, take_profit=None, entry_price=None, risk_percent=0.0) -> Trade:
        """Abre un trade o lo añade a pendientes si el entry_price no se ha tocado."""
        candle = self.get_current_candle()
        
        # Si no hay entry_price, es mercado inmediato
        if entry_price is None:
            entry_price = candle['close']
            is_pending = False
        else:
            # Verificar si el precio de entrada está dentro del rango de la vela actual
            if candle['low'] <= entry_price <= candle['high']:
                is_pending = False
            else:
                is_pending = True
        
        trade = Trade(
            id=str(uuid.uuid4())[:8],
            instrument=self.state.instrument,
            direction=direction,
            entry_time=candle['time'],
            entry_price=entry_price,
            lot_size=lot_size,
            stop_loss=stop_loss,
            take_profit=take_profit,
            status='pending' if is_pending else 'open',
            result=None,
            risk_percent=risk_percent,
            notes=''
        )
        
        if is_pending:
            self.state.pending_trades.append(trade)
        else:
            self.state.open_trades.append(trade)
            
        return trade

    def cancel_pending_trade(self, trade_id) -> bool:
        """Elimina una orden pendiente."""
        if not self.state: return False
        for i, t in enumerate(self.state.pending_trades):
            if t.id == trade_id:
                self.state.pending_trades.pop(i)
                return True
        return False

    def close_trade(self, trade_id) -> Optional[Trade]:
        """Cierra un trade manualmente al precio actual."""
        if not self.state:
            return None
            
        for i, trade in enumerate(self.state.open_trades):
            if trade.id == trade_id:
                candle = self.get_current_candle()
                trade.exit_time = candle['time']
                trade.exit_price = candle['close']
                trade.status = 'closed'
                trade.result = 'MANUAL'
                pips, usd = self._calculate_pnl(trade, trade.exit_price)
                trade.pnl_pips = pips
                trade.pnl_usd = usd
                
                closed_trade = self.state.open_trades.pop(i)
                self.state.closed_trades.append(closed_trade)
                self._recalculate_balance()
                return closed_trade
        return None

    def _check_pending_orders(self, candle):
        """Verifica si el precio de la vela actual activa alguna orden pendiente."""
        if not self.state: return
        
        activated = []
        for trade in self.state.pending_trades:
            # Si el precio de entrada está entre Low y High de esta vela, se activa
            if candle['low'] <= trade.entry_price <= candle['high']:
                trade.status = 'open'
                trade.entry_time = candle['time'] # Actualizar al tiempo real de ejecución
                activated.append(trade)
        
        for trade in activated:
            self.state.pending_trades.remove(trade)
            self.state.open_trades.append(trade)

    def _check_sl_tp(self, candle):
        """Para cada trade abierto, verifica si la vela tocó SL o si TP."""
        if not self.state:
            return
            
        to_close = []
        for trade in self.state.open_trades:
            closed = False
            if trade.direction == 'BUY':
                if trade.stop_loss and candle['low'] <= trade.stop_loss:
                    trade.exit_price = trade.stop_loss
                    trade.result = 'SL'
                    closed = True
                elif trade.take_profit and candle['high'] >= trade.take_profit:
                    trade.exit_price = trade.take_profit
                    trade.result = 'TP'
                    closed = True
            else: # SELL
                if trade.stop_loss and candle['high'] >= trade.stop_loss:
                    trade.exit_price = trade.stop_loss
                    trade.result = 'SL'
                    closed = True
                elif trade.take_profit and candle['low'] <= trade.take_profit:
                    trade.exit_price = trade.take_profit
                    trade.result = 'TP'
                    closed = True
            
            if closed:
                trade.exit_time = candle['time']
                trade.status = 'closed'
                pips, usd = self._calculate_pnl(trade, trade.exit_price)
                trade.pnl_pips = pips
                trade.pnl_usd = usd
                to_close.append(trade)
                
        for trade in to_close:
            if trade in self.state.open_trades:
                self.state.open_trades.remove(trade)
                self.state.closed_trades.append(trade)
        
        if to_close:
            self._recalculate_balance()
            
        return to_close # Retornar para notificar

    def _cancel_trades_after(self, timestamp):
        """Mueve a future_trades los trades abiertos/cerrados después del timestamp."""
        if not self.state:
            return
            
        # De open_trades
        remaining_open = []
        for trade in self.state.open_trades:
            if trade.entry_time > timestamp:
                trade.status = 'future'
                self.state.future_trades.append(trade)
            else:
                remaining_open.append(trade)
        self.state.open_trades = remaining_open
        
        # De closed_trades
        remaining_closed = []
        for trade in self.state.closed_trades:
            if trade.entry_time > timestamp:
                trade.status = 'future'
                trade.exit_time = None
                trade.exit_price = None
                trade.pnl_pips = None
                trade.pnl_usd = None
                trade.result = None
                self.state.future_trades.append(trade)
            elif trade.exit_time and trade.exit_time > timestamp:
                # Si abrió antes pero cerró después, vuelve a estar abierto
                trade.status = 'open'
                trade.exit_time = None
                trade.exit_price = None
                trade.pnl_pips = None
                trade.pnl_usd = None
                trade.result = None
                self.state.open_trades.append(trade)
            else:
                remaining_closed.append(trade)
        self.state.closed_trades = remaining_closed

    def _restore_future_trades(self, candle):
        """Al avanzar, re-ejecuta future_trades cuyo entry_time <= candle.time"""
        if not self.state:
            return
            
        remaining_future = []
        for trade in self.state.future_trades:
            if trade.entry_time <= candle['time']:
                trade.status = 'open'
                self.state.open_trades.append(trade)
            else:
                remaining_future.append(trade)
        self.state.future_trades = remaining_future

    def _recalculate_balance(self):
        """Recalcula balance desde initial_balance + sum(pnl_usd de closed_trades activos)"""
        if not self.state:
            return
        total_pnl = sum(t.pnl_usd for t in self.state.closed_trades if t.pnl_usd is not None)
        self.state.balance = self.state.initial_balance + total_pnl

    def _calculate_pnl(self, trade, exit_price) -> tuple[float, float]:
        """Retorna (pnl_pips, pnl_usd)"""
        instr = self.state.instrument.replace('/', '_')
        # Identificar si es Forex (basado en prefijos comunes y separador)
        is_forex = any(pair in instr for pair in ['EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF']) and '_' in instr
        
        # Dicernir factor de pips (JPY usa 2 decimales, el resto 4 en Oanda)
        is_jpy = 'JPY' in instr
        pip_factor = 100.0 if (is_forex and is_jpy) else (10000.0 if is_forex else 1.0)
        
        # Multiplicador de unidades por lote (Forex estándar = 100,000 unidades)
        multiplier = 100000.0 if is_forex else 1.0
        
        if trade.direction == 'BUY':
            pips = (exit_price - trade.entry_price) * pip_factor
        else:
            pips = (trade.entry_price - exit_price) * pip_factor
            
        # PnL USD = Diferencia de precio * Lotes * Unidades por lote
        usd = (pips / pip_factor) * (trade.lot_size or 0.01) * multiplier
        
        return round(pips, 1), round(usd, 2)

    def get_statistics(self) -> Dict:
        """Calcula y retorna estadísticas."""
        if not self.state:
            return {}
            
        # 1. CALCULAR PNL ABIERTO SIEMPRE (Incluso si no hay trades cerrados)
        open_pnl = 0
        if self.state.open_trades:
            current_candle = self.get_current_candle()
            if current_candle:
                for t in self.state.open_trades:
                    _, usd = self._calculate_pnl(t, current_candle['close'])
                    open_pnl += usd

        closed = self.state.closed_trades
        total_trades = len(closed)
        
        # Si no hay cerrados, devolvemos stats básicas + PnL abierto real
        if total_trades == 0:
            return {
                "total_trades": 0,
                "win_rate": 0,
                "profit_factor": 0,
                "total_pnl_pips": 0,
                "total_pnl_usd": 0,
                "avg_win_usd": 0,
                "avg_loss_usd": 0,
                "max_drawdown_usd": 0,
                "best_trade_usd": 0,
                "worst_trade_usd": 0,
                "rr_ratio": 0,
                "open_pnl_usd": round(open_pnl, 2)
            }
            
        wins = [t for t in closed if (getattr(t, 'pnl_usd', 0) or 0) > 0]
        losses = [t for t in closed if (getattr(t, 'pnl_usd', 0) or 0) <= 0]
        
        gross_profit = sum((t.pnl_usd or 0) for t in wins)
        gross_loss = abs(sum((t.pnl_usd or 0) for t in losses))
        
        win_rate = (len(wins) / total_trades) if total_trades > 0 else 0
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else (min(gross_profit, 99.99) if gross_profit > 0 else 1.0)
        
        total_pips = sum(t.pnl_pips for t in closed if t.pnl_pips is not None)
        total_usd = sum(t.pnl_usd for t in closed if t.pnl_usd is not None)
        
        avg_win = sum(t.pnl_usd for t in wins) / len(wins) if wins else 0
        avg_loss = sum(t.pnl_usd for t in losses) / len(losses) if losses else 0
        
        peak = self.state.initial_balance
        max_dd = 0
        current_balance = self.state.initial_balance
        for t in closed:
            current_balance += (t.pnl_usd or 0)
            if current_balance > peak:
                peak = current_balance
            dd = peak - current_balance
            if dd > max_dd:
                max_dd = dd
                
        best_trade = max([t.pnl_usd for t in closed if t.pnl_usd is not None], default=0)
        worst_trade = min([t.pnl_usd for t in closed if t.pnl_usd is not None], default=0)
        
        rr_ratio = abs(avg_win / avg_loss) if avg_loss != 0 else 0
        
        return {
            "total_trades": total_trades,
            "win_rate": round(win_rate, 2),
            "profit_factor": round(profit_factor, 2),
            "total_pnl_pips": round(total_pips, 1),
            "total_pnl_usd": round(total_usd, 2),
            "avg_win_usd": round(avg_win, 2),
            "avg_loss_usd": round(avg_loss, 2),
            "max_drawdown_usd": round(max_dd, 2),
            "best_trade_usd": round(best_trade, 2),
            "worst_trade_usd": round(worst_trade, 2),
            "rr_ratio": round(rr_ratio, 2),
            "open_pnl_usd": round(open_pnl, 2)
        }

    def save_session(self) -> str:
        """Guarda el estado."""
        if not self.state:
            return ""
        
        filename = f"{self.state.instrument}_{self.state.granularity}_{self.state.from_date.replace('-','')}.json"
        
        folder = "backtests"
        if not os.path.exists(folder):
            os.makedirs(folder)
            
        path = os.path.join(folder, filename)
        
        data = {
            "instrument": self.state.instrument,
            "granularity": self.state.granularity,
            "all_candles": self.state.all_candles,
            "all_indicators": self.state.all_indicators,
            "current_index": self.state.current_index,
            "balance": self.state.balance,
            "initial_balance": self.state.initial_balance,
            "open_trades": [t.__dict__ for t in self.state.open_trades],
            "closed_trades": [t.__dict__ for t in self.state.closed_trades],
            "future_trades": [t.__dict__ for t in self.state.future_trades],
            "from_date": self.state.from_date,
            "created_at": self.state.created_at,
            "drawings": self.state.drawings
        }
        
        with open(path, 'w') as f:
            json.dump(data, f)
            
        return filename

    def delete_session(self, filename: str) -> bool:
        """Elimina un archivo de sesión json en backtests/."""
        # Sanitizar filename para evitar subir niveles de directorio
        filename = os.path.basename(filename)
        path = os.path.join("backtests", filename)
        try:
            if os.path.exists(path):
                os.remove(path)
                return True
        except:
            pass
        return False

    def load_session(self, data: Dict):
        """Restaura el estado."""

        self.state = ReplayState(
            instrument=data['instrument'],
            granularity=data['granularity'],
            all_candles=data['all_candles'],
            all_indicators=data['all_indicators'],
            current_index=data['current_index'],
            is_playing=False,
            speed=1.0,
            balance=data['balance'],
            initial_balance=data['initial_balance'],
            from_date=data.get('from_date', ""),
            created_at=data.get('created_at', datetime.now(timezone.utc).isoformat()),
            drawings=data.get('drawings', [])
        )
        
        self.state.open_trades = [Trade(**t) for t in data.get('open_trades', [])]
        self.state.closed_trades = [Trade(**t) for t in data.get('closed_trades', [])]
        self.state.future_trades = [Trade(**t) for t in data.get('future_trades', [])]

    def export_csv(self) -> str:
        """Genera el contenido CSV de los trades cerrados."""
        if not self.state:
            return ""
            
        import io
        output = io.StringIO()
        writer = csv.writer(output)
        
        writer.writerow(['#', 'Direction', 'EntryTime', 'EntryPrice', 'ExitTime', 'ExitPrice', 
                         'Lots', 'StopLoss', 'TakeProfit', 'PnL_pips', 'PnL_usd', 'Result', 'Notes'])
        
        for i, t in enumerate(self.state.closed_trades):
            writer.writerow([
                i + 1,
                t.direction,
                datetime.fromtimestamp(t.entry_time).strftime('%Y-%m-%d %H:%M'),
                t.entry_price,
                datetime.fromtimestamp(t.exit_time).strftime('%Y-%m-%d %H:%M') if t.exit_time else "",
                t.exit_price or "",
                t.lot_size,
                t.stop_loss or "",
                t.take_profit or "",
                t.pnl_pips or "",
                t.pnl_usd or "",
                t.result or "",
                t.notes
            ])
            
        return output.getvalue()

    def list_sessions(self) -> List[Dict]:
        """Lista todos los .json en backtests/ y retorna info de cada sesión ordenada por fecha de creación."""
        sessions = []
        path = Path("backtests")
        if not path.exists():
            return []
            
        for f in path.glob("*.json"):
            try:
                with open(f, 'r') as file:
                    data = json.load(file)
                    sessions.append({
                        "filename": f.name,
                        "instrument": data.get("instrument"),
                        "timeframe": data.get("granularity"),
                        "date": data.get("from_date") or data.get("date"), # Fallback flexible
                        "balance": data.get("balance"),
                        "trades": len(data.get("closed_trades", [])),
                        "created_at": data.get("created_at")
                    })
            except Exception as e:
                print(f"Error reading session file {f}: {e}")
        
        # Ordenar por fecha de creación descendente (más recientes primero)
        return sorted(sessions, key=lambda x: x.get('created_at') or "", reverse=True)

    async def start_play(self, speed, send_callback):
        """Inicia el replay automático."""
        if not self.state:
            return
            
        self.state.is_playing = True
        self.state.speed = speed
        
        print(f"[REPLAY] Starting play loop. Speed: {speed}, Index: {self.state.current_index}/{len(self.state.all_candles)}")
        
        while self.state.is_playing and self.state.current_index < len(self.state.all_candles) - 1:
            if speed <= 10:
                revealed, closed_trades = self.step_forward(1)
                delay = 1.0 / speed
            elif speed <= 100:
                revealed, closed_trades = self.step_forward(int(speed / 10))
                delay = 0.1
            else:
                revealed, closed_trades = self.step_forward(int(speed / 10))
                delay = 0.05
            
            if not revealed:
                break
                
            # El global_offset para el frontend se basa en el inicio de la "memoria" del gráfico
            current_window_size = 500
            global_offset = max(0, self.state.current_index - current_window_size)

            msg = {
                'type': 'replay_candle' if len(revealed) == 1 else 'replay_batch',
                'current_index': self.state.current_index,
                'global_offset': global_offset,
                'total': len(self.state.all_candles),
                'balance': self.state.balance,
                'instrument': self.state.instrument,
                'timeframe': self.state.granularity,
                'open_trades': [t.__dict__ for t in self.state.open_trades],
                'pending_trades': [t.__dict__ for t in self.state.pending_trades],
                'closed_trades': [t.__dict__ for t in self.state.closed_trades],
                'stats': self.get_statistics()
            }
            
            if len(revealed) == 1:
                msg['candle'] = revealed[0]
                msg['indicators'] = {
                    'rsi': self._get_current_step_indicator('rsi'),
                    'stoch_k': self._get_current_step_indicator('stoch_k'),
                    'stoch_d': self._get_current_step_indicator('stoch_d')
                }
            else:
                msg['candles'] = revealed
                
                # Optimización Crítica: Solo extraer indicadores para el lote actual (evita enviar 40k puntos)
                start_idx = self.state.current_index - len(revealed) + 1
                end_idx = self.state.current_index + 1
                
                def get_batch_ind(key):
                    if not self.state or "raw" not in self.state.all_indicators:
                        return []
                    raw_series = self.state.all_indicators["raw"].get(key, [])
                    result = []
                    for i in range(start_idx, end_idx):
                        if 0 <= i < len(raw_series) and raw_series[i] is not None:
                            result.append({
                                "time": self.state.all_candles[i]["time"],
                                "value": raw_series[i]
                            })
                    return result

                batch_indicators = {
                    'rsi': get_batch_ind('rsi'),
                    'stoch_k': get_batch_ind('stoch_k'),
                    'stoch_d': get_batch_ind('stoch_d')
                }
                
                msg['indicators'] = batch_indicators
                msg['all_indicators'] = batch_indicators

                
            await send_callback(msg)
            
            # NOTIFICAR TRADES CERRADOS (SL/TP)
            for t in closed_trades:
                type_hit = 'trade_sl_hit' if t.result == 'SL' else 'trade_tp_hit'
                await send_callback({
                    'type': type_hit,
                    'trade': t.__dict__,
                    'balance': self.state.balance,
                    'open_trades': [tr.__dict__ for tr in self.state.open_trades],
                    'pending_trades': [tr.__dict__ for tr in self.state.pending_trades],
                    'closed_trades': [tr.__dict__ for tr in self.state.closed_trades],
                    'stats': self.get_statistics()
                })

            await asyncio.sleep(delay)
            
        self.state.is_playing = False

    def stop_play(self):
        if self.state:
            self.state.is_playing = False
        if self._play_task:
            self._play_task.cancel()


