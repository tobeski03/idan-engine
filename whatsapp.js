const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let sock = null;
let whatsappState = {
  status: 'disconnected', // 'disconnected', 'connecting', 'connected'
  pairingCode: null,
  phoneNumber: null,
};

async function cleanAuthFolder() {
  const authDir = path.join(__dirname, 'whatsapp-auth');
  if (fs.existsSync(authDir)) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
        break;
      } catch (e) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
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
  await cleanAuthFolder();
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
      whatsappState.phoneNumber = socketInstance.user?.id.split(':')[0].split('@')[0] || null;
    }
  });

  socketInstance.ev.on('messages.upsert', async (m) => {
    appendLog(`[WhatsApp] messages.upsert event: type=${m.type}, count=${m.messages?.length || 0}`);
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@s.whatsapp.net')) continue; // Skip groups/non-individual

      let messageContent = msg.message;
      if (messageContent?.ephemeralMessage) {
        messageContent = messageContent.ephemeralMessage.message;
      }
      if (messageContent?.viewOnceMessage) {
        messageContent = messageContent.viewOnceMessage.message;
      }
      if (messageContent?.viewOnceMessageV2) {
        messageContent = messageContent.viewOnceMessageV2.message;
      }
      if (messageContent?.documentWithCaptionMessage) {
        messageContent = messageContent.documentWithCaptionMessage.message;
      }

      const messageText = messageContent?.conversation || 
                          messageContent?.extendedTextMessage?.text || 
                          messageContent?.imageMessage?.caption || 
                          messageContent?.videoMessage?.caption ||
                          messageContent?.documentMessage?.caption;

      if (!messageText) continue;

      const isSelf = msg.key.fromMe;
      // Allow testing from self if message starts with !idan or /idan
      const isSelfTest = isSelf && (messageText.startsWith('!idan') || messageText.startsWith('/idan'));
      
      if (isSelf && !isSelfTest) continue; // Skip self messages unless it's a test command

      const cleanMessageText = isSelfTest ? messageText.replace(/^([!\/]idan\s*)/i, '') : messageText;

      appendLog(`[WhatsApp] Received message from ${jid} (isSelf=${isSelf}, isSelfTest=${isSelfTest}): ${cleanMessageText}`);

      // Run it through the local Gemini model!
      const threadId = `whatsapp_${jid.split('@')[0]}`;
      try {
        const reply = await processMessageThroughModel(threadId, cleanMessageText);
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

  try {
    appendLog(`[WhatsApp] Found existing credentials, connecting...`);
    whatsappState.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version = [2, 3000, 1017531287];
    try {
      const { version: latestVersion } = await fetchLatestBaileysVersion();
      version = latestVersion;
    } catch (err) {
      appendLog(`[WhatsApp] Failed to fetch latest version: ${err.message}`);
    }

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
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

  let version = [2, 3000, 1017531287];
  try {
    const { version: latestVersion } = await fetchLatestBaileysVersion();
    version = latestVersion;
  } catch (err) {
    appendLog(`[WhatsApp] Failed to fetch latest version: ${err.message}`);
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
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
