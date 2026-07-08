"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const YahooFinanceProvider_1 = require("../exchange/YahooFinanceProvider");
describe('YahooFinanceProvider', () => {
    let provider;
    let originalFetch;
    beforeEach(() => {
        provider = new YahooFinanceProvider_1.YahooFinanceProvider();
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });
    test('supportsExchange matching', () => {
        expect(provider.supportsExchange('yahoo')).toBe(true);
        expect(provider.supportsExchange('YahooFinance')).toBe(true);
        expect(provider.supportsExchange('forex')).toBe(true);
        expect(provider.supportsExchange('binance')).toBe(false);
    });
    test('Symbol formatting normalization rules', async () => {
        // Accessing private method for test verification
        const formatSymbol = provider.formatSymbol.bind(provider);
        expect(formatSymbol('EURUSD')).toBe('EURUSD=X');
        expect(formatSymbol('EUR/USD')).toBe('EURUSD=X');
        expect(formatSymbol('GBPUSD=X')).toBe('GBPUSD=X');
        expect(formatSymbol('BTCUSDT')).toBe('BTC-USD');
        expect(formatSymbol('BTC-USD')).toBe('BTC-USD');
        expect(formatSymbol('GC=F')).toBe('GC=F');
    });
    test('fetchCandles parses chart JSON response correctly', async () => {
        const mockJson = {
            chart: {
                result: [
                    {
                        timestamp: [1600000000, 1600003600],
                        indicators: {
                            quote: [
                                {
                                    open: [1.1800, 1.1850],
                                    high: [1.1900, 1.1950],
                                    low: [1.1750, 1.1800],
                                    close: [1.1850, 1.1900],
                                    volume: [1000, 2000],
                                },
                            ],
                        },
                    },
                ],
                error: null,
            },
        };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => mockJson,
        });
        const candles = await provider.fetchCandles('yahoo', 'EURUSD', '1H', 2);
        expect(candles.length).toBe(2);
        expect(candles[0]).toEqual({
            timestamp: 1600000000000,
            open: 1.1800,
            high: 1.1900,
            low: 1.1750,
            close: 1.1850,
            volume: 1000,
        });
        expect(candles[1].close).toBe(1.1900);
    });
    test('Timeframe aggregation (1H to 4H)', async () => {
        // 4 candles, each 1H (3600s) apart
        const mockJson = {
            chart: {
                result: [
                    {
                        timestamp: [1600000000, 1600003600, 1600007200, 1600010800],
                        indicators: {
                            quote: [
                                {
                                    open: [10, 11, 12, 13],
                                    high: [15, 16, 17, 18],
                                    low: [8, 9, 7, 10],
                                    close: [12, 13, 14, 15],
                                    volume: [100, 100, 100, 100],
                                },
                            ],
                        },
                    },
                ],
                error: null,
            },
        };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => mockJson,
        });
        const candles = await provider.fetchCandles('yahoo', 'EURUSD', '4H', 1);
        // Aggregation target timeframe is 4 hours (14,400,000 ms)
        // All 4 candles fall within the same 4-hour window
        expect(candles.length).toBe(1);
        expect(candles[0].open).toBe(10);
        expect(candles[0].high).toBe(18); // max(15, 16, 17, 18)
        expect(candles[0].low).toBe(7); // min(8, 9, 7, 10)
        expect(candles[0].close).toBe(15); // final close
        expect(candles[0].volume).toBe(400); // sum(100, 100, 100, 100)
    });
    test('HTTP Retries on temporary failures', async () => {
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return { ok: false, status: 502 };
            }
            return {
                ok: true,
                json: async () => ({
                    chart: {
                        result: [
                            {
                                timestamp: [1600000000],
                                indicators: {
                                    quote: [{ open: [10], high: [15], low: [8], close: [12], volume: [100] }],
                                },
                            },
                        ],
                    },
                }),
            };
        });
        const candles = await provider.fetchCandles('yahoo', 'EURUSD', '1H', 1);
        expect(callCount).toBe(2);
        expect(candles.length).toBe(1);
        expect(candles[0].close).toBe(12);
    });
});
