"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FairValueGapDetector = void 0;
const Fvg_1 = require("../models/Fvg");
const EventBus_1 = require("../events/EventBus");
const Logger_1 = require("../utils/Logger");
class FairValueGapDetector {
    repository;
    mitigationType;
    id = 'FairValueGapDetector';
    recentCandles = new Map();
    constructor(repository, mitigationType) {
        this.repository = repository;
        this.mitigationType = mitigationType;
    }
    /**
     * Performs the initial historical scan.
     * Detects all historical FVGs, checks if they were mitigated subsequently,
     * and saves the currently active ones.
     */
    async initialize(exchange, symbol, timeframe, history) {
        const key = `${exchange}:${symbol}:${timeframe}`;
        Logger_1.Logger.info(`Initializing FVG Detector for ${key} with ${history.length} historical candles.`);
        if (history.length < 3) {
            Logger_1.Logger.warn(`Insufficient candle history (${history.length}) for initialization.`);
            this.recentCandles.set(key, [...history]);
            return;
        }
        const detectedFvgs = [];
        // Loop through historical candles to detect all gaps
        for (let i = 2; i < history.length; i++) {
            const c0 = history[i - 2]; // oldest
            const c1 = history[i - 1]; // middle
            const c2 = history[i]; // newest
            let fvg = null;
            // Bullish FVG
            if (c2.low > c0.high) {
                fvg = {
                    id: `fvg_${exchange}_${symbol}_${timeframe}_${c2.timestamp}_bullish`.toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
                    symbol,
                    exchange,
                    timeframe,
                    type: Fvg_1.FvgType.Bullish,
                    top: c2.low,
                    bottom: c0.high,
                    createdAt: c2.timestamp,
                    state: 'active',
                    mitigationType: this.mitigationType,
                };
            }
            // Bearish FVG
            else if (c2.high < c0.low) {
                fvg = {
                    id: `fvg_${exchange}_${symbol}_${timeframe}_${c2.timestamp}_bearish`.toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
                    symbol,
                    exchange,
                    timeframe,
                    type: Fvg_1.FvgType.Bearish,
                    top: c0.low,
                    bottom: c2.high,
                    createdAt: c2.timestamp,
                    state: 'active',
                    mitigationType: this.mitigationType,
                };
            }
            if (fvg) {
                // Check if mitigated by any subsequent candle in the historical data
                let mitigated = false;
                for (let j = i + 1; j < history.length; j++) {
                    if ((0, Fvg_1.checkMitigation)(fvg, history[j])) {
                        mitigated = true;
                        break;
                    }
                }
                if (!mitigated) {
                    detectedFvgs.push(fvg);
                }
            }
        }
        // Save only active ones
        if (detectedFvgs.length > 0) {
            await this.repository.saveAll(detectedFvgs);
            Logger_1.Logger.info(`Found and saved ${detectedFvgs.length} active FVGs for ${key}.`);
        }
        else {
            Logger_1.Logger.info(`No active FVGs found during initialization for ${key}.`);
        }
        // Store the last 3 candles in recent history cache
        this.recentCandles.set(key, history.slice(-3));
    }
    /**
     * Processes new closed candles. Updates active FVGs to check for mitigation
     * and scans for newly formed FVGs.
     */
    async processNewCandle(exchange, symbol, timeframe, newCandles) {
        const key = `${exchange}:${symbol}:${timeframe}`;
        let cached = this.recentCandles.get(key) || [];
        // Get current active FVGs for this market
        let activeFvgs = await this.repository.getActive(exchange, symbol, timeframe);
        for (const candle of newCandles) {
            // 1. Check mitigation of existing active FVGs
            const stillActive = [];
            for (const fvg of activeFvgs) {
                if ((0, Fvg_1.checkMitigation)(fvg, candle)) {
                    fvg.state = 'mitigated';
                    await this.repository.update(fvg);
                    EventBus_1.EventBus.getInstance().emit('market.fvg.mitigated', { fvg, candle });
                    Logger_1.Logger.info(`FVG mitigated: ${fvg.id} at candle timestamp ${candle.timestamp}`);
                }
                else {
                    stillActive.push(fvg);
                }
            }
            activeFvgs = stillActive;
            // 2. Check for newly formed FVG
            cached.push(candle);
            if (cached.length > 3) {
                cached.shift();
            }
            if (cached.length === 3) {
                const c0 = cached[0]; // oldest
                const c1 = cached[1]; // middle
                const c2 = cached[2]; // newest
                let newFvg = null;
                // Bullish FVG
                if (c2.low > c0.high) {
                    newFvg = {
                        id: `fvg_${exchange}_${symbol}_${timeframe}_${c2.timestamp}_bullish`.toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
                        symbol,
                        exchange,
                        timeframe,
                        type: Fvg_1.FvgType.Bullish,
                        top: c2.low,
                        bottom: c0.high,
                        createdAt: c2.timestamp,
                        state: 'active',
                        mitigationType: this.mitigationType,
                    };
                }
                // Bearish FVG
                else if (c2.high < c0.low) {
                    newFvg = {
                        id: `fvg_${exchange}_${symbol}_${timeframe}_${c2.timestamp}_bearish`.toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
                        symbol,
                        exchange,
                        timeframe,
                        type: Fvg_1.FvgType.Bearish,
                        top: c0.low,
                        bottom: c2.high,
                        createdAt: c2.timestamp,
                        state: 'active',
                        mitigationType: this.mitigationType,
                    };
                }
                if (newFvg) {
                    const existing = await this.repository.getById(newFvg.id);
                    if (!existing) {
                        await this.repository.save(newFvg);
                        activeFvgs.push(newFvg); // Add to active list so it can be mitigated by next candle in this batch
                        EventBus_1.EventBus.getInstance().emit('market.fvg.created', { fvg: newFvg });
                        Logger_1.Logger.info(`New FVG detected and saved: ${newFvg.id}`);
                    }
                }
            }
        }
        this.recentCandles.set(key, cached);
    }
}
exports.FairValueGapDetector = FairValueGapDetector;
