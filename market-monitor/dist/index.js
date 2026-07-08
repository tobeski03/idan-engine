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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapMarketMonitor = bootstrapMarketMonitor;
const CandleScheduler_1 = require("./scheduler/CandleScheduler");
const CandleService_1 = require("./services/CandleService");
const CcxtExchangeProvider_1 = require("./exchange/CcxtExchangeProvider");
const YahooFinanceProvider_1 = require("./exchange/YahooFinanceProvider");
const JsonFvgRepository_1 = require("./storage/JsonFvgRepository");
const MarketMonitor_1 = require("./services/MarketMonitor");
__exportStar(require("./models/Candle"), exports);
__exportStar(require("./models/Fvg"), exports);
__exportStar(require("./models/MarketConfig"), exports);
__exportStar(require("./exchange/ExchangeProvider"), exports);
__exportStar(require("./exchange/CcxtExchangeProvider"), exports);
__exportStar(require("./exchange/YahooFinanceProvider"), exports);
__exportStar(require("./scheduler/CandleScheduler"), exports);
__exportStar(require("./detectors/MarketDetector"), exports);
__exportStar(require("./detectors/FairValueGapDetector"), exports);
__exportStar(require("./services/CandleService"), exports);
__exportStar(require("./services/MarketMonitor"), exports);
__exportStar(require("./events/EventBus"), exports);
__exportStar(require("./repositories/FvgRepository"), exports);
__exportStar(require("./storage/JsonFvgRepository"), exports);
/**
 * Bootstraps the Market Monitor Skill by instantiating the scheduler,
 * candle service, repository, and orchestrator, registering default exchange providers.
 */
function bootstrapMarketMonitor(customFvgFilePath) {
    const scheduler = new CandleScheduler_1.CandleScheduler();
    const candleService = new CandleService_1.CandleService();
    // Register default exchange providers
    candleService.registerProvider(new CcxtExchangeProvider_1.CcxtExchangeProvider());
    candleService.registerProvider(new YahooFinanceProvider_1.YahooFinanceProvider());
    const repository = new JsonFvgRepository_1.JsonFvgRepository(customFvgFilePath);
    const monitor = new MarketMonitor_1.MarketMonitor(scheduler, candleService);
    return { scheduler, candleService, repository, monitor };
}
