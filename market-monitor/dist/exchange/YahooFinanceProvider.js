"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YahooFinanceProvider = void 0;
const Logger_1 = require("../utils/Logger");
const Timeframe_1 = require("../utils/Timeframe");
class YahooFinanceProvider {
    supportedExchanges = new Set(['yahoo', 'yahoofinance', 'forex']);
    supportsExchange(exchange) {
        return this.supportedExchanges.has(exchange.toLowerCase());
    }
    /**
     * Automatically normalizes popular forex and crypto symbols to Yahoo Finance format.
     * e.g., EURUSD -> EURUSD=X, BTCUSDT -> BTC-USD.
     */
    formatSymbol(symbol) {
        const clean = symbol.trim().toUpperCase();
        if (clean.endsWith('=X') || clean.includes('-') || clean.startsWith('^') || clean.endsWith('=F')) {
            return clean;
        }
        const cryptoBases = new Set(['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOT', 'DOGE', 'LTC', 'LINK']);
        // Check if symbol starts with a known crypto base and ends with USDT or USD
        for (const base of cryptoBases) {
            if (clean.startsWith(base) && (clean.endsWith('USDT') || clean.endsWith('USD'))) {
                return `${base}-USD`;
            }
        }
        // Forex: matches 6-letter currency pairs like EURUSD or EUR/USD
        const forexMatch = clean.replace('/', '').match(/^([A-Z]{3})([A-Z]{3})$/);
        if (forexMatch) {
            const base = forexMatch[1];
            const quote = forexMatch[2];
            if (cryptoBases.has(base)) {
                return `${base}-USD`;
            }
            return `${base}${quote}=X`;
        }
        return clean;
    }
    async fetchCandles(exchange, symbol, timeframe, limit = 500) {
        const yahooSymbol = this.formatSymbol(symbol);
        const targetTimeframeMs = (0, Timeframe_1.timeframeToMs)(timeframe);
        // Map timeframe to Yahoo intervals
        let queryInterval = '1h';
        let needsAggregation = false;
        const tfUpper = timeframe.toUpperCase().trim();
        if (tfUpper === '15M') {
            queryInterval = '15m';
        }
        else if (tfUpper === '30M') {
            queryInterval = '30m';
        }
        else if (tfUpper === '1H') {
            queryInterval = '1h';
        }
        else if (tfUpper === '4H') {
            queryInterval = '1h'; // 4h is not natively supported by Yahoo Finance, aggregate from 1h
            needsAggregation = true;
        }
        else if (tfUpper === '1D') {
            queryInterval = '1d';
        }
        else {
            queryInterval = '1h';
            needsAggregation = true;
        }
        // If aggregation is needed, we need to fetch more low-timeframe candles to cover the limit
        const candlesToFetch = needsAggregation ? limit * 4 : limit;
        // Calculate period1 and period2 based on time gap needed
        const now = Date.now();
        const durationMs = targetTimeframeMs * candlesToFetch * 1.5; // Adding 50% buffer for weekend market halts
        const period1 = Math.floor((now - durationMs) / 1000);
        const period2 = Math.floor(now / 1000);
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=${queryInterval}`;
        return this.retry(async () => {
            Logger_1.Logger.debug(`Fetching candles from Yahoo Finance: ${url}`);
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
                    'Accept': 'application/json',
                },
            });
            if (!response.ok) {
                throw new Error(`Yahoo Finance API returned status code ${response.status}`);
            }
            const json = (await response.json().catch(() => ({})));
            const chartResult = json?.chart?.result?.[0];
            if (!chartResult) {
                const errorMsg = json?.chart?.error?.description || 'No data returned';
                throw new Error(`Yahoo Finance Error: ${errorMsg}`);
            }
            const timestamps = chartResult.timestamp || [];
            const quote = chartResult.indicators?.quote?.[0] || {};
            const opens = quote.open || [];
            const highs = quote.high || [];
            const lows = quote.low || [];
            const closes = quote.close || [];
            const volumes = quote.volume || [];
            const rawCandles = [];
            for (let i = 0; i < timestamps.length; i++) {
                // Yahoo Finance chart API sometimes returns null values inside quote arrays for missing periods
                if (opens[i] === null || opens[i] === undefined ||
                    highs[i] === null || highs[i] === undefined ||
                    lows[i] === null || lows[i] === undefined ||
                    closes[i] === null || closes[i] === undefined) {
                    continue;
                }
                rawCandles.push({
                    timestamp: timestamps[i] * 1000,
                    open: opens[i],
                    high: highs[i],
                    low: lows[i],
                    close: closes[i],
                    volume: volumes[i] || 0,
                });
            }
            let candles = rawCandles;
            if (needsAggregation) {
                candles = this.aggregateCandles(rawCandles, targetTimeframeMs);
            }
            // Return the most recent ones up to the requested limit
            return candles.slice(-limit);
        });
    }
    /**
     * Aggregates lower-timeframe candles into higher-timeframe candles.
     */
    aggregateCandles(candles, targetTimeframeMs) {
        if (candles.length === 0)
            return [];
        const aggregated = [];
        let currentCandle = null;
        let currentBoundary = 0;
        for (const candle of candles) {
            const boundary = Math.floor(candle.timestamp / targetTimeframeMs) * targetTimeframeMs;
            if (!currentCandle || boundary !== currentBoundary) {
                if (currentCandle) {
                    aggregated.push(currentCandle);
                }
                currentCandle = { ...candle, timestamp: boundary };
                currentBoundary = boundary;
            }
            else {
                currentCandle.high = Math.max(currentCandle.high, candle.high);
                currentCandle.low = Math.min(currentCandle.low, candle.low);
                currentCandle.close = candle.close;
                currentCandle.volume += candle.volume;
            }
        }
        if (currentCandle) {
            aggregated.push(currentCandle);
        }
        return aggregated;
    }
    async retry(fn, retries = 3, delay = 1000) {
        try {
            return await fn();
        }
        catch (error) {
            if (retries <= 0) {
                Logger_1.Logger.error(`Yahoo Finance request failed after max retries`, error);
                throw error;
            }
            Logger_1.Logger.warn(`Yahoo Finance request failed: ${error.message || error}. Retrying in ${delay}ms... (Retries left: ${retries})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.retry(fn, retries - 1, delay * 2);
        }
    }
}
exports.YahooFinanceProvider = YahooFinanceProvider;
