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

async function disconnectWhatsApp(wipeAuth = false) {
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
  // Only wipe auth folder when explicitly logging out (status 403 / user request)
  if (wipeAuth) {
    await cleanAuthFolder();
  }
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

// Protocol/control message types that carry no user-readable content.
// These appear naturally after Bad MAC recovery (session re-keying) and must
// be silently ignored rather than treated as empty text messages.
const PROTOCOL_MESSAGE_KEYS = [
  'senderKeyDistributionMessage',
  'protocolMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'pollCreationMessage',
  'keepInChatMessage',
  'messageContextInfo',
  'callLogMesssage', // typo preserved from WA proto
  'callLogMessage',
];

function isDirectChatJid(jid) {
  if (!jid) return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@g.us')) return false;
  if (jid.endsWith('@newsletter')) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
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
        // Logged out — wipe auth so user can re-pair cleanly
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
    appendLog(`[WhatsApp] ── messages.upsert fired: type=${m.type}, count=${m.messages?.length || 0}`);

    if (m.type !== 'notify') {
      appendLog(`[WhatsApp] Skipping upsert — type is '${m.type}', not 'notify' (likely history sync)`);
      return;
    }

    for (const msg of m.messages) {
      const jid = msg.key.remoteJid;
      const msgId = msg.key.id || 'unknown';

      appendLog(`[WhatsApp] Message [${msgId}]: jid=${jid}, fromMe=${msg.key.fromMe}`);

      // ── Step 1: JID filter (1-on-1 chats only) ─────────────────────────
      if (!jid) {
        appendLog(`[WhatsApp] [${msgId}] SKIP — remoteJid is null/empty`);
        continue;
      }
      if (!isDirectChatJid(jid)) {
        appendLog(`[WhatsApp] [${msgId}] SKIP — jid '${jid}' is not a direct chat (group/broadcast/status/newsletter)`);
        continue;
      }

      // ── Step 2: Unwrap message structure ───────────────────────────────
      const rawKeys = Object.keys(msg.message || {}).join(', ') || 'none';
      appendLog(`[WhatsApp] [${msgId}] Raw message keys: ${rawKeys}`);

      const messageContent = unwrapMessage(msg.message);
      if (!messageContent) {
        appendLog(`[WhatsApp] [${msgId}] SKIP — unwrapped messageContent is null/empty`);
        continue;
      }

      const unwrappedKeys = Object.keys(messageContent).join(', ');
      appendLog(`[WhatsApp] [${msgId}] Unwrapped keys: ${unwrappedKeys}`);

      // ── Step 3: Protocol/control message filter ─────────────────────────
      // These are Signal session management frames (key distribution, reactions,
      // poll updates etc.). They arrive naturally after Bad MAC recovery and must
      // be silently discarded — they are never user messages.
      const protocolKeysPresent = PROTOCOL_MESSAGE_KEYS.filter((k) => messageContent[k]);
      const isOnlyProtocol =
        protocolKeysPresent.length > 0 &&
        Object.keys(messageContent).every(
          (k) => PROTOCOL_MESSAGE_KEYS.includes(k) || k === 'messageContextInfo'
        );
      if (isOnlyProtocol) {
        appendLog(`[WhatsApp] [${msgId}] SKIP — protocol/control message (${protocolKeysPresent.join(', ')})`);
        continue;
      }

      // ── Step 4: Extract text ────────────────────────────────────────────
      const messageText =
        messageContent.conversation ||
        messageContent.extendedTextMessage?.text ||
        messageContent.imageMessage?.caption ||
        messageContent.videoMessage?.caption ||
        messageContent.documentMessage?.caption;

      if (!messageText) {
        appendLog(`[WhatsApp] [${msgId}] SKIP — no extractable text found (unwrapped keys: ${unwrappedKeys})`);
        continue;
      }

      appendLog(`[WhatsApp] [${msgId}] Extracted text (${messageText.length} chars): "${messageText.slice(0, 100)}${messageText.length > 100 ? '...' : ''}"`);

      // ── Step 5: fromMe filter ───────────────────────────────────────────
      const isSelf = msg.key.fromMe;
      // Allow testing from self if message starts with !idan or /idan
      const isSelfTest = isSelf && (messageText.startsWith('!idan') || messageText.startsWith('/idan'));

      if (isSelf && !isSelfTest) {
        appendLog(`[WhatsApp] [${msgId}] SKIP — own message (fromMe=true) and not a test command`);
        continue;
      }

      const cleanMessageText = isSelfTest ? messageText.replace(/^([!\/]idan\s*)/i, '') : messageText;
      appendLog(`[WhatsApp] [${msgId}] PASS — from=${jid}, isSelf=${isSelf}, isSelfTest=${isSelfTest} — handing off to bot`);

      // ── Step 6: Process through model ──────────────────────────────────
      const threadId = `whatsapp_${jid.split('@')[0]}`;
      try {
        const reply = await processMessageThroughModel(threadId, cleanMessageText, {
          source: 'whatsapp',
          whatsappIsSelf: isSelfTest,
          whatsappFromMe: isSelf,
          whatsappJid: jid,
        });
        if (reply) {
          appendLog(`[WhatsApp] [${msgId}] Sending reply to ${jid} (${reply.length} chars)`);
          await socketInstance.sendMessage(jid, { text: reply });
          appendLog(`[WhatsApp] [${msgId}] Reply sent OK`);
        } else {
          appendLog(`[WhatsApp] [${msgId}] processMessageThroughModel returned null/empty — no reply sent`);
        }
      } catch (err) {
        appendLog(`[WhatsApp] [${msgId}] Error processing/sending reply for ${jid}: ${err.message}`);
        try {
          await socketInstance.sendMessage(jid, { text: `[Idan AI Error]: ${err.message}` });
        } catch (sendErr) {
          appendLog(`[WhatsApp] [${msgId}] Also failed to send error reply: ${sendErr.message}`);
        }
      }
    }
  });
}

// Shared socket options used by both initWhatsApp and connectWhatsApp.
// getMessage is critical: without it Baileys cannot respond to WhatsApp's
// decryption retry requests, which causes "Bad MAC" errors and broken sessions.
function makeSocketOptions(version, state) {
  return {
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    // macOS fingerprint causes fewer aggressive key-rotation cycles than ubuntu/Chrome
    browser: Browsers.macOS('Desktop'),
    // Required to honour WhatsApp message-retry requests and prevent Bad MAC
    getMessage: async (key) => {
      // We don't maintain a full message store, but returning a placeholder is
      // enough to satisfy the retry handshake and keep sessions healthy.
      return { conversation: '' };
    },
  };
}

async function initWhatsApp(appendLog, processMessageThroughModel) {
  const authDir = path.join(__dirname, 'whatsapp-auth');
  const credsFile = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsFile)) {
    appendLog('[WhatsApp] Auto-init skipped — no credentials found (whatsapp-auth/creds.json missing). Pair via the app first.');
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

    sock = makeWASocket(makeSocketOptions(version, state));

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

  // Close the existing socket WITHOUT wiping credentials so creds survive
  await disconnectWhatsApp(false);

  // Wipe old auth folder explicitly so we start fresh pairing
  await cleanAuthFolder();

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

  sock = makeWASocket(makeSocketOptions(version, state));

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

function unwrapMessage(message) {
  if (!message) return null;
  if (message.deviceSentMessage?.message) {
    return unwrapMessage(message.deviceSentMessage.message);
  }
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

module.exports = {
  initWhatsApp,
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppStatus,
  sendWhatsAppMessageDirect,
};
