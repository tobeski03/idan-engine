import { ExchangeProvider } from './ExchangeProvider';
import { Candle } from '../models/Candle';
export declare class YahooFinanceProvider implements ExchangeProvider {
    private supportedExchanges;
    supportsExchange(exchange: string): boolean;
    /**
     * Automatically normalizes popular forex and crypto symbols to Yahoo Finance format.
     * e.g., EURUSD -> EURUSD=X, BTCUSDT -> BTC-USD.
     */
    private formatSymbol;
    fetchCandles(exchange: string, symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
    /**
     * Aggregates lower-timeframe candles into higher-timeframe candles.
     */
    private aggregateCandles;
    private retry;
}
