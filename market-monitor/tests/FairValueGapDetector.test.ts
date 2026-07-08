import { FairValueGapDetector } from '../detectors/FairValueGapDetector';
import { FvgRepository } from '../repositories/FvgRepository';
import { Fvg, FvgType, MitigationType } from '../models/Fvg';
import { Candle } from '../models/Candle';
import { EventBus } from '../events/EventBus';

describe('FairValueGapDetector', () => {
  let mockRepository: jest.Mocked<FvgRepository>;
  let db: Fvg[];

  beforeEach(() => {
    db = [];
    mockRepository = {
      save: jest.fn().mockImplementation(async (fvg: Fvg) => {
        db.push(JSON.parse(JSON.stringify(fvg)));
      }),
      saveAll: jest.fn().mockImplementation(async (fvgs: Fvg[]) => {
        db.push(...JSON.parse(JSON.stringify(fvgs)));
      }),
      getById: jest.fn().mockImplementation(async (id: string) => {
        return db.find((item) => item.id === id) || null;
      }),
      getActive: jest.fn().mockImplementation(async () => {
        return db.filter((item) => item.state === 'active');
      }),
      getAllActive: jest.fn().mockImplementation(async () => {
        return db.filter((item) => item.state === 'active');
      }),
      update: jest.fn().mockImplementation(async (fvg: Fvg) => {
        const idx = db.findIndex((item) => item.id === fvg.id);
        if (idx >= 0) {
          db[idx] = JSON.parse(JSON.stringify(fvg));
        }
      }),
    };
    EventBus.getInstance().removeAllListeners();
  });

  test('Bullish FVG detection', async () => {
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Touch);
    const history: Candle[] = [
      { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: 2000, open: 11, high: 14, low: 11, close: 13, volume: 100 },
      { timestamp: 3000, open: 13, high: 17, low: 15, close: 16, volume: 100 }, // low (15) > high[2] (12)
    ];

    await detector.initialize('binance', 'BTC/USDT', '1h', history);

    expect(db.length).toBe(1);
    expect(db[0].type).toBe(FvgType.Bullish);
    expect(db[0].top).toBe(15);
    expect(db[0].bottom).toBe(12);
    expect(db[0].state).toBe('active');
  });

  test('Bearish FVG detection', async () => {
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Touch);
    const history: Candle[] = [
      { timestamp: 1000, open: 20, high: 21, low: 18, close: 19, volume: 100 },
      { timestamp: 2000, open: 19, high: 19, low: 16, close: 17, volume: 100 },
      { timestamp: 3000, open: 17, high: 14, low: 12, close: 13, volume: 100 }, // high (14) < low[2] (18)
    ];

    await detector.initialize('binance', 'BTC/USDT', '1h', history);

    expect(db.length).toBe(1);
    expect(db[0].type).toBe(FvgType.Bearish);
    expect(db[0].top).toBe(18);
    expect(db[0].bottom).toBe(14);
    expect(db[0].state).toBe('active');
  });

  test('Touch Mitigation logic (Bullish and Bearish)', async () => {
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Touch);
    
    // Bullish FVG initialized (top = 15, bottom = 12)
    const historyBullish: Candle[] = [
      { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: 2000, open: 11, high: 14, low: 11, close: 13, volume: 100 },
      { timestamp: 3000, open: 13, high: 17, low: 15, close: 16, volume: 100 },
    ];
    await detector.initialize('binance', 'BTC/USDT', '1h', historyBullish);
    expect(db[0].state).toBe('active');

    let mitigationEmitted = false;
    EventBus.getInstance().on('market.fvg.mitigated', () => {
      mitigationEmitted = true;
    });

    // Process a new candle that does not touch/mitigate (low = 15.1)
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 4000, open: 16, high: 18, low: 15.1, close: 17, volume: 100 },
    ]);
    expect(db[0].state).toBe('active');
    expect(mitigationEmitted).toBe(false);

    // Process a new candle that touches/mitigates (low = 15.0)
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 5000, open: 16, high: 18, low: 15.0, close: 15.5, volume: 100 },
    ]);
    expect(db[0].state).toBe('mitigated');
    expect(mitigationEmitted).toBe(true);
  });

  test('Partial Mitigation logic', async () => {
    // Partial mitigation triggers when price reaches halfway (top + bottom) / 2
    // For Bullish: top = 16, bottom = 12. Midpoint = 14.
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Partial);
    const history: Candle[] = [
      { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: 2000, open: 11, high: 14, low: 11, close: 13, volume: 100 },
      { timestamp: 3000, open: 13, high: 18, low: 16, close: 17, volume: 100 },
    ];
    await detector.initialize('binance', 'BTC/USDT', '1h', history);
    expect(db[0].state).toBe('active');

    // Candle low = 14.5 (enters gap, but not past midpoint 14)
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 4000, open: 16, high: 17, low: 14.5, close: 15, volume: 100 },
    ]);
    expect(db[0].state).toBe('active');

    // Candle low = 14.0 (reaches midpoint)
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 5000, open: 15, high: 16, low: 14.0, close: 14.2, volume: 100 },
    ]);
    expect(db[0].state).toBe('mitigated');
  });

  test('Full Mitigation logic', async () => {
    // Full mitigation triggers when price trades completely through the gap
    // For Bullish: top = 16, bottom = 12. Must reach/go below 12.
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Full);
    const history: Candle[] = [
      { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: 2000, open: 11, high: 14, low: 11, close: 13, volume: 100 },
      { timestamp: 3000, open: 13, high: 18, low: 16, close: 17, volume: 100 },
    ];
    await detector.initialize('binance', 'BTC/USDT', '1h', history);
    expect(db[0].state).toBe('active');

    // Candle low = 12.1 (does not trade completely through)
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 4000, open: 16, high: 17, low: 12.1, close: 13, volume: 100 },
    ]);
    expect(db[0].state).toBe('active');

    // Candle low = 12.0 (trades completely through bottom boundary)
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 5000, open: 13, high: 14, low: 12.0, close: 12.5, volume: 100 },
    ]);
    expect(db[0].state).toBe('mitigated');
  });

  test('Duplicate prevention', async () => {
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Touch);
    const history: Candle[] = [
      { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: 2000, open: 11, high: 14, low: 11, close: 13, volume: 100 },
      { timestamp: 3000, open: 13, high: 17, low: 15, close: 16, volume: 100 },
    ];

    await detector.initialize('binance', 'BTC/USDT', '1h', history);
    expect(db.length).toBe(1);

    // Reprocess the same candle or a duplicate candle sequence
    await detector.processNewCandle('binance', 'BTC/USDT', '1h', [
      { timestamp: 3000, open: 13, high: 17, low: 15, close: 16, volume: 100 },
    ]);

    // DB size should still be 1 (duplicate FVG not saved)
    expect(db.length).toBe(1);
  });

  test('Initialization scan filters mitigated FVGs', async () => {
    const detector = new FairValueGapDetector(mockRepository, MitigationType.Touch);
    
    // Sequence forms FVG on candle index 2 (1000 - 3000 ms)
    // Then subsequent candle index 3 (4000 ms) goes below/mitigates it (low = 11.5 <= FVG top 15)
    // Sequence forms another FVG on candle index 5 (4000 - 6000 ms) which remains unmitigated
    const history: Candle[] = [
      { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: 2000, open: 11, high: 14, low: 11, close: 13, volume: 100 },
      { timestamp: 3000, open: 13, high: 17, low: 15, close: 16, volume: 100 }, // FVG 1 (top=15, bottom=12)
      { timestamp: 4000, open: 15, high: 14, low: 11.5, close: 12, volume: 100 }, // Mitigates FVG 1
      { timestamp: 5000, open: 12, high: 13, low: 11, close: 12, volume: 100 },
      { timestamp: 6000, open: 12, high: 18, low: 16, close: 17, volume: 100 }, // FVG 2 (top=16, bottom=14)
    ];

    await detector.initialize('binance', 'BTC/USDT', '1h', history);

    // Only FVG 2 should be in db since FVG 1 was mitigated within the historical data
    expect(db.length).toBe(1);
    expect(db[0].createdAt).toBe(6000);
    expect(db[0].state).toBe('active');
  });
});
