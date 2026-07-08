"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MitigationType = exports.FvgType = void 0;
exports.checkMitigation = checkMitigation;
var FvgType;
(function (FvgType) {
    FvgType["Bullish"] = "Bullish";
    FvgType["Bearish"] = "Bearish";
})(FvgType || (exports.FvgType = FvgType = {}));
var MitigationType;
(function (MitigationType) {
    MitigationType["Touch"] = "Touch";
    MitigationType["Partial"] = "Partial";
    MitigationType["Full"] = "Full";
})(MitigationType || (exports.MitigationType = MitigationType = {}));
/**
 * Checks if a candle has mitigated a given Fair Value Gap (FVG) based on the mitigation type.
 */
function checkMitigation(fvg, candle) {
    if (fvg.type === FvgType.Bullish) {
        switch (fvg.mitigationType) {
            case MitigationType.Touch:
                return candle.low <= fvg.top;
            case MitigationType.Partial:
                return candle.low <= (fvg.top + fvg.bottom) / 2;
            case MitigationType.Full:
                return candle.low <= fvg.bottom;
        }
    }
    else {
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
