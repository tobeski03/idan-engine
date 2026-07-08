"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeframeToMs = timeframeToMs;
exports.getNextCloseTime = getNextCloseTime;
/**
 * Parses a timeframe string (e.g., '15m', '30m', '1H', '4H', '1D') into milliseconds.
 */
function timeframeToMs(timeframe) {
    const normalized = timeframe.toLowerCase().trim();
    const match = normalized.match(/^(\d+)([mhwd])$/);
    if (!match) {
        throw new Error(`Invalid timeframe format: ${timeframe}`);
    }
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case 'm':
            return value * 60 * 1000;
        case 'h':
            return value * 60 * 60 * 1000;
        case 'd':
            return value * 24 * 60 * 60 * 1000;
        case 'w':
            return value * 7 * 24 * 60 * 60 * 1000;
        default:
            throw new Error(`Unsupported timeframe unit: ${unit}`);
    }
}
/**
 * Calculates the next candle close timestamp based on a timeframe and a given start time.
 */
function getNextCloseTime(timeframe, now) {
    const ms = timeframeToMs(timeframe);
    const lastClose = Math.floor(now / ms) * ms;
    return lastClose + ms;
}
