import { Fvg } from '../models/Fvg';
import { Candle } from '../models/Candle';
export type MarketEvents = {
    'market.fvg.created': (payload: {
        fvg: Fvg;
    }) => void;
    'market.fvg.mitigated': (payload: {
        fvg: Fvg;
        candle: Candle;
    }) => void;
    'market.error': (payload: {
        exchange: string;
        symbol: string;
        timeframe: string;
        error: string;
    }) => void;
    'market.sync.completed': (payload: {
        exchange: string;
        symbol: string;
        timeframe: string;
        candleCount: number;
    }) => void;
};
export declare class EventBus {
    private static instance;
    private emitter;
    private constructor();
    static getInstance(): EventBus;
    emit<K extends keyof MarketEvents>(event: K, payload: Parameters<MarketEvents[K]>[0]): void;
    on<K extends keyof MarketEvents>(event: K, listener: MarketEvents[K]): void;
    off<K extends keyof MarketEvents>(event: K, listener: MarketEvents[K]): void;
    removeAllListeners(event?: keyof MarketEvents): void;
}
