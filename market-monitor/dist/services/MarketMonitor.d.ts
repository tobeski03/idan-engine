import { CandleScheduler } from '../scheduler/CandleScheduler';
import { CandleService } from './CandleService';
import { MarketDetector } from '../detectors/MarketDetector';
import { MarketConfig } from '../models/MarketConfig';
export declare class MarketMonitor {
    private readonly scheduler;
    private readonly candleService;
    private marketDetectors;
    private configs;
    constructor(scheduler: CandleScheduler, candleService: CandleService);
    /**
     * Registers a detector for a specific market configuration.
     */
    registerDetectorForMarket(marketKey: string, detector: MarketDetector): void;
    /**
     * Starts monitoring for the given configurations and associates their detectors.
     */
    start(configs: MarketConfig[], detectorsMap: Map<string, MarketDetector[]>): Promise<void>;
    /**
     * Stops all scheduler timers.
     */
    stop(): void;
    /**
     * Core callback triggered when a candle closes on a given timeframe.
     * Downloads updates and executes active detectors for the matching markets.
     */
    private handleCandleClose;
}
