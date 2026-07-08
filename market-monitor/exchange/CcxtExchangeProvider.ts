import * as ccxt from 'ccxt';
import { ExchangeProvider } from './ExchangeProvider';
import { Candle } from '../models/Candle';
import { Logger } from '../utils/Logger';

export class CcxtExchangeProvider implements ExchangeProvider {
  private instances: Map<string, ccxt.Exchange> = new Map();
  private supported = new Set(['binance', 'bybit', 'okx']);

  public supportsExchange(exchange: string): boolean {
    return this.supported.has(exchange.toLowerCase());
  }

  private getExchangeInstance(exchangeName: string): ccxt.Exchange {
    const key = exchangeName.toLowerCase();
    if (!this.instances.has(key)) {
      if (key === 'binance') {
        this.instances.set(key, new ccxt.binance({ enableRateLimit: true }));
      } else if (key === 'bybit') {
        this.instances.set(key, new ccxt.bybit({ enableRateLimit: true }));
      } else if (key === 'okx') {
        this.instances.set(key, new ccxt.okx({ enableRateLimit: true }));
      } else {
        throw new Error(`Unsupported exchange in CCXT provider: ${exchangeName}`);
      }
    }
    return this.instances.get(key)!;
  }

  public async fetchCandles(
    exchangeName: string,
    symbol: string,
    timeframe: string,
    limit?: number
  ): Promise<Candle[]> {
    const exchange = this.getExchangeInstance(exchangeName);

    return this.retry(async () => {
      Logger.debug(`Fetching ${limit || 'default'} candles for ${symbol} on ${exchangeName} (${timeframe})`);
      
      const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      
      if (!ohlcv || !Array.isArray(ohlcv)) {
        throw new Error(`Invalid response received from ${exchangeName} for ${symbol}`);
      }

      return ohlcv.map((candle) => {
        if (!candle || candle.length < 6) {
          throw new Error(`Incomplete candle data: ${JSON.stringify(candle)}`);
        }
        return {
          timestamp: candle[0] as number,
          open: candle[1] as number,
          high: candle[2] as number,
          low: candle[3] as number,
          close: candle[4] as number,
          volume: candle[5] as number,
        };
      });
    });
  }

  private async retry<T>(
    fn: () => Promise<T>,
    retries = 3,
    delay = 1000
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (retries <= 0) {
        Logger.error(`CCXT request failed after max retries`, error);
        throw error;
      }
      
      // Log retry and backoff
      Logger.warn(`CCXT request failed: ${error.message || error}. Retrying in ${delay}ms... (Retries left: ${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.retry(fn, retries - 1, delay * 2);
    }
  }
}
