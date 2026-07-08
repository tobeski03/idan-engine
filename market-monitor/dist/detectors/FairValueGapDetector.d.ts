import { MarketDetector } from './MarketDetector';
import { FvgRepository } from '../repositories/FvgRepository';
import { MitigationType } from '../models/Fvg';
import { Candle } from '../models/Candle';
export declare class FairValueGapDetector implements MarketDetector {
    private readonly repository;
    private readonly mitigationType;
    readonly id = "FairValueGapDetector";
    private recentCandles;
    constructor(repository: FvgRepository, mitigationType: MitigationType);
    /**
     * Performs the initial historical scan.
     * Detects all historical FVGs, checks if they were mitigated subsequently,
     * and saves the currently active ones.
     */
    initialize(exchange: string, symbol: string, timeframe: string, history: Candle[]): Promise<void>;
    /**
     * Processes new closed candles. Updates active FVGs to check for mitigation
     * and scans for newly formed FVGs.
     */
    processNewCandle(exchange: string, symbol: string, timeframe: string, newCandles: Candle[]): Promise<void>;
}
