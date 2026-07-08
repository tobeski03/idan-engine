"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = void 0;
const events_1 = require("events");
class EventBus {
    static instance;
    emitter;
    constructor() {
        this.emitter = new events_1.EventEmitter();
        // Increase limit for multiple detectors subscribing
        this.emitter.setMaxListeners(100);
    }
    static getInstance() {
        if (!EventBus.instance) {
            EventBus.instance = new EventBus();
        }
        return EventBus.instance;
    }
    emit(event, payload) {
        this.emitter.emit(event, payload);
    }
    on(event, listener) {
        this.emitter.on(event, listener);
    }
    off(event, listener) {
        this.emitter.off(event, listener);
    }
    removeAllListeners(event) {
        this.emitter.removeAllListeners(event);
    }
}
exports.EventBus = EventBus;
