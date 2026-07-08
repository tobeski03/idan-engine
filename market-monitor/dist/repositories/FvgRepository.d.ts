import { Fvg } from '../models/Fvg';
export interface FvgRepository {
    /**
     * Saves a single FVG to the repository.
     */
    save(fvg: Fvg): Promise<void>;
    /**
     * Saves multiple FVGs to the repository.
     */
    saveAll(fvgs: Fvg[]): Promise<void>;
    /**
     * Retrieves a single FVG by its ID.
     */
    getById(id: string): Promise<Fvg | null>;
    /**
     * Retrieves all active (unmitigated) FVGs for a specific exchange, symbol, and timeframe.
     */
    getActive(exchange: string, symbol: string, timeframe: string): Promise<Fvg[]>;
    /**
     * Retrieves all active (unmitigated) FVGs across all monitored markets.
     */
    getAllActive(): Promise<Fvg[]>;
    /**
     * Updates an existing FVG (e.g. marking it as mitigated).
     */
    update(fvg: Fvg): Promise<void>;
}
