import * as fs from 'fs';
import * as path from 'path';
import { FvgRepository } from '../repositories/FvgRepository';
import { Fvg } from '../models/Fvg';
import { Logger } from '../utils/Logger';

export class JsonFvgRepository implements FvgRepository {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || path.join(__dirname, '..', 'data', 'fvgs.json');
    this.ensureDirectoryExistence();
  }

  private ensureDirectoryExistence(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([]), 'utf8');
    }
  }

  private async readData(): Promise<Fvg[]> {
    try {
      const data = await fs.promises.readFile(this.filePath, 'utf8');
      return JSON.parse(data) as Fvg[];
    } catch (error: any) {
      Logger.error(`Failed to read FVG data file`, error);
      return [];
    }
  }

  private enqueueWrite(data: Fvg[]): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const tempPath = `${this.filePath}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rename(tempPath, this.filePath);
      } catch (error: any) {
        Logger.error(`Failed to write FVG data atomically`, error);
      }
    });
    return this.writeQueue;
  }

  public async save(fvg: Fvg): Promise<void> {
    const data = await this.readData();
    // Prevent duplicates
    if (data.some((item) => item.id === fvg.id)) {
      Logger.warn(`FVG with ID ${fvg.id} already exists in database. Skipping.`);
      return;
    }
    data.push(fvg);
    await this.enqueueWrite(data);
  }

  public async saveAll(fvgs: Fvg[]): Promise<void> {
    const data = await this.readData();
    let updated = false;
    for (const fvg of fvgs) {
      if (!data.some((item) => item.id === fvg.id)) {
        data.push(fvg);
        updated = true;
      } else {
        Logger.warn(`FVG with ID ${fvg.id} already exists in database. Skipping.`);
      }
    }
    if (updated) {
      await this.enqueueWrite(data);
    }
  }

  public async getById(id: string): Promise<Fvg | null> {
    const data = await this.readData();
    return data.find((item) => item.id === id) || null;
  }

  public async getActive(exchange: string, symbol: string, timeframe: string): Promise<Fvg[]> {
    const data = await this.readData();
    return data.filter(
      (item) =>
        item.state === 'active' &&
        item.exchange.toLowerCase() === exchange.toLowerCase() &&
        item.symbol.toLowerCase() === symbol.toLowerCase() &&
        item.timeframe.toLowerCase() === timeframe.toLowerCase()
    );
  }

  public async getAllActive(): Promise<Fvg[]> {
    const data = await this.readData();
    return data.filter((item) => item.state === 'active');
  }

  public async update(fvg: Fvg): Promise<void> {
    const data = await this.readData();
    const index = data.findIndex((item) => item.id === fvg.id);
    if (index >= 0) {
      data[index] = fvg;
      await this.enqueueWrite(data);
    } else {
      Logger.error(`Failed to update FVG: ID ${fvg.id} not found in database.`);
    }
  }
}
