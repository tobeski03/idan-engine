const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let sock = null;
let whatsappState = {
  status: 'disconnected', // 'disconnected', 'connecting', 'connected'
  pairingCode: null,
  phoneNumber: null,
};

function cleanAuthFolder() {
  const authDir = path.join(__dirname, 'whatsapp-auth');
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }
}

async function disconnectWhatsApp() {
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end();
    } catch (e) {
      // ignore
    }
    sock = null;
  }
  whatsappState.status = 'disconnected';
  whatsappState.pairingCode = null;
  whatsappState.phoneNumber = null;
  cleanAuthFolder();
}

function getWhatsAppStatus() {
  return whatsappState;
}

async function sendWhatsAppMessageDirect(phoneNumber, message) {
  if (!sock || whatsappState.status !== 'connected') {
    throw new Error('WhatsApp client is not connected');
  }
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  const jid = `${cleanNumber}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
  return { ok: true, message: `Message sent programmatically to ${phoneNumber}` };
}

// Internal function to bind all Baileys event listeners
function bindEvents(socketInstance, authDir, saveCreds, appendLog, processMessageThroughModel) {
  socketInstance.ev.on('creds.update', saveCreds);

  socketInstance.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      appendLog(`[WhatsApp] Connection closed (status: ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        whatsappState.status = 'connecting';
        // Auto-reconnect after a 5-second delay
        setTimeout(() => {
          if (whatsappState.status === 'connecting' || whatsappState.status === 'connected') {
            appendLog('[WhatsApp] Attempting auto-reconnection...');
            initWhatsApp(appendLog, processMessageThroughModel).catch((err) => {
              appendLog(`[WhatsApp] Auto-reconnection failed: ${err.message}`);
            });
          }
        }, 5000);
      } else {
        whatsappState.status = 'disconnected';
        whatsappState.pairingCode = null;
        whatsappState.phoneNumber = null;
        cleanAuthFolder();
      }
    } else if (connection === 'open') {
      appendLog(`[WhatsApp] Connected successfully!`);
      whatsappState.status = 'connected';
      whatsappState.pairingCode = null;
      whatsappState.phoneNumber = socketInstance.user?.id.split(':')[0] || null;
    }
  });

  socketInstance.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue; // Skip self messages
      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@s.whatsapp.net')) continue; // Skip groups/non-individual

      const messageText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption;

      if (!messageText) continue;

      appendLog(`[WhatsApp] Received message from ${jid}: ${messageText}`);

      // Run it through the local Gemini model!
      const threadId = `whatsapp_${jid.split('@')[0]}`;
      try {
        const reply = await processMessageThroughModel(threadId, messageText);
        if (reply) {
          appendLog(`[WhatsApp] Replying to ${jid}: ${reply}`);
          await socketInstance.sendMessage(jid, { text: reply });
        }
      } catch (err) {
        appendLog(`[WhatsApp] Error generating response for ${jid}: ${err.message}`);
        try {
          await socketInstance.sendMessage(jid, { text: `[Idan AI Error]: ${err.message}` });
        } catch (sendErr) {
          // ignore send error
        }
      }
    }
  });
}

async function initWhatsApp(appendLog, processMessageThroughModel) {
  const authDir = path.join(__dirname, 'whatsapp-auth');
  const credsFile = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsFile)) {
    return;
  }

  try {
    appendLog(`[WhatsApp] Found existing credentials, connecting...`);
    whatsappState.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });

    bindEvents(sock, authDir, saveCreds, appendLog, processMessageThroughModel);
  } catch (err) {
    appendLog(`[WhatsApp] Auto-init failed: ${err.message}`);
    whatsappState.status = 'disconnected';
  }
}

async function connectWhatsApp(phoneNumber, appendLog, processMessageThroughModel) {
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  if (!cleanNumber) {
    throw new Error('Invalid phone number format');
  }

  // Wreplace any existing connection
  await disconnectWhatsApp();

  whatsappState.status = 'connecting';
  whatsappState.phoneNumber = cleanNumber;
  whatsappState.pairingCode = null;

  appendLog(`[WhatsApp] Initializing pairing for phone number: ${cleanNumber}`);

  const authDir = path.join(__dirname, 'whatsapp-auth');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  bindEvents(sock, authDir, saveCreds, appendLog, processMessageThroughModel);

  // Request pairing code after a short delay to allow socket setup
  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (!sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(cleanNumber);
      whatsappState.pairingCode = code;
      appendLog(`[WhatsApp] Pairing code generated: ${code}`);
      return code;
    } catch (err) {
      appendLog(`[WhatsApp] Failed to request pairing code: ${err.message}`);
      throw err;
    }
  } else {
    whatsappState.status = 'connected';
    whatsappState.pairingCode = null;
    return null;
  }
}

module.exports = {
  initWhatsApp,
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppStatus,
  sendWhatsAppMessageDirect,
};
