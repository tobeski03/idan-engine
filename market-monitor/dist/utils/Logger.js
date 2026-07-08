"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
class Logger {
    static formatMessage(level, message) {
        return `[${new Date().toISOString()}] [MarketMonitor] [${level}] ${message}`;
    }
    static info(message) {
        console.log(this.formatMessage('INFO', message));
    }
    static warn(message) {
        console.warn(this.formatMessage('WARN', message));
    }
    static error(message, error) {
        const errorMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
        console.error(this.formatMessage('ERROR', message + (error ? ` | Details: ${errorMsg}` : '')));
    }
    static debug(message) {
        console.debug(this.formatMessage('DEBUG', message));
    }
}
exports.Logger = Logger;
