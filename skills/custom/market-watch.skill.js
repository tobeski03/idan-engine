const fs = require('fs');
const path = require('path');

let MarketMonitorSDK = null;
try {
  MarketMonitorSDK = require('../../market-monitor/dist/index');
} catch (err) {
  console.error('[Market Monitor] Error importing compiled TypeScript SDK. Make sure market-monitor is built.', err);
}

const { 
  bootstrapMarketMonitor, 
  FairValueGapDetector, 
  MitigationType, 
  EventBus 
} = MarketMonitorSDK || {};

const WATCHES_FILE = path.join(__dirname, '..', '..', 'market-watches.json');

function readWatches() {
  try {
    if (fs.existsSync(WATCHES_FILE)) {
      return JSON.parse(fs.readFileSync(WATCHES_FILE, 'utf8'));
    }
  } catch (e) {
    // ignore
  }
  return [];
}

function writeWatches(watches) {
  fs.writeFileSync(WATCHES_FILE, JSON.stringify(watches, null, 2), 'utf8');
}

let monitorInstance = null;

function sendAlert(message) {
  console.log(`[Market Monitor Alert] ${message}`);
  const { exec } = require('child_process');
  
  // Clean message for shell command
  const cleanMsg = message.replace(/\*/g, '').replace(/`/g, '');
  const title = "Market Monitor Alert";
  
  // Try termux-notification first
  exec(`termux-notification -t "${title}" -c "${cleanMsg}" --sound`, (err) => {
    if (err) {
      // Fallback: try via adb if running on development machine/emulator
      exec(`adb shell termux-notification -t "${title}" -c "${cleanMsg}" --sound`, () => {});
    }
  });

  // Try to send WhatsApp notification if whatsapp client is connected
  try {
    const whatsappPath = path.join(__dirname, '..', '..', 'whatsapp.js');
    if (fs.existsSync(whatsappPath)) {
      const { getWhatsAppStatus, sendWhatsAppMessageDirect } = require(whatsappPath);
      const wsStatus = getWhatsAppStatus();
      if (wsStatus && wsStatus.status === 'connected' && wsStatus.phoneNumber) {
        sendWhatsAppMessageDirect(wsStatus.phoneNumber, message).catch(() => {});
      }
    }
  } catch (e) {
    // ignore
  }
}

async function startMonitoring(watches) {
  if (!monitorInstance) return;

  // Stop current monitoring if running
  try {
    monitorInstance.monitor.stop();
  } catch (e) {
    // ignore
  }

  if (watches.length === 0) {
    monitorInstance.activeWatches = [];
    return;
  }

  const configs = [];
  const detectorsMap = new Map();

  for (const watch of watches) {
    const key = `${watch.exchange}:${watch.symbol}:${watch.timeframe}`.toLowerCase();
    
    // Parse mitigation type
    let mitigation = MitigationType.Touch;
    if (watch.mitigationType === 'Partial') mitigation = MitigationType.Partial;
    if (watch.mitigationType === 'Full') mitigation = MitigationType.Full;

    configs.push({
      symbol: watch.symbol,
      exchange: watch.exchange,
      timeframe: watch.timeframe,
      mitigationType: mitigation
    });

    const detector = new FairValueGapDetector(monitorInstance.repository, mitigation);
    
    if (!detectorsMap.has(key)) {
      detectorsMap.set(key, []);
    }
    detectorsMap.get(key).push(detector);
  }

  // Start background monitoring
  await monitorInstance.monitor.start(configs, detectorsMap);
  monitorInstance.activeWatches = watches;
}

function initMonitor() {
  if (!MarketMonitorSDK) return;

  if (global.marketMonitorInstance) {
    monitorInstance = global.marketMonitorInstance;
    return;
  }

  const fvgFilePath = path.join(__dirname, '..', '..', 'fvgs.json');
  const sdk = bootstrapMarketMonitor(fvgFilePath);
  
  monitorInstance = {
    scheduler: sdk.scheduler,
    candleService: sdk.candleService,
    repository: sdk.repository,
    monitor: sdk.monitor,
    activeWatches: []
  };

  global.marketMonitorInstance = monitorInstance;

  // Listen to EventBus events to alert the user
  EventBus.getInstance().on('market.fvg.created', (data) => {
    const { fvg } = data;
    const alertMsg = `🚨 *Bullish/Bearish FVG Created* 📈\n` +
      `Exchange: ${fvg.exchange.toUpperCase()}\n` +
      `Symbol: ${fvg.symbol}\n` +
      `Timeframe: ${fvg.timeframe}\n` +
      `Type: ${fvg.type}\n` +
      `Range: ${fvg.bottom} - ${fvg.top}`;
    
    sendAlert(alertMsg);
  });

  EventBus.getInstance().on('market.fvg.mitigated', (data) => {
    const { fvg, candle } = data;
    const alertMsg = `✅ *FVG Mitigated* 📉\n` +
      `Exchange: ${fvg.exchange.toUpperCase()}\n` +
      `Symbol: ${fvg.symbol}\n` +
      `Timeframe: ${fvg.timeframe}\n` +
      `Type: ${fvg.type}\n` +
      `Price entered: ${candle.close} (low: ${candle.low}, high: ${candle.high})`;
    
    sendAlert(alertMsg);
  });

  EventBus.getInstance().on('market.error', (data) => {
    console.error('[Market Monitor Error]', data);
  });

  EventBus.getInstance().on('market.sync.completed', (data) => {
    const { exchange, symbol, timeframe, candleCount } = data;
    const msg = `⚡ *Market Watch Active* 📊\n` +
      `Successfully synced ${candleCount} candles for ${symbol} on ${exchange.toUpperCase()} (${timeframe}). Live monitoring is now active!`;
    sendAlert(msg);
  });

  // Load and start saved watches on boot
  const savedWatches = readWatches();
  if (savedWatches.length > 0) {
    startMonitoring(savedWatches).catch(err => {
      console.error('Failed to start monitoring saved watches on boot:', err);
    });
  }
}

// Initialize on module load
try {
  initMonitor();
} catch (e) {
  console.error('Failed to run initMonitor during skill load:', e);
}

module.exports = {
  id: 'market_watch',
  name: 'Market Watch',
  enabled: true,

  toolDeclarations: [
    {
      name: 'market_watch_start',
      description: "Start monitoring a market symbol for Fair Value Gaps (FVGs) and price events. Supported exchanges: 'binance', 'bybit', 'kraken', 'yahoo' (for stocks/ETFs). Timeframes: '1m', '5m', '15m', '1h', '4h', '1d'. Example: monitor BTC/USDT on Binance at 1-hour candles. The monitor will run in the background and can alert on FVG creation or mitigation.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: "Trading pair or ticker symbol, e.g. 'BTC/USDT', 'ETH/USDT', 'AAPL'."
          },
          exchange: {
            type: 'STRING',
            description: "Exchange or data source: 'binance', 'bybit', 'kraken', 'yahoo'."
          },
          timeframe: {
            type: 'STRING',
            description: "Candle timeframe: '1m', '5m', '15m', '1h', '4h', '1d'."
          },
          mitigationType: {
            type: 'STRING',
            description: "FVG mitigation type: 'Touch' (price touches the gap edge), 'Partial' (price enters the midpoint), 'Full' (price fills the entire gap). Defaults to 'Touch'."
          }
        },
        required: ['symbol', 'exchange', 'timeframe']
      }
    },
    {
      name: 'market_watch_stop',
      description: "Stop an active market watch by its symbol, exchange, and timeframe. Removes it from the background monitor.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: "Trading pair or ticker symbol to stop monitoring."
          },
          exchange: {
            type: 'STRING',
            description: "Exchange name."
          },
          timeframe: {
            type: 'STRING',
            description: "Timeframe of the watch."
          }
        },
        required: ['symbol', 'exchange', 'timeframe']
      }
    },
    {
      name: 'market_watch_list',
      description: "List all currently active market watches (symbols, exchanges, timeframes, and status).",
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'market_watch_get_fvgs',
      description: "Retrieve all active (unmitigated) Fair Value Gaps (FVGs) detected for a given symbol and exchange. Returns FVG type (Bullish/Bearish), price range (top/bottom), and creation time.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: "Trading pair or ticker symbol."
          },
          exchange: {
            type: 'STRING',
            description: "Exchange name."
          },
          timeframe: {
            type: 'STRING',
            description: "Optional timeframe filter."
          }
        },
        required: ['symbol', 'exchange']
      }
    },
    {
      name: 'market_watch_fetch_price',
      description: "Fetch the latest price and recent candle data for a symbol without starting a persistent watch. Useful for quick one-off price lookups.",
      parameters: {
        type: 'OBJECT',
        properties: {
          symbol: {
            type: 'STRING',
            description: "Trading pair or ticker symbol, e.g. 'BTC/USDT', 'AAPL'."
          },
          exchange: {
            type: 'STRING',
            description: "Exchange or data source: 'binance', 'bybit', 'kraken', 'yahoo'."
          },
          timeframe: {
            type: 'STRING',
            description: "Candle timeframe for the lookup. Defaults to '1d'."
          },
          limit: {
            type: 'NUMBER',
            description: "Number of recent candles to return (1-20). Defaults to 5."
          }
        },
        required: ['symbol', 'exchange']
      }
    }
  ],

  async handleTool(name, args, ctx) {
    if (!MarketMonitorSDK) {
      return {
        ok: false,
        error: 'Market Monitor SDK could not be loaded. Please ensure typescript project under market-monitor is built.'
      };
    }

    // Ensure monitor instance is initialized
    initMonitor();

    switch (name) {
      case 'market_watch_start': {
        const { symbol, exchange, timeframe, mitigationType = 'Touch' } = args;
        const normalizedExchange = exchange.toLowerCase();
        const normalizedTimeframe = timeframe.toLowerCase();
        
        let watches = readWatches();
        
        // Check for duplicates
        const exists = watches.some(w => 
          w.symbol.toLowerCase() === symbol.toLowerCase() &&
          w.exchange.toLowerCase() === normalizedExchange &&
          w.timeframe.toLowerCase() === normalizedTimeframe
        );

        if (exists) {
          return {
            ok: true,
            message: `Market watch for ${symbol} on ${exchange} (${timeframe}) is already running.`
          };
        }

        const newWatch = {
          symbol,
          exchange: normalizedExchange,
          timeframe: normalizedTimeframe,
          mitigationType
        };

        watches.push(newWatch);
        writeWatches(watches);

        ctx.appendLog(`[Market Watch Skill] Starting watch for ${symbol} on ${exchange} (${timeframe}) in the background`);
        startMonitoring(watches).catch(err => {
          ctx.appendLog(`[Market Watch Skill Error] Failed to start background monitoring: ${err.message}`);
        });

        return {
          ok: true,
          message: `Successfully queued watch for ${symbol} on ${exchange} (${timeframe}). The initial synchronization of historical candles is starting in the background.`
        };
      }

      case 'market_watch_stop': {
        const { symbol, exchange, timeframe } = args;
        const normalizedExchange = exchange.toLowerCase();
        const normalizedTimeframe = timeframe.toLowerCase();

        let watches = readWatches();
        const filtered = watches.filter(w => !(
          w.symbol.toLowerCase() === symbol.toLowerCase() &&
          w.exchange.toLowerCase() === normalizedExchange &&
          w.timeframe.toLowerCase() === normalizedTimeframe
        ));

        if (watches.length === filtered.length) {
          return {
            ok: false,
            message: `No active watch found for ${symbol} on ${exchange} (${timeframe}).`
          };
        }

        writeWatches(filtered);
        ctx.appendLog(`[Market Watch Skill] Stopping watch for ${symbol} on ${exchange} (${timeframe})`);
        
        startMonitoring(filtered).catch(err => {
          ctx.appendLog(`[Market Watch Skill Error] Failed to update background monitoring: ${err.message}`);
        });

        return {
          ok: true,
          message: `Stopped monitoring ${symbol} on ${exchange} (${timeframe}).`
        };
      }

      case 'market_watch_list': {
        const active = monitorInstance ? monitorInstance.activeWatches : [];
        return {
          ok: true,
          watches: active
        };
      }

      case 'market_watch_get_fvgs': {
        const { symbol, exchange, timeframe } = args;
        
        if (!monitorInstance) {
          return { ok: false, error: 'Monitor instance not running.' };
        }

        const activeFvgs = await monitorInstance.repository.getAllActive();
        const filtered = activeFvgs.filter(f => 
          f.symbol.toLowerCase() === symbol.toLowerCase() &&
          f.exchange.toLowerCase() === exchange.toLowerCase() &&
          (!timeframe || f.timeframe.toLowerCase() === timeframe.toLowerCase())
        );

        return {
          ok: true,
          symbol,
          exchange,
          timeframe,
          fvgs: filtered
        };
      }

      case 'market_watch_fetch_price': {
        const { symbol, exchange, timeframe = '1d', limit = 5 } = args;
        
        if (!monitorInstance) {
          return { ok: false, error: 'Monitor instance not running.' };
        }

        try {
          ctx.appendLog(`[Market Watch Skill] Fetching price for ${symbol} on ${exchange} (${timeframe})`);
          const candles = await monitorInstance.candleService.fetchHistory(
            exchange.toLowerCase(),
            symbol,
            timeframe.toLowerCase(),
            Math.min(20, Math.max(1, limit))
          );

          if (!candles || candles.length === 0) {
            return {
              ok: false,
              error: `No candle data returned for ${symbol} on ${exchange}.`
            };
          }

          const latestCandle = candles[candles.length - 1];
          return {
            ok: true,
            symbol,
            exchange,
            timeframe,
            latestPrice: latestCandle.close,
            latestCandle,
            history: candles
          };
        } catch (e) {
          ctx.appendLog(`[Market Watch Skill] Fetch price error: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }
};
