"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonFvgRepository = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
class JsonFvgRepository {
    filePath;
    writeQueue = Promise.resolve();
    constructor(customFilePath) {
        this.filePath = customFilePath || path.join(__dirname, '..', 'data', 'fvgs.json');
        this.ensureDirectoryExistence();
    }
    ensureDirectoryExistence() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify([]), 'utf8');
        }
    }
    async readData() {
        try {
            const data = await fs.promises.readFile(this.filePath, 'utf8');
            return JSON.parse(data);
        }
        catch (error) {
            Logger_1.Logger.error(`Failed to read FVG data file`, error);
            return [];
        }
    }
    enqueueWrite(data) {
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                const tempPath = `${this.filePath}.tmp`;
                await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
                await fs.promises.rename(tempPath, this.filePath);
            }
            catch (error) {
                Logger_1.Logger.error(`Failed to write FVG data atomically`, error);
            }
        });
        return this.writeQueue;
    }
    async save(fvg) {
        const data = await this.readData();
        // Prevent duplicates
        if (data.some((item) => item.id === fvg.id)) {
            Logger_1.Logger.warn(`FVG with ID ${fvg.id} already exists in database. Skipping.`);
            return;
        }
        data.push(fvg);
        await this.enqueueWrite(data);
    }
    async saveAll(fvgs) {
        const data = await this.readData();
        let updated = false;
        for (const fvg of fvgs) {
            if (!data.some((item) => item.id === fvg.id)) {
                data.push(fvg);
                updated = true;
            }
            else {
                Logger_1.Logger.warn(`FVG with ID ${fvg.id} already exists in database. Skipping.`);
            }
        }
        if (updated) {
            await this.enqueueWrite(data);
        }
    }
    async getById(id) {
        const data = await this.readData();
        return data.find((item) => item.id === id) || null;
    }
    async getActive(exchange, symbol, timeframe) {
        const data = await this.readData();
        return data.filter((item) => item.state === 'active' &&
            item.exchange.toLowerCase() === exchange.toLowerCase() &&
            item.symbol.toLowerCase() === symbol.toLowerCase() &&
            item.timeframe.toLowerCase() === timeframe.toLowerCase());
    }
    async getAllActive() {
        const data = await this.readData();
        return data.filter((item) => item.state === 'active');
    }
    async update(fvg) {
        const data = await this.readData();
        const index = data.findIndex((item) => item.id === fvg.id);
        if (index >= 0) {
            data[index] = fvg;
            await this.enqueueWrite(data);
        }
        else {
            Logger_1.Logger.error(`Failed to update FVG: ID ${fvg.id} not found in database.`);
        }
    }
}
exports.JsonFvgRepository = JsonFvgRepository;
