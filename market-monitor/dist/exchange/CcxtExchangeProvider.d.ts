import { ExchangeProvider } from './ExchangeProvider';
import { Candle } from '../models/Candle';
export declare class CcxtExchangeProvider implements ExchangeProvider {
    private instances;
    private supported;
    supportsExchange(exchange: string): boolean;
    private getExchangeInstance;
    fetchCandles(exchangeName: string, symbol: string, timeframe: string, limit?: number): Promise<Candle[]>;
    private retry;
}
