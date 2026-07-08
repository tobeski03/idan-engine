import { Candle } from '../models/Candle';

export interface ExchangeProvider {
  /**
   * Identifies whether this provider supports the given exchange.
   */
  supportsExchange(exchange: string): boolean;

  /**
   * Fetches the candles for the given symbol, timeframe, and limit.
   */
  fetchCandles(exchange: string, symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
}
