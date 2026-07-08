import { Candle } from '../models/Candle';
export interface MarketDetector {
    readonly id: string;
    /**
     * Initializes the detector with historical candle data for a given market.
     */
    initialize(exchange: string, symbol: string, timeframe: string, history: Candle[]): Promise<void>;
    /**
     * Processes new closed candles to scan for new patterns and check existing active patterns.
     */
    processNewCandle(exchange: string, symbol: string, timeframe: string, newCandles: Candle[]): Promise<void>;
}
