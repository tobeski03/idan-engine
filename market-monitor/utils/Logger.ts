export class Logger {
  private static formatMessage(level: string, message: string): string {
    return `[${new Date().toISOString()}] [MarketMonitor] [${level}] ${message}`;
  }

  public static info(message: string): void {
    console.log(this.formatMessage('INFO', message));
  }

  public static warn(message: string): void {
    console.warn(this.formatMessage('WARN', message));
  }

  public static error(message: string, error?: any): void {
    const errorMsg = error instanceof Error ? error.stack || error.message : JSON.stringify(error);
    console.error(this.formatMessage('ERROR', message + (error ? ` | Details: ${errorMsg}` : '')));
  }

  public static debug(message: string): void {
    console.debug(this.formatMessage('DEBUG', message));
  }
}
