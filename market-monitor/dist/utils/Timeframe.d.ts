/**
 * Parses a timeframe string (e.g., '15m', '30m', '1H', '4H', '1D') into milliseconds.
 */
export declare function timeframeToMs(timeframe: string): number;
/**
 * Calculates the next candle close timestamp based on a timeframe and a given start time.
 */
export declare function getNextCloseTime(timeframe: string, now: number): number;
