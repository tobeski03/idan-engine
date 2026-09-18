const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function binaryCandidates() {
  const configured = process.env.IDAN_WHATSAPP_BINARY;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch;
  return [
    configured,
    path.join(__dirname, 'bin', `idan-whatsapp-sidecar-${process.platform}-${arch}`),
    path.join(__dirname, 'bin', 'idan-whatsapp-sidecar'),
    path.join(__dirname, 'go', 'whatsapp-sidecar', 'idan-whatsapp-sidecar'),
  ].filter(Boolean);
}

class WhatsmeowBridge {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.status = 'stopped';
    this.registered = false;
    this.user = '';
    this.lastQr = null;
    this.starting = null;
    this.onMessage = null;
    this.onStatus = null;
  }

  binaryPath() {
    return binaryCandidates().find((candidate) => fs.existsSync(candidate));
  }

  emitStatus(status, details = {}) {
    this.status = status;
    this.onStatus?.({ status, ...details });
  }

  ensureChild() {
    if (this.child) return;
    const binary = this.binaryPath();
    if (!binary) throw new Error('WhatsApp whatsmeow sidecar is not installed. Build it for this Android architecture first.');
    const stateDir = process.env.IDAN_WHATSAPP_STATE_DIR || path.join(__dirname, 'whatsapp-whatsmeow');
    fs.mkdirSync(stateDir, { recursive: true });
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, IDAN_WHATSAPP_STATE_DIR: stateDir } });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', (chunk) => this.onStatus?.({ status: 'sidecar_log', message: String(chunk).trim() }));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', (code) => { this.child = null; this.fail(new Error(`WhatsApp sidecar exited${code == null ? '' : ` (${code})`}`)); if (this.status !== 'stopped') this.emitStatus('error'); });
  }

  consume(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.event === 'status') { this.status = message.status || this.status; this.registered = Boolean(message.registered ?? this.registered); this.user = message.user || this.user; if (message.status === 'connected') this.lastQr = null; this.onStatus?.(message); continue; }
      if (message.event === 'qr') { this.lastQr = message.qr || null; this.onStatus?.({ status: 'qr', qr: this.lastQr }); continue; }
      if (message.event === 'message') { this.onMessage?.(message.message); continue; }
      if (message.id && this.pending.has(message.id)) { const pending = this.pending.get(message.id); this.pending.delete(message.id); message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error || 'WhatsApp sidecar request failed')); }
    }
  }

  fail(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  request(op, args = {}) { this.ensureChild(); const id = String(this.nextId++); return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (error) => { if (error) { this.pending.delete(id); reject(error); } }); }); }
  async start() { if (this.starting) return this.starting; this.starting = this.request('start').then((result) => { this.status = result?.status || this.status; this.registered = Boolean(result?.registered ?? this.registered); this.user = result?.user || this.user; return this.statusInfo(); }).finally(() => { this.starting = null; }); return this.starting; }
  async stop() { if (this.child) { try { await this.request('stop'); } finally { this.child.kill(); this.child = null; } } this.emitStatus('stopped'); return this.statusInfo(); }
  statusInfo() { return { status: this.status, connected: this.status === 'connected', registered: this.registered, user: this.user, phoneNumber: this.user.split(':')[0].split('@')[0] || null, qrAvailable: Boolean(this.lastQr), qr: this.lastQr, provider: 'whatsmeow' }; }
  async waitForQr(timeoutMs = 30000) { await this.start(); if (this.lastQr) return this.lastQr; if (this.registered || ['connected', 'logged_out', 'stopped'].includes(this.status)) return null; return new Promise((resolve) => { const timer = setTimeout(() => { this.onStatus = this.onStatus; resolve(null); }, timeoutMs); const previous = this.onStatus; this.onStatus = (event) => { previous?.(event); if (event.status === 'qr' && event.qr) { clearTimeout(timer); this.onStatus = previous; resolve(event.qr); } }; }); }
  sendText(to, text, quotedId, quotedSender) { return this.request('send', { to, text, quotedId, quotedSender }); }
  sendImage(to, url, caption = '') { return this.request('send_image', { to, url, caption }); }
}

const bridge = new WhatsmeowBridge();
let messageHandler = null;
bridge.onMessage = (message) => messageHandler?.(message);

function initWhatsApp(_appendLog, processMessageThroughModel) { messageHandler = async (message) => { const text = String(message?.text || '').trim(); if (!text) return; const context = { source: 'whatsapp', whatsappIsSelf: Boolean(message.internal), whatsappFromMe: Boolean(message.internal), whatsappJid: message.from, quotedId: message.quotedId, quotedSender: message.quotedSender, quotedText: message.quotedText }; const reply = await processMessageThroughModel(`whatsapp_${String(message.from || '').split('@')[0]}`, text, context); if (reply) await bridge.sendText(message.from, reply, message.quotedId, message.quotedSender); }; if (bridge.binaryPath()) return bridge.start().catch(() => null); return null; }
async function connectWhatsApp() { await bridge.start(); const qr = await bridge.waitForQr(); return qr || null; }
async function disconnectWhatsApp() { return bridge.stop(); }
function getWhatsAppStatus() { return bridge.statusInfo(); }
async function sendWhatsAppMessageDirect(phoneNumber, message) { return bridge.sendText(`${String(phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`, message); }
async function sendWhatsAppImageDirect(phoneNumber, url, caption = '') { return bridge.sendImage(`${String(phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`, url, caption); }

module.exports = { initWhatsApp, connectWhatsApp, disconnectWhatsApp, getWhatsAppStatus, sendWhatsAppMessageDirect, sendWhatsAppImageDirect, whatsmeow: bridge };
