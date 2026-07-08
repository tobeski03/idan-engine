import { ExchangeProvider } from '../exchange/ExchangeProvider';
import { Candle } from '../models/Candle';
import { Logger } from '../utils/Logger';

export class CandleService {
  private providers: ExchangeProvider[] = [];
  private history: Map<string, Candle[]> = new Map();

  /**
   * Register a new ExchangeProvider.
   */
  public registerProvider(provider: ExchangeProvider): void {
    this.providers.push(provider);
  }

  /**
   * Retrieves the registered provider for a given exchange.
   */
  private getProvider(exchange: string): ExchangeProvider {
    const provider = this.providers.find((p) => p.supportsExchange(exchange));
    if (!provider) {
      throw new Error(`No ExchangeProvider registered for exchange: ${exchange}`);
    }
    return provider;
  }

  /**
   * Fetches initial historical candles and caches them.
   */
  public async fetchHistory(
    exchange: string,
    symbol: string,
    timeframe: string,
    limit = 500
  ): Promise<Candle[]> {
    const key = `${exchange}:${symbol}:${timeframe}`.toLowerCase();
    const existing = this.history.get(key);
    if (existing && existing.length > 0) {
      Logger.info(`Using cached history for ${key} (${existing.length} candles).`);
      return existing;
    }

    const provider = this.getProvider(exchange);
    const candles = await provider.fetchCandles(exchange, symbol, timeframe, limit);
    
    this.history.set(key, candles);
    
    return candles;
  }

  /**
   * Fetches recent candles, filters out duplicates, and appends new candles to history.
   * Returns only the newly closed candles.
   */
  public async fetchUpdates(
    exchange: string,
    symbol: string,
    timeframe: string
  ): Promise<Candle[]> {
    const key = `${exchange}:${symbol}:${timeframe}`.toLowerCase();
    const existing = this.history.get(key) || [];
    
    const provider = this.getProvider(exchange);
    
    // Fetch the last 5 candles to ensure we capture the closed candle and handle any slight delay
    const fetched = await provider.fetchCandles(exchange, symbol, timeframe, 5);
    
    if (existing.length === 0) {
      this.history.set(key, fetched);
      return fetched;
    }

    const lastExistingTimestamp = existing[existing.length - 1].timestamp;
    
    // Filter candles that are newer than our last cached candle
    const newCandles = fetched.filter((c) => c.timestamp > lastExistingTimestamp);

    if (newCandles.length > 0) {
      const updatedHistory = [...existing, ...newCandles];
      // Keep memory footprint bounded to prevent leaks (limit to 1000 candles)
      if (updatedHistory.length > 1000) {
        this.history.set(key, updatedHistory.slice(-1000));
      } else {
        this.history.set(key, updatedHistory);
      }
    }

    return newCandles;
  }

  /**
   * Retrieves the local cache of candles for a given market.
   */
  public getHistory(exchange: string, symbol: string, timeframe: string): Candle[] {
    const key = `${exchange}:${symbol}:${timeframe}`.toLowerCase();
    return this.history.get(key) || [];
  }
}
