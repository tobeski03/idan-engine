export type CandleCloseCallback = (timeframe: string, closeTimestamp: number) => Promise<void> | void;
export declare class CandleScheduler {
    private activeTimeframes;
    private callbacks;
    private bufferMs;
    /**
     * Register a callback to execute when a candle closes on a given timeframe.
     */
    register(timeframe: string, callback: CandleCloseCallback): void;
    /**
     * Unregisters a callback for a given timeframe.
     */
    unregister(timeframe: string, callback: CandleCloseCallback): void;
    /**
     * Stops the timer for a specific timeframe.
     */
    private stop;
    /**
     * Stops all active timers.
     */
    stopAll(): void;
    /**
     * Calculates the remaining time and schedules the next candle close execution.
     */
    private scheduleNext;
}
