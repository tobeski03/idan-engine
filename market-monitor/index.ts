import { CandleScheduler } from './scheduler/CandleScheduler';
import { CandleService } from './services/CandleService';
import { CcxtExchangeProvider } from './exchange/CcxtExchangeProvider';
import { YahooFinanceProvider } from './exchange/YahooFinanceProvider';
import { JsonFvgRepository } from './storage/JsonFvgRepository';
import { MarketMonitor } from './services/MarketMonitor';

export * from './models/Candle';
export * from './models/Fvg';
export * from './models/MarketConfig';
export * from './exchange/ExchangeProvider';
export * from './exchange/CcxtExchangeProvider';
export * from './exchange/YahooFinanceProvider';
export * from './scheduler/CandleScheduler';
export * from './detectors/MarketDetector';
export * from './detectors/FairValueGapDetector';
export * from './services/CandleService';
export * from './services/MarketMonitor';
export * from './events/EventBus';
export * from './repositories/FvgRepository';
export * from './storage/JsonFvgRepository';

/**
 * Bootstraps the Market Monitor Skill by instantiating the scheduler,
 * candle service, repository, and orchestrator, registering default exchange providers.
 */
export function bootstrapMarketMonitor(customFvgFilePath?: string): {
  scheduler: CandleScheduler;
  candleService: CandleService;
  repository: JsonFvgRepository;
  monitor: MarketMonitor;
} {
  const scheduler = new CandleScheduler();
  const candleService = new CandleService();
  
  // Register default exchange providers
  candleService.registerProvider(new CcxtExchangeProvider());
  candleService.registerProvider(new YahooFinanceProvider());
  
  const repository = new JsonFvgRepository(customFvgFilePath);
  const monitor = new MarketMonitor(scheduler, candleService);

  return { scheduler, candleService, repository, monitor };
}
