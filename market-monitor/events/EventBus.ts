import { EventEmitter } from 'events';
import { Fvg } from '../models/Fvg';
import { Candle } from '../models/Candle';

export type MarketEvents = {
  'market.fvg.created': (payload: { fvg: Fvg }) => void;
  'market.fvg.mitigated': (payload: { fvg: Fvg; candle: Candle }) => void;
  'market.error': (payload: { exchange: string; symbol: string; timeframe: string; error: string }) => void;
  'market.sync.completed': (payload: { exchange: string; symbol: string; timeframe: string; candleCount: number }) => void;
};

export class EventBus {
  private static instance: EventBus;
  private emitter: EventEmitter;

  private constructor() {
    this.emitter = new EventEmitter();
    // Increase limit for multiple detectors subscribing
    this.emitter.setMaxListeners(100);
  }

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public emit<K extends keyof MarketEvents>(event: K, payload: Parameters<MarketEvents[K]>[0]): void {
    this.emitter.emit(event, payload);
  }

  public on<K extends keyof MarketEvents>(event: K, listener: MarketEvents[K]): void {
    this.emitter.on(event, listener);
  }

  public off<K extends keyof MarketEvents>(event: K, listener: MarketEvents[K]): void {
    this.emitter.off(event, listener);
  }

  public removeAllListeners(event?: keyof MarketEvents): void {
    this.emitter.removeAllListeners(event);
  }
}
