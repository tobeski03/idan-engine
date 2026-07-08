"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketMonitor = void 0;
const EventBus_1 = require("../events/EventBus");
const Logger_1 = require("../utils/Logger");
class MarketMonitor {
    scheduler;
    candleService;
    marketDetectors = new Map();
    configs = [];
    constructor(scheduler, candleService) {
        this.scheduler = scheduler;
        this.candleService = candleService;
    }
    /**
     * Registers a detector for a specific market configuration.
     */
    registerDetectorForMarket(marketKey, detector) {
        const key = marketKey.toLowerCase();
        if (!this.marketDetectors.has(key)) {
            this.marketDetectors.set(key, new Set());
        }
        this.marketDetectors.get(key).add(detector);
    }
    /**
     * Starts monitoring for the given configurations and associates their detectors.
     */
    async start(configs, detectorsMap) {
        this.configs = configs;
        for (const config of configs) {
            const key = `${config.exchange}:${config.symbol}:${config.timeframe}`.toLowerCase();
            // Map detectors to the market key
            const detectors = detectorsMap.get(key) || [];
            for (const detector of detectors) {
                this.registerDetectorForMarket(key, detector);
            }
            Logger_1.Logger.info(`Initializing monitoring for ${key}...`);
            try {
                // 1. Initial candle scan (downloads 500 historical candles by default)
                const history = await this.candleService.fetchHistory(config.exchange, config.symbol, config.timeframe);
                // 2. Initialize detectors for this market with the candle history
                const registered = this.marketDetectors.get(key) || new Set();
                for (const detector of registered) {
                    await detector.initialize(config.exchange, config.symbol, config.timeframe, history);
                }
                EventBus_1.EventBus.getInstance().emit('market.sync.completed', {
                    exchange: config.exchange,
                    symbol: config.symbol,
                    timeframe: config.timeframe,
                    candleCount: history.length,
                });
            }
            catch (error) {
                Logger_1.Logger.error(`Initialization failed for market ${key}`, error);
                EventBus_1.EventBus.getInstance().emit('market.error', {
                    exchange: config.exchange,
                    symbol: config.symbol,
                    timeframe: config.timeframe,
                    error: error.message || String(error),
                });
            }
            // 3. Register scheduler callback for the timeframe
            this.scheduler.register(config.timeframe, async (tf) => {
                await this.handleCandleClose(tf);
            });
        }
    }
    /**
     * Stops all scheduler timers.
     */
    stop() {
        this.scheduler.stopAll();
        Logger_1.Logger.info('Market Monitor stopped.');
    }
    /**
     * Core callback triggered when a candle closes on a given timeframe.
     * Downloads updates and executes active detectors for the matching markets.
     */
    async handleCandleClose(timeframe) {
        // Find all markets matching this timeframe
        const matchingConfigs = this.configs.filter((c) => c.timeframe.toUpperCase() === timeframe.toUpperCase());
        for (const config of matchingConfigs) {
            const key = `${config.exchange}:${config.symbol}:${config.timeframe}`.toLowerCase();
            const detectors = this.marketDetectors.get(key);
            if (!detectors || detectors.size === 0) {
                continue;
            }
            try {
                // Fetch only newly closed candle(s)
                const newCandles = await this.candleService.fetchUpdates(config.exchange, config.symbol, config.timeframe);
                if (newCandles.length > 0) {
                    Logger_1.Logger.info(`Processing ${newCandles.length} new candle(s) for ${key}.`);
                    // Run all detectors associated with this market
                    for (const detector of detectors) {
                        await detector.processNewCandle(config.exchange, config.symbol, config.timeframe, newCandles);
                    }
                    EventBus_1.EventBus.getInstance().emit('market.sync.completed', {
                        exchange: config.exchange,
                        symbol: config.symbol,
                        timeframe: config.timeframe,
                        candleCount: newCandles.length,
                    });
                }
            }
            catch (error) {
                Logger_1.Logger.error(`Error processing updates for market ${key}`, error);
                EventBus_1.EventBus.getInstance().emit('market.error', {
                    exchange: config.exchange,
                    symbol: config.symbol,
                    timeframe: config.timeframe,
                    error: error.message || String(error),
                });
            }
        }
    }
}
exports.MarketMonitor = MarketMonitor;
