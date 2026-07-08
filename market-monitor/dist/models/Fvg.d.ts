import { Candle } from './Candle';
export declare enum FvgType {
    Bullish = "Bullish",
    Bearish = "Bearish"
}
export declare enum MitigationType {
    Touch = "Touch",
    Partial = "Partial",
    Full = "Full"
}
export interface Fvg {
    id: string;
    symbol: string;
    exchange: string;
    timeframe: string;
    type: FvgType;
    top: number;
    bottom: number;
    createdAt: number;
    state: 'active' | 'mitigated';
    mitigationType: MitigationType;
}
/**
 * Checks if a candle has mitigated a given Fair Value Gap (FVG) based on the mitigation type.
 */
export declare function checkMitigation(fvg: Fvg, candle: Candle): boolean;
