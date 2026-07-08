import { Candle } from './Candle';

export enum FvgType {
  Bullish = 'Bullish',
  Bearish = 'Bearish'
}

export enum MitigationType {
  Touch = 'Touch',
  Partial = 'Partial',
  Full = 'Full'
}

export interface Fvg {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  type: FvgType;
  top: number;
  bottom: number;
  createdAt: number; // Timestamp of the candle sequence completion
  state: 'active' | 'mitigated';
  mitigationType: MitigationType;
}

/**
 * Checks if a candle has mitigated a given Fair Value Gap (FVG) based on the mitigation type.
 */
export function checkMitigation(fvg: Fvg, candle: Candle): boolean {
  if (fvg.type === FvgType.Bullish) {
    switch (fvg.mitigationType) {
      case MitigationType.Touch:
        return candle.low <= fvg.top;
      case MitigationType.Partial:
        return candle.low <= (fvg.top + fvg.bottom) / 2;
      case MitigationType.Full:
        return candle.low <= fvg.bottom;
    }
  } else {
    switch (fvg.mitigationType) {
      case MitigationType.Touch:
        return candle.high >= fvg.bottom;
      case MitigationType.Partial:
        return candle.high >= (fvg.top + fvg.bottom) / 2;
      case MitigationType.Full:
        return candle.high >= fvg.top;
    }
  }
}
