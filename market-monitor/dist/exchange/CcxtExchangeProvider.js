"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CcxtExchangeProvider = void 0;
const ccxt = __importStar(require("ccxt"));
const Logger_1 = require("../utils/Logger");
class CcxtExchangeProvider {
    instances = new Map();
    supported = new Set(['binance', 'bybit', 'okx']);
    supportsExchange(exchange) {
        return this.supported.has(exchange.toLowerCase());
    }
    getExchangeInstance(exchangeName) {
        const key = exchangeName.toLowerCase();
        if (!this.instances.has(key)) {
            if (key === 'binance') {
                this.instances.set(key, new ccxt.binance({ enableRateLimit: true }));
            }
            else if (key === 'bybit') {
                this.instances.set(key, new ccxt.bybit({ enableRateLimit: true }));
            }
            else if (key === 'okx') {
                this.instances.set(key, new ccxt.okx({ enableRateLimit: true }));
            }
            else {
                throw new Error(`Unsupported exchange in CCXT provider: ${exchangeName}`);
            }
        }
        return this.instances.get(key);
    }
    async fetchCandles(exchangeName, symbol, timeframe, limit) {
        const exchange = this.getExchangeInstance(exchangeName);
        return this.retry(async () => {
            Logger_1.Logger.debug(`Fetching ${limit || 'default'} candles for ${symbol} on ${exchangeName} (${timeframe})`);
            const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
            if (!ohlcv || !Array.isArray(ohlcv)) {
                throw new Error(`Invalid response received from ${exchangeName} for ${symbol}`);
            }
            return ohlcv.map((candle) => {
                if (!candle || candle.length < 6) {
                    throw new Error(`Incomplete candle data: ${JSON.stringify(candle)}`);
                }
                return {
                    timestamp: candle[0],
                    open: candle[1],
                    high: candle[2],
                    low: candle[3],
                    close: candle[4],
                    volume: candle[5],
                };
            });
        });
    }
    async retry(fn, retries = 3, delay = 1000) {
        try {
            return await fn();
        }
        catch (error) {
            if (retries <= 0) {
                Logger_1.Logger.error(`CCXT request failed after max retries`, error);
                throw error;
            }
            // Log retry and backoff
            Logger_1.Logger.warn(`CCXT request failed: ${error.message || error}. Retrying in ${delay}ms... (Retries left: ${retries})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.retry(fn, retries - 1, delay * 2);
        }
    }
}
exports.CcxtExchangeProvider = CcxtExchangeProvider;
