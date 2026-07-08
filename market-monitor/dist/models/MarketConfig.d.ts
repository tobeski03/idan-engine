import { MitigationType } from './Fvg';
export interface MarketConfig {
    symbol: string;
    exchange: string;
    timeframe: string;
    mitigationType: MitigationType;
}
