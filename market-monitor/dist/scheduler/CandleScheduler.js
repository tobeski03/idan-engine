"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CandleScheduler = void 0;
const Timeframe_1 = require("../utils/Timeframe");
const Logger_1 = require("../utils/Logger");
class CandleScheduler {
    activeTimeframes = new Map();
    callbacks = new Map();
    bufferMs = 5000; // 5-second buffer to let the exchange finalize the candle data
    /**
     * Register a callback to execute when a candle closes on a given timeframe.
     */
    register(timeframe, callback) {
        const tf = timeframe.toUpperCase().trim();
        if (!this.callbacks.has(tf)) {
            this.callbacks.set(tf, new Set());
        }
        this.callbacks.get(tf).add(callback);
        if (!this.activeTimeframes.has(tf)) {
            this.scheduleNext(tf);
        }
    }
    /**
     * Unregisters a callback for a given timeframe.
     */
    unregister(timeframe, callback) {
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
    stop(timeframe) {
        const active = this.activeTimeframes.get(timeframe);
        if (active) {
            clearTimeout(active.timer);
            this.activeTimeframes.delete(timeframe);
            Logger_1.Logger.info(`Stopped scheduler for timeframe ${timeframe}`);
        }
    }
    /**
     * Stops all active timers.
     */
    stopAll() {
        for (const tf of this.activeTimeframes.keys()) {
            this.stop(tf);
        }
    }
    /**
     * Calculates the remaining time and schedules the next candle close execution.
     */
    scheduleNext(timeframe) {
        const now = Date.now();
        const nextClose = (0, Timeframe_1.getNextCloseTime)(timeframe, now);
        const delay = (nextClose - now) + this.bufferMs;
        Logger_1.Logger.info(`Scheduled check for timeframe ${timeframe} in ${Math.round(delay / 1000)} seconds (Target close: ${new Date(nextClose).toISOString()})`);
        const timer = setTimeout(async () => {
            Logger_1.Logger.info(`Triggered checks for timeframe ${timeframe} candle close.`);
            const callbacks = this.callbacks.get(timeframe);
            if (callbacks) {
                for (const cb of callbacks) {
                    try {
                        await cb(timeframe, nextClose);
                    }
                    catch (error) {
                        Logger_1.Logger.error(`Error executing callback for timeframe ${timeframe}`, error);
                    }
                }
            }
            // Automatically queue up the next timeframe close
            this.scheduleNext(timeframe);
        }, delay);
        this.activeTimeframes.set(timeframe, { timer, nextClose });
    }
}
exports.CandleScheduler = CandleScheduler;
