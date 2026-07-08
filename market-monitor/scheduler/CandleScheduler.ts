import { getNextCloseTime } from '../utils/Timeframe';
import { Logger } from '../utils/Logger';

export type CandleCloseCallback = (timeframe: string, closeTimestamp: number) => Promise<void> | void;

export class CandleScheduler {
  private activeTimeframes: Map<string, { timer: NodeJS.Timeout; nextClose: number }> = new Map();
  private callbacks: Map<string, Set<CandleCloseCallback>> = new Map();
  private bufferMs = 5000; // 5-second buffer to let the exchange finalize the candle data

  /**
   * Register a callback to execute when a candle closes on a given timeframe.
   */
  public register(timeframe: string, callback: CandleCloseCallback): void {
    const tf = timeframe.toUpperCase().trim();
    if (!this.callbacks.has(tf)) {
      this.callbacks.set(tf, new Set());
    }
    this.callbacks.get(tf)!.add(callback);

    if (!this.activeTimeframes.has(tf)) {
      this.scheduleNext(tf);
    }
  }

  /**
   * Unregisters a callback for a given timeframe.
   */
  public unregister(timeframe: string, callback: CandleCloseCallback): void {
    const tf = timeframe.toUpperCase().trim();
    const set = this.callbacks.get(tf);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.callbacks.delete(tf);
        this.stop(tf);
      }
    }
  }

  /**
   * Stops the timer for a specific timeframe.
   */
  private stop(timeframe: string): void {
    const active = this.activeTimeframes.get(timeframe);
    if (active) {
      clearTimeout(active.timer);
      this.activeTimeframes.delete(timeframe);
      Logger.info(`Stopped scheduler for timeframe ${timeframe}`);
    }
  }

  /**
   * Stops all active timers.
   */
  public stopAll(): void {
    for (const tf of this.activeTimeframes.keys()) {
      this.stop(tf);
    }
  }

  /**
   * Calculates the remaining time and schedules the next candle close execution.
   */
  private scheduleNext(timeframe: string): void {
    const now = Date.now();
    const nextClose = getNextCloseTime(timeframe, now);
    const delay = (nextClose - now) + this.bufferMs;

    Logger.info(`Scheduled check for timeframe ${timeframe} in ${Math.round(delay / 1000)} seconds (Target close: ${new Date(nextClose).toISOString()})`);

    const timer = setTimeout(async () => {
      Logger.info(`Triggered checks for timeframe ${timeframe} candle close.`);
      
      const callbacks = this.callbacks.get(timeframe);
      if (callbacks) {
        for (const cb of callbacks) {
          try {
            await cb(timeframe, nextClose);
          } catch (error) {
            Logger.error(`Error executing callback for timeframe ${timeframe}`, error);
          }
        }
      }

      // Automatically queue up the next timeframe close
      this.scheduleNext(timeframe);
    }, delay);

    this.activeTimeframes.set(timeframe, { timer, nextClose });
  }
}
