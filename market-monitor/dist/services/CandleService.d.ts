import { ExchangeProvider } from '../exchange/ExchangeProvider';
import { Candle } from '../models/Candle';
export declare class CandleService {
    private providers;
    private history;
    /**
     * Register a new ExchangeProvider.
     */
    registerProvider(provider: ExchangeProvider): void;
    /**
     * Retrieves the registered provider for a given exchange.
     */
    private getProvider;
    /**
     * Fetches initial historical candles and caches them.
     */
    fetchHistory(exchange: string, symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
    /**
     * Fetches recent candles, filters out duplicates, and appends new candles to history.
     * Returns only the newly closed candles.
     */
    fetchUpdates(exchange: string, symbol: string, timeframe: string): Promise<Candle[]>;
    /**
     * Retrieves the local cache of candles for a given market.
     */
    getHistory(exchange: string, symbol: string, timeframe: string): Candle[];
}
