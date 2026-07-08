import { FvgRepository } from '../repositories/FvgRepository';
import { Fvg } from '../models/Fvg';
export declare class JsonFvgRepository implements FvgRepository {
    private filePath;
    private writeQueue;
    constructor(customFilePath?: string);
    private ensureDirectoryExistence;
    private readData;
    private enqueueWrite;
    save(fvg: Fvg): Promise<void>;
    saveAll(fvgs: Fvg[]): Promise<void>;
    getById(id: string): Promise<Fvg | null>;
    getActive(exchange: string, symbol: string, timeframe: string): Promise<Fvg[]>;
    getAllActive(): Promise<Fvg[]>;
    update(fvg: Fvg): Promise<void>;
}
