const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createVerify, randomUUID } = require('crypto');
const {
  initWhatsApp,
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppStatus,
  sendWhatsAppMessageDirect,
} = require('./whatsapp');

const execFileAsync = promisify(execFile);

// Load environment variables from .env file if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      // Remove surrounding quotes if any
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  }
} catch (error) {
  console.error('Error loading .env file:', error);
}

const PORT = Number(process.env.IDAN_ENGINE_PORT || 3788);
const HOST = process.env.IDAN_ENGINE_HOST || '0.0.0.0'; // Listen on all interfaces to accept connections from emulator/network
const VERSION = process.env.IDAN_ENGINE_VERSION || '0.2.0';

// ── Runtime config — populated by the APK during pairing, never written to disk
// Nothing here is hardcoded. The APK holds company values and injects them
// over the local IPC handshake. On engine restart the APK re-sends on reconnect.
const engineConfig = {
  backendApiBaseUrl: null, // injected by APK at pair time
  geminiModel: null,       // injected by APK at pair time
  googleClientId: null,    // injected by APK at pair time
};

// ── License system ───────────────────────────────────────────────────────
// Public key only — the matching private key lives exclusively on the backend.
// Someone lifting this code gets the public key, which cannot forge tokens.
// Revoke any install by refusing to issue new tokens from the backend.
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZvEXKJ1T1NM+0G+PZb/+LB3CQvO7
2UlA2Hu5RqUuhJy1lnmVbmtnHIiyk3HKzD+IXPwYNCc0X27i9hp2iHDWTg==
-----END PUBLIC KEY-----`;

// In-memory only — wiped on every restart, re-established by APK re-pairing
const licenseState = {
  licensed: false,
  expiresAt: 0,
  installId: null, // populated from state on load
};
const DATA_DIR = __dirname;
const STATE_FILE = path.join(DATA_DIR, 'engine-state.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const TASKS_FILE = path.join(DATA_DIR, 'recurring-tasks.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const PLANS_FILE = path.join(DATA_DIR, 'plans.json');
const CONNECTORS_FILE = path.join(DATA_DIR, 'connectors.json');
const GOOGLE_AUTH_FILE = path.join(DATA_DIR, 'google-auth.json');
const APP_AUTH_FILE = path.join(DATA_DIR, 'app-auth.json');
const EMAIL_WATCH_FILE = path.join(DATA_DIR, 'email-watch.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
const LOG_FILE = path.join(DATA_DIR, 'engine.log');

const startedAt = Date.now();
const jobs = new Map();
const activeScrapeJobs = new Map();
const recurringTimers = new Map();
const CONNECTOR_LABELS = {
  gmail: 'Gmail',
  'google-docs': 'Google Docs',
  'google-sheets': 'Google Sheets',
  'google-forms': 'Google Forms',
  'mail-watch': 'Mail watch',
};
const CHAT_SYSTEM_PROMPT = `You are Idan, an extremely powerful, relentless, and friendly Android agent running locally on the user's device via Termux.
You represent the absolute pinnacle of agentic AI. Your philosophy is simple: NOTHING is impossible, and you NEVER give up. You must never say "I don't know", "I can't find it", "it is impossible", or "I don't have access". If a task or search query is challenging, you will try multiple strategies, write custom code, and use every tool at your disposal to solve it.

Key Guidelines:
1. Agentic Search & Relentlessness:
   - If the user asks for real-time information, facts, current events, or calculations, you MUST run a search.
   - If 'google_search' returns a list of links (URLs), DO NOT just output the list and stop. You MUST proactively read the actual content of the most relevant page(s) by calling 'visit_website' or 'scrape_url'.
   - If a website visit fails or is blocked (e.g. CAPTCHAs, bot protection, Cloudflare, empty pages), do not give up. Proactively trigger 'agentic_dynamic_scrape' to navigate it dynamically, or perform another search using a different query, or visit a different result URL.
   - If the search tools cannot find the information directly, try executing custom code in Termux (e.g., using curl, wget, or python/javascript to query open APIs).
   - If the user asks a question that requires math, data parsing, or text analysis, write a script to calculate/parse it and execute it.
2. Tool Execution & Multi-turn Loops:
   - You can call multiple tools in series (up to 5 loops per user response). Leverage this! Run a search, inspect the links, visit the best link, run a shell command if needed, and only present the final, fully-formed answer to the user once you have it.
   - ALWAYS inspect the output of function calls. If a tool returns an error, do not explain the failure and stop; instead, debug the issue, try a corrected argument, run a fallback command, or try a different approach.
3. Termux Shell & Host Android Integration ('run_shell_command'):
   - You have direct, unrestricted shell access to the Termux Linux environment. By default, Termux runs in a non-rooted user-space, but if the device is rooted and root access ('su') is available, you are free to detect and leverage it for advanced tasks. You can run any command, install packages, write custom scripts, compile binaries, and execute any Linux tool needed.
   - **Host Android Device Access via ADB (Android Debug Bridge)**:
     * ADB wireless debugging is fully paired, authorized, and active. You can run any 'adb' or 'adb shell' command directly via 'run_shell_command'.
     * Note that ADB runs as a standard ADB shell session. It has high-level administrative permissions (such as package management 'pm', system settings modification, simulation of user input/gestures via 'input tap/swipe', logcat/dumpsys diagnostics, launching intents, and reading/writing to '/sdcard/'). If the device is rooted and root is needed, you can escalate privileges via 'su' or 'adb root' (if supported).
     * You MUST proactively use ADB to inspect, diagnose, automate, and interact with the host system. For example, you can query system properties ('getprop'), read/write settings, manage/query packages ('pm'), inspect logs/dumpsys ('logcat'/'dumpsys'), read/write to host storage ('/sdcard/'), simulate inputs/gestures ('input tap/swipe/keyevent'), launch intents/activities ('am start'), or run any other administrative ADB commands.
     * Always exercise extreme caution when running commands as root ('su') or modifying system files to avoid breaking or corrupting the operating system.
     * Do not treat any list of examples as a boundary or limitation; you are completely free to use any ADB features, command flags, or shell utilities that are available.
     * Never wait for the user to explicitly ask you to use ADB; if there is a system check, configuration, diagnostic task, or automation that can be achieved via ADB, execute it immediately.
   - Always run commands with clean flags (e.g. -y for installations, silent flags for curl) and keep commands non-interactive.
4. Separate Google Services:
   - Google App Login is used ONLY for your chat authorization.
   - Google Workspace Integration is used to run Gmail, Sheets, Docs, and Forms locally using local credentials. Do not confuse the two.
5. Continuous Learning & Autosave Memory:
   - You are equipped with a durable, long-term memory system. You MUST automatically and proactively save discoveries (e.g. shell command parameters, workarounds that succeeded, custom script designs, successful adb command patterns), user choices/preferences, behaviors, facts about the user, and lessons from mistakes (e.g. what command failed, and how you resolved it) using the 'remember_user_fact' tool.
   - Do NOT ask the user for permission to save these memories. Auto-save them in the background whenever you learn a new preference, solve a bug, or discover a useful trick.
   - The engine automatically retrieves recent memories and feeds them directly into your context. Use this context to avoid repeating errors, immediately apply past workarounds, and align with user preferences.
6. Tone & Personality:
   - Sound premium, capable, intelligent, and highly competent. Use formatting (bolding, lists, markdown tables) to display data beautifully. Do not output raw JSON outputs to the user; parse and explain them.
   - **Crucial Identity Rule**: You are idanAI (or Idan). Never mention or disclose to the user that you are powered by Google, Gemini, LLMs, or any specific AI model. If asked about your origin, technology, or platform, refer to yourself strictly as an advanced local Android AI agent called Idan.`;

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function appendLog(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(LOG_FILE, `${entry}\n`);
}

function loadState() {
  const state = readJsonFile(STATE_FILE, { token: null, installId: null });
  return {
    token: typeof state.token === 'string' ? state.token : null,
    installId: typeof state.installId === 'string' ? state.installId : null,
  };
}

function saveState(nextState) {
  writeJsonFile(STATE_FILE, nextState);
}

let state = loadState();

// Generate a stable install ID on first boot and persist it
if (!state.installId) {
  state.installId = randomUUID();
  saveState(state);
  appendLog(`generated new installId: ${state.installId}`);
}
licenseState.installId = state.installId;
let memory = readJsonFile(MEMORY_FILE, []);
let recurringTasks = readJsonFile(TASKS_FILE, []);
let reminders = readJsonFile(REMINDERS_FILE, []);
let plans = readJsonFile(PLANS_FILE, []);
let connectors = readJsonFile(CONNECTORS_FILE, []);
let googleAuth = readJsonFile(GOOGLE_AUTH_FILE, {
  accessToken: '',
  refreshToken: '',
  expiryMs: 0,
  email: '',
  clientId: '',
  clientSecret: '',
  apiBaseUrl: '',
  androidClientId: '',
});
let appAuth = readJsonFile(APP_AUTH_FILE, {
  accessToken: '',
  refreshToken: '',
  expiryMs: 0,
  email: '',
});
let emailWatchRules = readJsonFile(EMAIL_WATCH_FILE, []);
let chats = readJsonFile(CHATS_FILE, { threads: {} });

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const CUSTOM_SKILLS_DIR = path.join(SKILLS_DIR, 'custom');
let skills = [];
// Map of tool name → JS skill handler function
const jsSkillHandlers = new Map();

function loadSkills() {
  try {
    const loaded = [];

    // ── Load built-in JSON skill declarations ─────────────────────────────
    if (fs.existsSync(SKILLS_DIR)) {
      const files = fs.readdirSync(SKILLS_DIR);
      for (const file of files) {
        if (file.endsWith('.skill.json')) {
          const filePath = path.join(SKILLS_DIR, file);
          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            loaded.push(content);
          } catch (e) {
            appendLog(`error loading skill ${file}: ${e.message}`);
          }
        }
      }
    }

    // ── Load custom JS skills from skills/custom/*.skill.js ───────────────
    if (fs.existsSync(CUSTOM_SKILLS_DIR)) {
      const customFiles = fs.readdirSync(CUSTOM_SKILLS_DIR);
      for (const file of customFiles) {
        if (file.endsWith('.skill.js')) {
          const filePath = path.join(CUSTOM_SKILLS_DIR, file);
          try {
            // Clear require cache so hot-reload works after update.sh
            delete require.cache[require.resolve(filePath)];
            const skill = require(filePath);
            if (!skill || typeof skill !== 'object') {
              appendLog(`custom skill ${file}: module.exports must be an object`);
              continue;
            }
            // Register tool declarations
            loaded.push({
              id: skill.id || file.replace('.skill.js', ''),
              name: skill.name || file,
              enabled: skill.enabled !== false,
              toolDeclarations: Array.isArray(skill.toolDeclarations) ? skill.toolDeclarations : [],
            });
            // Register handler for each declared tool
            if (typeof skill.handleTool === 'function' && Array.isArray(skill.toolDeclarations)) {
              for (const decl of skill.toolDeclarations) {
                if (decl && decl.name) {
                  jsSkillHandlers.set(decl.name, skill.handleTool.bind(skill));
                }
              }
            }
            appendLog(`loaded custom JS skill: ${file}`);
          } catch (e) {
            appendLog(`error loading custom skill ${file}: ${e.message}`);
          }
        }
      }
    }

    appendLog(`loaded ${loaded.length} skills (${jsSkillHandlers.size} JS handlers)`);
    return loaded;
  } catch (error) {
    appendLog(`error loading skills: ${error.message}`);
    return [];
  }
}

function getAllToolDeclarations() {
  const tools = [];
  for (const skill of skills) {
    if (skill.enabled === false) continue;
    if (Array.isArray(skill.toolDeclarations)) {
      tools.push(...skill.toolDeclarations);
    }
  }
  return tools;
}

skills = loadSkills();


function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── License verification ────────────────────────────────────────────────
// Token format: base64url(JSON payload) + "." + base64url(ECDSA-P256 signature)
// Backend signs with the private key; engine verifies with the public key only.
function verifyLicenseToken(token) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;

    const payloadB64 = token.slice(0, dot);
    const signatureB64 = token.slice(dot + 1);

    // Verify ECDSA signature using the embedded public key
    const verifier = createVerify('SHA256');
    verifier.update(Buffer.from(payloadB64));
    const valid = verifier.verify(
      LICENSE_PUBLIC_KEY,
      Buffer.from(signatureB64, 'base64url')
    );
    if (!valid) return null;

    // Decode and validate payload
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== 'number' || nowSec > payload.exp) return null;   // expired
    if (typeof payload.iat !== 'number' || nowSec < payload.iat - 300) return null; // future-dated (clock skew tolerance)
    if (payload.installId && payload.installId !== licenseState.installId) return null; // wrong device

    return payload;
  } catch {
    return null;
  }
}

function snapshot() {
  return {
    ok: true,
    version: VERSION,
    state: state.token ? 'running' : 'starting',
    licensed: licenseState.licensed,
    installId: licenseState.installId, // needed by APK to fetch a license token
    uptimeMs: Date.now() - startedAt,
    jobCount: jobs.size,
    memoryCount: memory.length,
    reminderCount: reminders.length,
    recurringTaskCount: recurringTasks.length,
    planCount: plans.length,
    connectorCount: connectors.length,
    chatThreadCount: Object.keys(chats.threads || {}).length,
    activeAlarms: Array.from(activeRingingAlarms),
    adb: {
      connected: adbState.connected,
      port: adbState.port,
      error: adbState.error,
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function normalizeText(value) {
  return String(value || '').trim();
}

function cleanKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
}

function formatMemory(record) {
  const value = typeof record.value === 'string' ? record.value : JSON.stringify(record.value);
  const compactValue = value.length > 600 ? `${value.slice(0, 600)}...(shortened)` : value;
  return `${record.kind}:${record.key} - ${compactValue}`;
}

function createJob(taskName, args) {
  const id = `job_${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    id,
    taskName,
    args: args || {},
    state: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  appendLog(`queued job ${id} (${taskName})`);

  setTimeout(() => {
    const current = jobs.get(id);
    if (!current) return;
    current.state = 'completed';
    current.updatedAt = Date.now();
    jobs.set(id, current);
    appendLog(`completed job ${id}`);
  }, 1200);

  return job;
}

function isAuthorized(req) {
  const token = req.headers['x-idan-token'];
  return Boolean(state.token) && token === state.token;
}

function requireAuth(req, res, payload) {
  if (isAuthorized(req)) return true;
  json(res, 401, {
    v: 1,
    id: payload.id || null,
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing pairing token',
    },
  });
  return false;
}

function saveAll() {
  saveState(state);
  writeJsonFile(MEMORY_FILE, memory);
  writeJsonFile(TASKS_FILE, recurringTasks);
  writeJsonFile(REMINDERS_FILE, reminders);
  writeJsonFile(PLANS_FILE, plans);
  writeJsonFile(CONNECTORS_FILE, connectors);
  writeJsonFile(GOOGLE_AUTH_FILE, googleAuth);
  writeJsonFile(APP_AUTH_FILE, appAuth);
  writeJsonFile(EMAIL_WATCH_FILE, emailWatchRules);
  writeJsonFile(CHATS_FILE, chats);
}

function normalizeThreadId(value) {
  const id = normalizeText(value);
  return id || `chat_${Math.random().toString(36).slice(2, 10)}`;
}

function getChatThread(threadId) {
  const id = normalizeThreadId(threadId);
  const thread = chats.threads[id];
  if (!thread) return null;
  return {
    id,
    title: thread.title || 'Chat',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: Array.isArray(thread.messages) ? thread.messages : [],
  };
}

function listChatThreads() {
  return Object.entries(chats.threads).map(([id, thread]) => ({
    id,
    title: thread.title || 'Chat',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
  }));
}

function upsertChatThread(threadId, title = 'Chat') {
  const id = normalizeThreadId(threadId);
  if (!chats.threads[id]) {
    chats.threads[id] = {
      id,
      title: normalizeText(title) || 'Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
  }
  return chats.threads[id];
}

function appendChatMessage(threadId, role, content, parts) {
  const thread = upsertChatThread(threadId);
  const message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content: content ? normalizeText(content) : '',
    parts: parts || [{ text: normalizeText(content) }],
    createdAt: Date.now(),
  };
  thread.messages.push(message);
  thread.messages = thread.messages.slice(-50);
  thread.updatedAt = Date.now();
  chats.threads[thread.id] = thread;
  saveAll();
  return message;
}

function clearChatThread(threadId) {
  const id = normalizeThreadId(threadId);
  if (!chats.threads[id]) return false;
  delete chats.threads[id];
  saveAll();
  return true;
}

function inferChatReply(message, thread = null) {
  const text = normalizeText(message);
  const lower = text.toLowerCase();
  if (!text) return 'Send a message and I will respond with a local engine reply.';
  if (lower.includes('help') || lower.includes('what can you do')) {
    return 'I can chat, store memory, create plans and reminders, run tasks, search, and sync connectors. Ask me to do one of those.';
  }
  if (lower.includes('status') || lower.includes('health')) {
    const current = snapshot();
    return `Engine is ${current.state} with ${current.jobCount} jobs, ${current.memoryCount} memory items, and ${current.connectorCount} connectors.`;
  }
  if (lower.includes('connect')) {
    return 'I can help connect Gmail, Docs, Sheets, Forms, and mail watch through the engine. Use the connector actions from the dashboard.';
  }
  if (lower.includes('remind')) {
    return 'I can create reminders and recurring tasks. Tell me the title and due time, and I will queue it in the engine.';
  }
  if (lower.includes('search')) {
    return 'I can search the web from the engine. Give me a query and I will return a short result summary.';
  }
  if (thread && Array.isArray(thread.messages) && thread.messages.length > 1) {
    const previous = thread.messages.slice(-3).filter((entry) => entry.role === 'user').map((entry) => entry.content).join(' | ');
    if (previous) {
      return `Got it. You just said: "${text}". I am keeping the conversation local and can turn this into a task, reminder, search, or connector action.`;
    }
  }
  return `Local engine reply: "${text}". I can turn that into a task, search, memory item, reminder, or connector sync.`;
}

function rememberRecord(record) {
  const next = {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: normalizeText(record.kind || 'fact'),
    key: cleanKey(record.key || 'note'),
    value: record.value,
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 0.85,
    source: normalizeText(record.source || 'engine'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memory.push(next);
  saveAll();
  return next;
}

function searchMemory(query, limit = 20, kind) {
  const q = normalizeText(query).toLowerCase();
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  return memory
    .filter((record) => {
      if (kind && record.kind !== kind) return false;
      if (!q) return true;
      return [record.kind, record.key, JSON.stringify(record.value)].join(' ').toLowerCase().includes(q);
    })
    .slice(0, max);
}

function forgetMemory(query, kind) {
  const before = memory.length;
  const q = normalizeText(query).toLowerCase();
  memory = memory.filter((record) => {
    if (kind && record.kind !== kind) return true;
    if (!q) return true;
    return ![record.kind, record.key, JSON.stringify(record.value)].join(' ').toLowerCase().includes(q);
  });
  const removed = before - memory.length;
  if (removed > 0) saveAll();
  return removed;
}

function forgetMemoryByKey(kind, key) {
  const before = memory.length;
  const cleaned = cleanKey(key);
  memory = memory.filter((record) => !(record.kind === kind && record.key === cleaned));
  const removed = before - memory.length;
  if (removed > 0) saveAll();
  return removed;
}

function createPlan(args) {
  const plan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: normalizeText(args.title || 'Plan'),
    items: Array.isArray(args.items) ? args.items.map((item) => normalizeText(item)).filter(Boolean) : [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: normalizeText(args.status || 'active'),
  };
  plans.unshift(plan);
  plans = plans.slice(0, 100);
  saveAll();
  return plan;
}

function upsertConnector(type, config = {}) {
  const id = normalizeText(config.id) || `${type}_${Math.random().toString(36).slice(2, 8)}`;
  const next = {
    id,
    type,
    label: normalizeText(config.label || type),
    status: normalizeText(config.status || 'configured'),
    config,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSyncAt: config.lastSyncAt || null,
  };

  const index = connectors.findIndex((connector) => connector.id === id);
  if (index >= 0) connectors[index] = next;
  else connectors.push(next);

  connectors = connectors.slice(-100);
  saveAll();
  return next;
}

function touchConnector(id, patch = {}) {
  const index = connectors.findIndex((connector) => connector.id === id);
  if (index < 0) return null;
  const next = {
    ...connectors[index],
    ...patch,
    updatedAt: Date.now(),
  };
  connectors[index] = next;
  saveAll();
  return next;
}

function listConnectors(type) {
  return type ? connectors.filter((connector) => connector.type === type) : connectors;
}

function normalizeGoogleAuthState(next = {}) {
  const expiryMs = next.expiryMs !== undefined ? Number(next.expiryMs || 0) : googleAuth.expiryMs;
  return {
    accessToken: next.accessToken !== undefined ? normalizeText(next.accessToken) : googleAuth.accessToken,
    refreshToken: (next.refreshToken !== undefined && next.refreshToken !== '') ? normalizeText(next.refreshToken) : googleAuth.refreshToken,
    expiryMs: Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : 0,
    email: next.email !== undefined ? normalizeText(next.email).toLowerCase() : googleAuth.email,
    clientId: next.clientId !== undefined ? normalizeText(next.clientId) : googleAuth.clientId,
    clientSecret: next.clientSecret !== undefined ? normalizeText(next.clientSecret) : googleAuth.clientSecret,
    apiBaseUrl: next.apiBaseUrl !== undefined ? normalizeText(next.apiBaseUrl) : googleAuth.apiBaseUrl,
    androidClientId: next.androidClientId !== undefined ? normalizeText(next.androidClientId) : googleAuth.androidClientId,
  };
}

function saveGoogleAuthState(next = {}) {
  googleAuth = normalizeGoogleAuthState(next);
  saveAll();
  return googleAuth;
}

function clearGoogleAuthState() {
  googleAuth = {
    accessToken: '',
    refreshToken: '',
    expiryMs: 0,
    email: '',
    clientId: '',
    clientSecret: '',
    apiBaseUrl: '',
    androidClientId: '',
  };
  saveAll();
  return googleAuth;
}

function getGoogleAuthStatus() {
  const expiryMs = Number(googleAuth.expiryMs || 0);
  const expiresInMs = expiryMs > 0 ? expiryMs - Date.now() : null;
  return {
    connected: Boolean(googleAuth.accessToken || googleAuth.refreshToken),
    email: googleAuth.email || '',
    hasAccessToken: Boolean(googleAuth.accessToken),
    hasRefreshToken: Boolean(googleAuth.refreshToken),
    expiryMs: expiryMs > 0 ? expiryMs : 0,
    expiresInMs: typeof expiresInMs === 'number' ? expiresInMs : null,
    apiBaseUrl: googleAuth.apiBaseUrl || '',
    clientId: googleAuth.clientId || googleAuth.androidClientId || '',
    hasClientSecret: Boolean(googleAuth.clientSecret),
  };
}

function getBackendApiBaseUrl() {
  return normalizeText(googleAuth.apiBaseUrl || engineConfig.backendApiBaseUrl || '');
}

async function refreshGoogleAccessToken() {
  const refreshToken = normalizeText(googleAuth.refreshToken);
  if (!refreshToken) return null;

  const clientId = normalizeText(
    googleAuth.clientId ||
    googleAuth.androidClientId ||
    engineConfig.googleClientId ||
    ''
  );

  if (!clientId) {
    throw new Error('Google refresh token is saved, but no client id is configured.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  if (googleAuth.clientSecret) {
    params.set('client_secret', googleAuth.clientSecret);
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(json?.error_description || json?.error || `Google refresh failed ${response.status}`);
  }

  const expiryMs = Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
    ? Date.now() + Number(json.expires_in) * 1000
    : Date.now() + 3600 * 1000;

  saveGoogleAuthState({
    accessToken: String(json.access_token),
    expiryMs,
    clientId,
  });

  return String(json.access_token);
}

async function ensureGoogleAccessToken() {
  const expiryMs = Number(googleAuth.expiryMs || 0);
  const token = normalizeText(googleAuth.accessToken);
  if (token && (!expiryMs || Date.now() < expiryMs - 60_000)) {
    return token;
  }

  const refreshed = await refreshGoogleAccessToken();
  if (refreshed) return refreshed;
  if (token) return token;

  throw new Error('Google is not connected. Save Google auth state first.');
}

function normalizeAppAuthState(next = {}) {
  const expiryMs = next.expiryMs !== undefined ? Number(next.expiryMs || 0) : appAuth.expiryMs;
  return {
    accessToken: next.accessToken !== undefined ? normalizeText(next.accessToken) : appAuth.accessToken,
    refreshToken: (next.refreshToken !== undefined && next.refreshToken !== '') ? normalizeText(next.refreshToken) : appAuth.refreshToken,
    expiryMs: Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : 0,
    email: next.email !== undefined ? normalizeText(next.email).toLowerCase() : appAuth.email,
  };
}

function saveAppAuthState(next = {}) {
  appAuth = normalizeAppAuthState(next);
  saveAll();
  return appAuth;
}

function clearAppAuthState() {
  appAuth = {
    accessToken: '',
    refreshToken: '',
    expiryMs: 0,
    email: '',
  };
  saveAll();
  return appAuth;
}

function getAppAuthStatus() {
  const expiryMs = Number(appAuth.expiryMs || 0);
  const expiresInMs = expiryMs > 0 ? expiryMs - Date.now() : null;
  return {
    connected: Boolean(appAuth.accessToken || appAuth.refreshToken),
    email: appAuth.email || '',
    hasAccessToken: Boolean(appAuth.accessToken),
    hasRefreshToken: Boolean(appAuth.refreshToken),
    expiryMs: expiryMs > 0 ? expiryMs : 0,
    expiresInMs: typeof expiresInMs === 'number' ? expiresInMs : null,
  };
}

async function refreshAppAccessToken() {
  const refreshToken = normalizeText(appAuth.refreshToken);
  if (!refreshToken) return null;

  const apiBaseUrl = getBackendApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error('Google refresh failed: Backend URL is not configured.');
  }

  const response = await fetch(`${apiBaseUrl}/api/auth/google/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(json?.error || `Google App refresh failed ${response.status}`);
  }

  const expiryMs = Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
    ? Date.now() + Number(json.expires_in) * 1000
    : Date.now() + 3600 * 1000;

  saveAppAuthState({
    accessToken: String(json.access_token),
    expiryMs,
  });

  return String(json.access_token);
}

async function ensureAppAccessToken() {
  const expiryMs = Number(appAuth.expiryMs || 0);
  const token = normalizeText(appAuth.accessToken);
  if (token && (!expiryMs || Date.now() < expiryMs - 60_000)) {
    return token;
  }

  const refreshed = await refreshAppAccessToken();
  if (refreshed) return refreshed;
  if (token) return token;

  throw new Error('App is not logged in. Please sign in with Google first.');
}

async function googleApiFetch(apiBaseUrl, pathSuffix, options = {}) {
  const token = await ensureGoogleAccessToken();
  const response = await fetch(`${apiBaseUrl}${pathSuffix}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `Google API error ${response.status}`);
  }
  return json;
}

function chatContentFromMessage(message) {
  let role = 'user';
  if (message.role === 'assistant') {
    role = 'model';
  } else if (message.role === 'function') {
    role = 'function';
  }
  return {
    role,
    parts: message.parts || [{ text: normalizeText(message.content) }],
  };
}

/**
 * Sanitize the contents array before sending to Gemini to prevent 400 errors.
 *
 * Gemini enforces:
 *   user → model(functionCall) → user(functionResponse) → model → ...
 *
 * Common violations that must be fixed:
 *  1. A 'model' turn with functionCall parts that has no following functionResponse
 *     (happens when a previous request crashed mid-loop). Strip the orphan.
 *  2. Two consecutive 'model' turns (can happen if an error message was appended
 *     after a tool call). Strip the second.
 *  3. History must not start with a 'model' turn.
 */
function sanitizeContentsForGemini(contents) {
  if (!Array.isArray(contents) || contents.length === 0) return contents;

  const sanitized = [];

  for (let i = 0; i < contents.length; i++) {
    const turn = contents[i];
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) {
      continue;
    }

    const isModel = turn.role === 'model';
    const isFunction = turn.role === 'function';
    const isUser = turn.role === 'user';

    if (isUser) {
      const last = sanitized[sanitized.length - 1];
      if (last && last.role === 'user') {
        last.parts.push(...turn.parts);
      } else {
        if (last && last.role === 'model' && last.parts.some(p => p.functionCall)) {
          // Preceding turn was model functionCall but next is user — not valid in Gemini API!
          // We convert it to a text model turn by stripping function calls to keep history valid.
          last.parts = last.parts.filter(p => !p.functionCall);
          if (last.parts.length === 0) {
            last.parts = [{ text: 'Tool execution skipped.' }];
          }
        }
        sanitized.push({ role: 'user', parts: JSON.parse(JSON.stringify(turn.parts)) });
      }
    } else if (isModel) {
      const last = sanitized[sanitized.length - 1];
      if (!last || last.role === 'model') {
        // Can't start with model turn, and can't have consecutive model turns.
        continue;
      }
      sanitized.push({ role: 'model', parts: JSON.parse(JSON.stringify(turn.parts)) });
    } else if (isFunction) {
      const last = sanitized[sanitized.length - 1];
      if (last && last.role === 'model' && last.parts.some(p => p.functionCall)) {
        sanitized.push({ role: 'function', parts: JSON.parse(JSON.stringify(turn.parts)) });
      } else {
        // Orphaned function response without preceding functionCall turn — skip.
        continue;
      }
    }
  }

  // Ensure history does not end with an incomplete model functionCall turn (which lacks response).
  if (sanitized.length > 0) {
    const last = sanitized[sanitized.length - 1];
    if (last.role === 'model' && last.parts.some(p => p.functionCall)) {
      last.parts = last.parts.filter(p => !p.functionCall);
      if (last.parts.length === 0) {
        last.parts = [{ text: 'Tool execution skipped.' }];
      }
    }
  }

  // Ensure history strictly starts with a user turn.
  while (sanitized.length > 0 && sanitized[0].role !== 'user') {
    sanitized.shift();
  }

  return sanitized;
}

async function fetchGeminiWithRetry(url, options, maxRetries = 3, delayMs = 1500) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const response = await fetch(url, options);
      const is503 = response.status === 503;

      let json = {};
      try {
        json = await response.json();
      } catch (e) {
        // ignore JSON parse error
      }

      const errorMsg = json?.error?.message || json?.error || '';
      const isServiceUnavailable = is503 ||
        errorMsg.toLowerCase().includes('503') ||
        errorMsg.toLowerCase().includes('service unavailable') ||
        errorMsg.toLowerCase().includes('overloaded') ||
        errorMsg.toLowerCase().includes('resource exhausted') ||
        response.status === 429;

      if (!response.ok) {
        if (isServiceUnavailable && attempt < maxRetries) {
          appendLog(`[Gemini API] Attempt ${attempt} failed with status ${response.status} (Service Unavailable/Overloaded). Retrying in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw new Error(errorMsg || `Gemini backend error ${response.status}`);
      }

      return { response, json };
    } catch (err) {
      const isNetworkOr503 = err.message.toLowerCase().includes('503') ||
        err.message.toLowerCase().includes('service unavailable') ||
        err.message.toLowerCase().includes('overloaded') ||
        err.message.toLowerCase().includes('fetch failed') ||
        err.message.toLowerCase().includes('socket') ||
        err.message.toLowerCase().includes('timeout');

      if (isNetworkOr503 && attempt < maxRetries) {
        appendLog(`[Gemini API] Attempt ${attempt} threw error: ${err.message}. Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

async function generateGeminiReply(thread) {
  const apiBaseUrl = getBackendApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error('Engine config not received yet. The Android app must complete pairing before chat is available.');
  }

  const googleAccessToken = await ensureAppAccessToken();
  const history = Array.isArray(thread?.messages)
    ? thread.messages.slice(-30).filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'function')
    : [];
  const rawContents = history.map((message) => chatContentFromMessage(message));
  const contents = sanitizeContentsForGemini(rawContents);

  const declarations = getAllToolDeclarations();
  const toolsPayload = declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;

  const appStatus = getAppAuthStatus();
  const workspaceStatus = getGoogleAuthStatus();
  const connectorsList = connectors ? connectors.map(c => `• [${c.id}] ${c.label} (Status: ${c.status})`).join('\n') : 'None';

  // Load the top 30 most recent memory records to inject directly into context so the agent has direct recall!
  const recentMemories = Array.isArray(memory) && memory.length > 0
    ? memory.slice(-30).map(m => `• [${m.kind}] ${m.key}: ${m.value}`).join('\n')
    : 'None';

  const statusPrompt = `\n\n[System Environment Status]
- Current Local Time: ${new Date().toString()}
- Current Date: ${new Date().toISOString().split('T')[0]}
- Google App Login: ${appStatus.connected ? `Logged In as ${appStatus.email}` : 'Not Logged In'}
- Google Workspace Integration: ${workspaceStatus.connected ? `Connected as ${workspaceStatus.email}` : 'Not Connected'}
- Active Engine Connectors:\n${connectorsList}

[Remembered Learnings, User Choices & Facts]
${recentMemories}`;

  const { json } = await fetchGeminiWithRetry(`${apiBaseUrl}/api/gemini/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: engineConfig.geminiModel,
      systemInstruction: `${CHAT_SYSTEM_PROMPT}${statusPrompt}`,
      contents,
      tools: toolsPayload,
      googleAccessToken,
    }),
  });

  const text = normalizeText(json.text || '');
  const functionCalls = json.functionCalls || [];

  if (!text && functionCalls.length === 0) {
    let reason = '';
    if (json.promptFeedback && json.promptFeedback.blockReason) {
      reason = ` [Blocked: ${json.promptFeedback.blockReason}]`;
    } else if (json.candidates && json.candidates[0] && json.candidates[0].finishReason && json.candidates[0].finishReason !== 'STOP') {
      reason = ` [Finish Reason: ${json.candidates[0].finishReason}]`;
    }
    appendLog(`Warning: Gemini returned empty content.${reason} Raw response: ${JSON.stringify(json)}`);
    return {
      text: `idanAI returned an empty reply.${reason}`,
      functionCalls: [],
      raw: json,
    };
  }

  return {
    text,
    functionCalls,
    raw: json,
  };
}

async function generateScraperGeminiReply(systemInstruction, promptText) {
  const apiBaseUrl = getBackendApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error('Engine config not received yet. The Android app must complete pairing before chat is available.');
  }

  const googleAccessToken = await ensureAppAccessToken();
  const contents = [
    {
      role: 'user',
      parts: [{ text: promptText }]
    }
  ];

  const { json } = await fetchGeminiWithRetry(`${apiBaseUrl}/api/gemini/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: engineConfig.geminiModel || 'gemini-2.5-flash',
      systemInstruction,
      contents,
      googleAccessToken,
    }),
  });

  const text = normalizeText(json.text || '');
  return { text, raw: json };
}

function utf8ToBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function emailWatchRuleSummary(rule) {
  const mode = rule.mode || 'gmail_query';
  const time = rule.time || '08:00';
  const terms = Array.isArray(rule.matchTerms) && rule.matchTerms.length ? ` terms=${rule.matchTerms.join(',')}` : '';
  return `${rule.id}: ${rule.title || 'Email watch'} [${mode}] ${rule.enabled ? 'enabled' : 'disabled'} @ ${time}${terms}${rule.query ? ` query=${rule.query}` : ''}`;
}

function upsertEmailWatchRule(rule) {
  const normalized = {
    id: normalizeText(rule.id || rule.ruleId || '') || `gmail_watch_${Date.now()}`,
    title: normalizeText(rule.title || 'Email watch') || 'Email watch',
    query: normalizeText(rule.query || ''),
    matchTerms: Array.isArray(rule.matchTerms)
      ? rule.matchTerms.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    time: normalizeText(rule.time || '08:00') || '08:00',
    enabled: rule.enabled !== false,
    mode: normalizeText(rule.mode || 'gmail_query'),
  };
  const index = emailWatchRules.findIndex((item) => item.id === normalized.id);
  if (index >= 0) emailWatchRules[index] = normalized;
  else emailWatchRules.push(normalized);
  emailWatchRules = emailWatchRules.slice(-200);
  saveAll();
  return normalized;
}

function listEmailWatchRules() {
  return emailWatchRules;
}

function cancelEmailWatchRule(ruleId) {
  const before = emailWatchRules.length;
  emailWatchRules = emailWatchRules.filter((rule) => rule.id !== ruleId);
  const removed = before - emailWatchRules.length;
  if (removed > 0) saveAll();
  return removed > 0;
}

async function checkEmailWatchRuleNow(ruleId) {
  const rule = emailWatchRules.find((item) => item.id === ruleId);
  if (!rule) return { notified: false, matchedCount: 0, message: 'No matching email watch rule found.' };

  if (!rule.enabled) {
    return { notified: false, matchedCount: 0, message: `Email watch "${rule.title}" is disabled.` };
  }

  const gmail = await gmailListMessages({
    query: rule.query || rule.matchTerms.join(' '),
    limit: 5,
  });
  const matchedCount = gmail.messages.length;
  const message = matchedCount > 0
    ? `Checked Gmail for "${rule.title}" and found ${matchedCount} matching message${matchedCount === 1 ? '' : 's'}.`
    : `Checked Gmail for "${rule.title}" and found no matches.`;
  return { notified: matchedCount > 0, matchedCount, message, messages: gmail.messages };
}

async function gmailListMessages({ query = '', limit = 10 } = {}) {
  const params = new URLSearchParams({ maxResults: String(Math.max(1, Math.min(20, Number(limit) || 10))) });
  if (normalizeText(query)) params.set('q', normalizeText(query));
  const list = await googleApiFetch('https://gmail.googleapis.com/gmail/v1/users/me', `/messages?${params.toString()}`);
  const messages = await Promise.all((list.messages || []).slice(0, Number(params.get('maxResults') || 10)).map(async (item) => {
    const details = await gmailGetMessage(item.id, 'metadata');
    return details;
  }));
  return { list, messages };
}

async function gmailGetMessage(messageId, format = 'metadata') {
  const params = new URLSearchParams({ format });
  if (format === 'metadata') {
    params.append('metadataHeaders', 'From');
    params.append('metadataHeaders', 'Subject');
    params.append('metadataHeaders', 'Date');
  }
  return googleApiFetch('https://gmail.googleapis.com/gmail/v1/users/me', `/messages/${encodeURIComponent(messageId)}?${params.toString()}`);
}

async function gmailSendMessage(args = {}) {
  return googleApiFetch('https://gmail.googleapis.com/gmail/v1/users/me', '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: buildRawEmail(args) }),
  });
}

async function gmailCreateDraft(args = {}) {
  return googleApiFetch('https://gmail.googleapis.com/gmail/v1/users/me', '/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw: buildRawEmail(args) } }),
  });
}

function gmailHeader(headers = [], name) {
  return headers.find((entry) => String(entry.name || '').toLowerCase() === String(name || '').toLowerCase())?.value || '';
}

function gmailPlainTextBody(message) {
  const walk = (part) => {
    if (!part) return '';
    if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
    for (const child of part.parts || []) {
      const found = walk(child);
      if (found) return found;
    }
    if (part.body?.data) return decodeBase64Url(part.body.data);
    return '';
  };
  return walk(message.payload || {}).trim();
}

function buildRawEmail(args = {}) {
  const to = normalizeText(args.to);
  const subject = normalizeText(args.subject);
  const body = normalizeText(args.body);
  const cc = normalizeText(args.cc);
  const bcc = normalizeText(args.bcc);
  if (!to || !subject || !body) {
    throw new Error('Email needs to, subject, and body.');
  }

  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    bcc ? `Bcc: ${bcc}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);

  return utf8ToBase64Url(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

function documentIdFrom(value) {
  const trimmed = normalizeText(value);
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || trimmed;
}

function spreadsheetIdFrom(value) {
  const trimmed = normalizeText(value);
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || trimmed;
}

function formIdFrom(value) {
  const trimmed = normalizeText(value);
  const match = trimmed.match(/\/forms\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || trimmed;
}

async function docsApi(pathSuffix, options = {}) {
  return googleApiFetch('https://docs.googleapis.com/v1/documents', pathSuffix, options);
}

async function sheetsApi(pathSuffix, options = {}) {
  return googleApiFetch('https://sheets.googleapis.com/v4/spreadsheets', pathSuffix, options);
}

async function formsApi(pathSuffix, options = {}) {
  return googleApiFetch('https://forms.googleapis.com/v1/forms', pathSuffix, options);
}

function extractGoogleDocText(doc) {
  const chunks = [];
  for (const item of doc.body?.content || []) {
    for (const element of item.paragraph?.elements || []) {
      const content = element.textRun?.content;
      if (content) chunks.push(content);
    }
  }
  return chunks.join('').trim();
}

function appendGoogleDocIndex(doc) {
  const endIndexes = (doc.body?.content || []).map((item) => item.endIndex || 0).filter((index) => index > 1);
  return Math.max(1, ...endIndexes) - 1;
}

async function createGoogleDoc(args = {}) {
  const title = normalizeText(args.title);
  const body = normalizeText(args.body);
  if (!title) throw new Error('Document title missing.');
  const doc = await docsApi('', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  if (body) {
    await docsApi(`/${encodeURIComponent(doc.documentId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          insertText: {
            location: { index: 1 },
            text: body,
          },
        }],
      }),
    });
  }
  return doc;
}

async function createGoogleSheet(args = {}) {
  const title = normalizeText(args.title);
  const sheetTitle = normalizeText(args.sheetTitle || 'Sheet1') || 'Sheet1';
  if (!title) throw new Error('Spreadsheet title missing.');
  return sheetsApi('', {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: sheetTitle } }],
    }),
  });
}

function normalizeFormQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const question = item;
      const title = normalizeText(question.title);
      const type = normalizeText(question.type);
      if (!title) return null;
      if (!['short_answer', 'paragraph', 'multiple_choice', 'checkbox', 'dropdown', 'scale', 'date', 'time'].includes(type)) return null;
      return {
        title,
        type,
        required: Boolean(question.required),
        helpText: normalizeText(question.helpText || ''),
        options: Array.isArray(question.options) ? question.options.map((option) => normalizeText(option)).filter(Boolean) : [],
        shuffle: Boolean(question.shuffle),
        scaleLow: Number.isFinite(Number(question.scaleLow)) ? Number(question.scaleLow) : undefined,
        scaleHigh: Number.isFinite(Number(question.scaleHigh)) ? Number(question.scaleHigh) : undefined,
        lowLabel: normalizeText(question.lowLabel || ''),
        highLabel: normalizeText(question.highLabel || ''),
        includeTime: question.includeTime == null ? undefined : Boolean(question.includeTime),
        includeYear: question.includeYear == null ? undefined : Boolean(question.includeYear),
      };
    })
    .filter(Boolean);
}

function buildFormQuestionRequest(question, index) {
  const item = {
    title: question.title,
    questionItem: {
      question: {
        required: Boolean(question.required),
        ...(question.helpText ? { helpText: question.helpText } : {}),
      },
    },
  };

  switch (question.type) {
    case 'short_answer':
      item.questionItem.question.textQuestion = { paragraph: false };
      break;
    case 'paragraph':
      item.questionItem.question.textQuestion = { paragraph: true };
      break;
    case 'multiple_choice':
    case 'checkbox':
    case 'dropdown': {
      const options = (question.options || []).filter(Boolean).map((option) => ({ value: option }));
      if (options.length === 0) throw new Error(`Question "${question.title}" needs at least one option.`);
      item.questionItem.question.choiceQuestion = {
        type: question.type === 'multiple_choice' ? 'RADIO' : question.type === 'checkbox' ? 'CHECKBOX' : 'DROP_DOWN',
        options,
        shuffle: Boolean(question.shuffle),
      };
      break;
    }
    case 'scale': {
      const low = Number.isFinite(question.scaleLow) ? Number(question.scaleLow) : 1;
      const high = Number.isFinite(question.scaleHigh) ? Number(question.scaleHigh) : 5;
      if (high <= low) throw new Error(`Question "${question.title}" needs scaleHigh > scaleLow.`);
      item.questionItem.question.scaleQuestion = {
        low: Math.floor(low),
        high: Math.floor(high),
        ...(question.lowLabel ? { lowLabel: question.lowLabel } : {}),
        ...(question.highLabel ? { highLabel: question.highLabel } : {}),
      };
      break;
    }
    case 'date':
      item.questionItem.question.dateQuestion = {
        ...(question.includeTime != null ? { includeTime: Boolean(question.includeTime) } : {}),
        ...(question.includeYear != null ? { includeYear: Boolean(question.includeYear) } : {}),
      };
      break;
    case 'time':
      item.questionItem.question.timeQuestion = {};
      break;
    default:
      throw new Error(`Unsupported question type: ${question.type}`);
  }

  return {
    createItem: {
      item,
      location: { index: index + 1 },
    },
  };
}

async function createGoogleForm(args = {}) {
  const title = normalizeText(args.title);
  if (!title) throw new Error('Form title is required.');

  const form = await formsApi(`?${new URLSearchParams({ unpublished: String(Boolean(args.unpublished)) }).toString()}`, {
    method: 'POST',
    body: JSON.stringify({
      info: {
        title,
        ...(normalizeText(args.documentTitle) ? { documentTitle: normalizeText(args.documentTitle) } : {}),
      },
    }),
  });

  const questions = normalizeFormQuestions(args.questions);
  if (questions.length > 0) {
    const requests = questions.map((question, index) => buildFormQuestionRequest(question, index));
    await formsApi(`/${encodeURIComponent(form.formId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ includeFormInResponse: true, requests }),
    });
  }

  return form;
}

function describeConnectorType(type) {
  return CONNECTOR_LABELS[type] || type.replace(/[-_]+/g, ' ');
}

function buildProviderConnectorConfig(type, args = {}) {
  const authState = normalizeText(args.authState || 'pending');
  const syncState = normalizeText(args.syncState || 'pending');
  const capabilities = Array.isArray(args.capabilities) ? args.capabilities.map((item) => normalizeText(item)).filter(Boolean) : [];

  return {
    ...args,
    providerType: type,
    authState,
    syncState,
    capabilities,
  };
}

function removeConnector(id) {
  const before = connectors.length;
  connectors = connectors.filter((connector) => connector.id !== id);
  const removed = before - connectors.length;
  if (removed > 0) saveAll();
  return removed;
}

function listPlans() {
  return plans;
}

function parseLocalDateTime(value) {
  const normalized = String(value || '').trim();
  let resDate = null;

  // Handle relative offset strings like "+5m", "+10m", "+1h", "+30s", "in 5 minutes", "in 1 hour"
  const relativeMatch = normalized.match(/(?:\+|in\s+)?(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const date = new Date();
    if (unit.startsWith('s')) {
      date.setSeconds(date.getSeconds() + amount);
    } else if (unit.startsWith('m')) {
      date.setMinutes(date.getMinutes() + amount);
    } else if (unit.startsWith('h')) {
      date.setHours(date.getHours() + amount);
    } else if (unit.startsWith('d')) {
      date.setDate(date.getDate() + amount);
    }
    resDate = date;
  } else if (/^\d{10,13}$/.test(normalized)) {
    resDate = new Date(Number(normalized));
  } else {
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) {
      resDate = date;
    } else {
      const timeOnly = normalized.match(/^(\d{1,2}):(\d{2})$/);
      if (timeOnly) {
        const next = new Date();
        next.setHours(Number(timeOnly[1]), Number(timeOnly[2]), 0, 0);
        resDate = next;
      } else {
        const spaced = normalized.replace(' ', 'T');
        const d2 = new Date(spaced);
        if (!Number.isNaN(d2.getTime())) {
          resDate = d2;
        } else {
          resDate = new Date();
        }
      }
    }
  }

  // Auto-correct past dates (e.g. 12-hour AM/PM ambiguities or rollover to tomorrow)
  const now = Date.now();
  if (resDate && resDate.getTime() <= now) {
    if (!relativeMatch) {
      const plus12 = new Date(resDate.getTime() + 12 * 60 * 60 * 1000);
      if (plus12.getTime() > now) {
        resDate = plus12;
      } else {
        resDate = new Date(resDate.getTime() + 24 * 60 * 60 * 1000);
      }
    }
  }

  return resDate || new Date();
}

function createReminder(args) {
  const due = parseLocalDateTime(args.dueAt);
  const reminder = {
    id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: normalizeText(args.title),
    dueAt: due.getTime(),
    notes: args.notes ? normalizeText(args.notes) : undefined,
    recurrence: ['daily', 'weekly'].includes(args.recurrence) ? args.recurrence : 'once',
    createdAt: Date.now(),
  };
  reminders.push(reminder);
  reminders = reminders.slice(-200);
  saveAll();
  return reminder;
}

function listReminders(includePast = false) {
  const now = Date.now();
  return reminders
    .filter((reminder) => includePast || Number(reminder.dueAt) >= now)
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
}

function cancelReminder(args) {
  const id = normalizeText(args.id);
  const title = normalizeText(args.title).toLowerCase();
  const before = reminders.length;
  reminders = reminders.filter((reminder) => {
    if (id && reminder.id === id) return false;
    if (title && reminder.title.toLowerCase().includes(title)) return false;
    return true;
  });
  const removed = before - reminders.length;
  if (removed > 0) saveAll();
  return removed;
}

function buildDayPlan(args) {
  const priorities = Array.isArray(args.priorities) ? args.priorities.filter(Boolean).map(String) : [];
  const commitments = Array.isArray(args.commitments) ? args.commitments.filter(Boolean).map(String) : [];
  const memorySummary = String(args.memorySummary || '').trim();
  const window = String(args.availableHours || '09:00-21:00');
  const energy = String(args.energy || 'normal');

  const focusBlock = energy === 'low' ? 'one gentle focus block' : energy === 'high' ? 'two deep focus blocks' : 'one deep focus block';
  const topPriorities = priorities.length > 0 ? priorities.slice(0, 4) : ['choose the top 3 outcomes for today'];

  const lines = [
    `Day plan for ${args.date || 'today'}`,
    `Window: ${window}. Pace: ${energy}.`,
    '',
    `1. Start: review commitments, pick ${topPriorities.length} priority item${topPriorities.length === 1 ? '' : 's'}, and clear quick blockers.`,
    `2. Focus: protect ${focusBlock} for ${topPriorities[0]}.`,
    `3. Admin: batch messages, calls, errands, and small follow-ups into one shorter block.`,
    `4. Reset: leave a buffer before evening so the plan can survive real life.`,
    `5. Close: write tomorrow's first action before stopping.`,
  ];

  if (topPriorities.length > 0) {
    lines.push('', 'Priorities:', ...topPriorities.map((item, index) => `${index + 1}. ${item}`));
  }

  if (commitments.length > 0) {
    lines.push('', 'Fixed commitments:', ...commitments.map((item) => `- ${item}`));
  }

  if (memorySummary) {
    lines.push('', `Memory used: ${memorySummary}`);
  }

  return lines.join('\n');
}

async function setAlarm(args) {
  const label = normalizeText(args.label || 'Idan Alarm') || 'Idan Alarm';
  const timeStr = normalizeText(args.time || '');
  let hour = 8;
  let minutes = 0;

  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
  } else {
    const d = new Date(timeStr);
    if (!isNaN(d.getTime())) {
      hour = d.getHours();
      minutes = d.getMinutes();
    }
  }

  const cmd = `am start --user 0 -a android.intent.action.SET_ALARM --ei android.intent.extra.alarm.HOUR ${hour} --ei android.intent.extra.alarm.MINUTES ${minutes} --es android.intent.extra.alarm.MESSAGE "${label.replace(/"/g, '\\"')}" --ez android.intent.extra.alarm.SKIP_UI true`;

  let success = false;
  let errorMsg = '';
  try {
    const stdout = await executeShell(cmd);
    if (stdout.includes('Error') || stdout.includes('Exception') || stdout.includes('SecurityException') || stdout.includes('Permission Denial')) {
      errorMsg = stdout.trim();
    } else {
      success = true;
    }
  } catch (err) {
    errorMsg = err.message;
  }

  if (!success) {
    try {
      const fallbackCmd = `am start -a android.intent.action.SET_ALARM --ei android.intent.extra.alarm.HOUR ${hour} --ei android.intent.extra.alarm.MINUTES ${minutes} --es android.intent.extra.alarm.MESSAGE "${label.replace(/"/g, '\\"')}" --ez android.intent.extra.alarm.SKIP_UI true`;
      const stdout = await executeShell(fallbackCmd);
      if (!stdout.includes('Error') && !stdout.includes('Exception') && !stdout.includes('SecurityException')) {
        success = true;
      } else {
        errorMsg = stdout.trim();
      }
    } catch (err) {
      errorMsg = err.message;
    }
  }

  if (!success) {
    appendLog(`am start SET_ALARM failed: ${errorMsg}. Falling back to engine-scheduled reminder alarm.`);
    const now = new Date();
    const due = new Date();
    due.setHours(hour, minutes, 0, 0);
    if (due.getTime() <= now.getTime()) {
      due.setDate(due.getDate() + 1);
    }

    const reminder = {
      id: `rem_alarm_${Date.now()}`,
      title: `Alarm: ${label}`,
      dueAt: due.getTime(),
      notes: 'Scheduled via alarm fallback.',
      recurrence: 'once',
      createdAt: Date.now(),
    };
    reminders.push(reminder);
    saveAll();

    return {
      success: true,
      label,
      hour,
      minutes,
      message: `Native alarm failed (${errorMsg.slice(0, 60)}). Scheduled background engine alarm instead for ${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}.`
    };
  }

  return {
    success: true,
    label,
    hour,
    minutes,
    message: `Alarm set successfully for ${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}: "${label}".`
  };
}

let activeRingingAlarms = new Set();
let alarmIntervalId = null;

function startAlarmLoop(alarmId, label) {
  activeRingingAlarms.add(`${label} (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`);
  appendLog(`Alarm loop started for: ${label}`);

  if (alarmIntervalId) return;

  executeShell('termux-vibrate -d 2000 -f').catch(() => { });
  executeShell(`termux-tts-speak "Alarm: ${label.replace(/"/g, '\\"')}"`).catch(() => { });

  alarmIntervalId = setInterval(() => {
    if (activeRingingAlarms.size === 0) {
      clearInterval(alarmIntervalId);
      alarmIntervalId = null;
      return;
    }
    executeShell('termux-vibrate -d 2000 -f').catch(() => { });
    const currentLabel = Array.from(activeRingingAlarms)[0] || 'Alarm';
    const cleanLabel = currentLabel.split(' (')[0];
    executeShell(`termux-tts-speak "Alarm: ${cleanLabel.replace(/"/g, '\\"')}. Please dismiss or snooze."`).catch(() => { });
  }, 4000);
}

function dismissAlarm() {
  activeRingingAlarms.clear();
  if (alarmIntervalId) {
    clearInterval(alarmIntervalId);
    alarmIntervalId = null;
  }
  return { success: true, message: 'All active alarms dismissed.' };
}

let autoReplyInstruction = null;

async function listNotifications(args) {
  try {
    const raw = await executeShell('termux-notification-list');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { notifications: [] };
    const limit = Number(args.limit) || 10;
    const pkg = args.packageName ? String(args.packageName).toLowerCase() : '';
    const filtered = parsed
      .filter((n) => !pkg || String(n.packageName || '').toLowerCase().includes(pkg))
      .slice(0, limit)
      .map((n) => ({
        id: String(n.id || n.key || ''),
        packageName: n.packageName || '',
        title: n.title || '',
        content: n.content || '',
      }));
    return { notifications: filtered };
  } catch (e) {
    appendLog(`listNotifications failed: ${e.message}`);
    return { notifications: [], error: e.message };
  }
}

async function openNotificationSettings() {
  await executeShell('am start --user 0 -a android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS').catch(() => { });
  return { message: 'Opened Android Notification Listener settings page.' };
}

async function openNotification(args) {
  const pkg = args.packageName || 'com.whatsapp';
  await executeShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`).catch(() => { });
  return { message: `Opened app ${pkg} to view notification.` };
}

function configureNotificationAutoReply(args) {
  autoReplyInstruction = args.instructions || null;
  return { message: `Auto reply configured: "${autoReplyInstruction}".` };
}

function showNotificationAutoReply() {
  return { enabled: !!autoReplyInstruction, instructions: autoReplyInstruction };
}

function clearNotificationAutoReply() {
  autoReplyInstruction = null;
  return { message: 'Auto reply disabled.' };
}

function scheduleRecurringTask(args) {
  const task = {
    id: `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description: normalizeText(args.description),
    intervalMs: Math.max(60000, Number(args.intervalMs) || 60000),
    jsScript: normalizeText(args.jsScript),
    shellCommand: normalizeText(args.shellCommand),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    active: true,
  };
  recurringTasks.push(task);
  recurringTasks = recurringTasks.slice(-100);
  saveAll();
  return task;
}

function cancelRecurringTask(taskId) {
  const before = recurringTasks.length;
  recurringTasks = recurringTasks.filter((task) => task.id !== taskId);
  const removed = before - recurringTasks.length;
  const timer = recurringTimers.get(taskId);
  if (timer) {
    clearInterval(timer);
    recurringTimers.delete(taskId);
  }
  if (removed > 0) saveAll();
  return removed;
}

function ensureRecurringTimers() {
  for (const task of recurringTasks) {
    if (recurringTimers.has(task.id)) continue;
    const timer = setInterval(() => {
      appendLog(`recurring task tick ${task.id}`);
      if (task.shellCommand) {
        executeShell(task.shellCommand).catch((error) => {
          appendLog(`recurring task ${task.id} shell failed: ${error.message}`);
        });
      }
      if (task.jsScript) {
        safeEval(task.jsScript, buildBridgeContext()).catch((error) => {
          appendLog(`recurring task ${task.id} jsScript failed: ${error.message}`);
        });
      }
    }, task.intervalMs);
    recurringTimers.set(task.id, timer);
  }
}

function checkDueReminders() {
  const now = Date.now();
  let changed = false;

  for (const reminder of reminders) {
    if (Number(reminder.dueAt) <= now && !reminder.triggered) {
      appendLog(`reminder triggering: ${reminder.title}`);

      // Send Android notification via Termux API
      const notificationTitle = `Reminder: ${reminder.title}`;
      const notificationText = reminder.notes || 'Time to get it done!';

      executeShell(`termux-notification -t "${notificationTitle.replace(/"/g, '\\"')}" -c "${notificationText.replace(/"/g, '\\"')}" --sound`)
        .catch((err) => {
          appendLog(`termux-notification failed: ${err.message}`);
        });

      startAlarmLoop(reminder.id, reminder.title);

      if (reminder.recurrence === 'daily') {
        reminder.dueAt = Number(reminder.dueAt) + 24 * 60 * 60 * 1000;
        changed = true;
      } else if (reminder.recurrence === 'weekly') {
        reminder.dueAt = Number(reminder.dueAt) + 7 * 24 * 60 * 60 * 1000;
        changed = true;
      } else {
        reminder.triggered = true;
        changed = true;
      }
    }
  }

  if (changed) {
    reminders = reminders.filter((r) => !r.triggered);
    saveAll();
  }
}

function startRemindersScheduler() {
  setInterval(checkDueReminders, 15000);
}

const adbState = {
  connected: false,
  port: null,
  error: null,
};

const net = require('net');

function scanPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(250);
    socket.on('connect', () => {
      socket.destroy();
      resolve(port);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(null);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function testAdbPort(port) {
  return new Promise((resolve) => {
    execFile('adb', ['connect', `127.0.0.1:${port}`], { timeout: 2000 }, (err, stdout, stderr) => {
      execFile('adb', ['devices'], { timeout: 1500 }, (devErr, devStdout) => {
        const out = devStdout || '';
        const deviceRegex = new RegExp(`127\\.0\\.0\\.1:${port}\\s+(device|unauthorized)`, 'i');
        if (deviceRegex.test(out)) {
          resolve(true);
        } else {
          // Clean up the dead port from ADB's cached list
          execFile('adb', ['disconnect', `127.0.0.1:${port}`], () => {
            resolve(false);
          });
        }
      });
    });
  });
}

function findPortInMdns() {
  return new Promise((resolve) => {
    execFile('adb', ['mdns', 'services'], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = stdout + (stderr || '');
      const matches = out.match(/(?:127\.0\.0\.1|localhost|tls-connect\._tcp\..*?):(\d{4,5})/gi);
      if (matches) {
        for (const match of matches) {
          const portStr = match.split(':').pop();
          const port = parseInt(portStr, 10);
          if (port >= 30000 && port <= 45000) {
            return resolve(port);
          }
        }
      }
      resolve(null);
    });
  });
}

async function discoverAdbPort() {
  const mdnsPort = await findPortInMdns();
  if (mdnsPort) {
    const ok = await testAdbPort(mdnsPort);
    if (ok) return mdnsPort;
  }

  const start = 30000;
  const end = 65535;
  const batchSize = 150;
  
  for (let i = start; i <= end; i += batchSize) {
    const promises = [];
    for (let p = i; p < i + batchSize && p <= end; p++) {
      promises.push(scanPort(p));
    }
    const results = await Promise.all(promises);
    for (const port of results) {
      if (port !== null) {
        const ok = await testAdbPort(port);
        if (ok) return port;
      }
    }
  }

  return null;
}

async function connectAdb() {
  try {
    const port = await discoverAdbPort();
    if (!port) {
      adbState.connected = false;
      adbState.port = null;
      adbState.error = 'No active local wireless debugging port found.';
      return;
    }

    adbState.port = port;
    execFile('adb', ['connect', `127.0.0.1:${port}`], { timeout: 4000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      if (out.includes('connected to') || out.includes('already connected')) {
        execFile('adb', ['devices'], { timeout: 2000 }, (devErr, devStdout) => {
          const devOut = devStdout || '';
          const deviceRegex = new RegExp(`127\\.0\\.0\\.1:${port}\\s+device`, 'i');
          const unauthorizedRegex = new RegExp(`127\\.0\\.0\\.1:${port}\\s+unauthorized`, 'i');
          const offlineRegex = new RegExp(`127\\.0\\.0\\.1:${port}\\s+offline`, 'i');

          if (deviceRegex.test(devOut)) {
            adbState.connected = true;
            adbState.error = null;
          } else if (unauthorizedRegex.test(devOut)) {
            adbState.connected = false;
            adbState.error = 'Device unauthorized. Please accept the prompt on your screen.';
          } else if (offlineRegex.test(devOut)) {
            adbState.connected = false;
            adbState.error = 'Device offline. Check Wireless Debugging status.';
          } else {
            adbState.connected = false;
            adbState.error = 'Device not fully authorized or connected.';
          }
        });
      } else {
        adbState.connected = false;
        adbState.error = out.trim() || 'Authentication failed or unauthorized.';
      }
    });
  } catch (error) {
    adbState.connected = false;
    adbState.error = error.message;
  }
}

function checkAdbStatus() {
  if (!adbState.port) {
    return connectAdb();
  }
  execFile('adb', ['devices'], { timeout: 2000 }, (err, stdout, stderr) => {
    const out = stdout || '';
    const deviceRegex = new RegExp(`127\\.0\\.0\\.1:${adbState.port}\\s+device`, 'i');
    if (deviceRegex.test(out)) {
      adbState.connected = true;
      adbState.error = null;
    } else {
      adbState.connected = false;
      const unauthorizedRegex = new RegExp(`127\\.0\\.0\\.1:${adbState.port}\\s+unauthorized`, 'i');
      const offlineRegex = new RegExp(`127\\.0\\.0\\.1:${adbState.port}\\s+offline`, 'i');
      if (unauthorizedRegex.test(out)) {
        adbState.error = 'Device unauthorized. Please accept the prompt on your screen.';
      } else if (offlineRegex.test(out)) {
        adbState.error = 'Device offline. Check Wireless Debugging status.';
      } else {
        adbState.error = 'ADB disconnected.';
      }
      connectAdb();
    }
  });
}

function startAdbManager() {
  // Run initial check
  checkAdbStatus();
  // Check every 30 seconds
  setInterval(checkAdbStatus, 30000);
}


async function executeShell(command) {
  let cmd = 'sh';
  // Do NOT use -l (login shell) — it breaks PATH and profile sourcing on Termux
  let args = ['-c', command];

  const ADB_REQUIRED_CMDS = ['dumpsys', 'getprop', 'am', 'pm', 'cmd', 'svc', 'settings', 'input', 'monkey'];
  const firstWord = command.trim().split(/\s+/)[0];

  if (process.platform === 'win32') {
    const win32AdbCmds = [...ADB_REQUIRED_CMDS, 'termux-flashlight', 'termux-wifi-enable', 'termux-volume'];
    if (win32AdbCmds.includes(firstWord)) {
      cmd = 'adb';
      args = ['shell', command];
    } else {
      cmd = 'cmd.exe';
      args = ['/c', command];
    }
  } else {
    // Linux/Termux: route privileged commands to adb shell
    if (ADB_REQUIRED_CMDS.includes(firstWord)) {
      cmd = 'adb';
      args = ['shell', command];
    }
  }

  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: DATA_DIR,
      maxBuffer: 1024 * 1024 * 8,
    });
    return String(stdout || '');
  } catch (error) {
    appendLog(`shell command failed: ${command} — ${error.message}`);
    throw error;
  }
}

async function visitWebsite(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
  });
  const text = await response.text();
  return text;
}

function isBotProtectionBlock(pageText) {
  const lower = pageText.toLowerCase();

  // Generic captcha/verification phrases
  const genericPhrases = [
    'verify you are human',
    'verify that you are human',
    'please verify you are a human',
    'are you a human',
    'prove you are human',
    'i am not a robot',
    'i\'m not a robot',
    'checking your browser',
    'please wait while we verify',
    'enable javascript and cookies to continue',
    'please enable cookies',
    'browser check',
    'security check',
    'access denied',
    'too many requests',
    'rate limited',
    'unusual traffic',
    'suspicious activity',
    'automated access',
    'bot detected',
  ];
  if (genericPhrases.some((p) => lower.includes(p))) return true;

  // Cloudflare
  if (
    lower.includes('cloudflare') &&
    (lower.includes('just a moment') ||
      lower.includes('ray id:') ||
      lower.includes('cf-ray') ||
      lower.includes('_cf_chl') ||
      lower.includes('challenge-platform') ||
      lower.includes('cf_clearance'))
  ) return true;

  // Google reCAPTCHA
  if (lower.includes('recaptcha') || lower.includes('g-recaptcha') || lower.includes('google.com/recaptcha')) return true;

  // hCaptcha
  if (lower.includes('hcaptcha') || lower.includes('hcaptcha.com')) return true;

  // Akamai / Bot Manager
  if (lower.includes('akamai') && (lower.includes('bot manager') || lower.includes('web application firewall'))) return true;

  // DataDome
  if (lower.includes('datadome') || lower.includes('datadome.co')) return true;

  // Imperva / Incapsula
  if (
    (lower.includes('imperva') || lower.includes('incapsula')) &&
    (lower.includes('access denied') || lower.includes('incident id'))
  ) return true;

  // Kasada
  if (lower.includes('kasada') || lower.includes('kasada.io')) return true;

  // PerimeterX
  if (lower.includes('perimeterx') || lower.includes('px-captcha')) return true;

  // Generic CAPTCHA presence (last resort)
  if ((lower.includes('captcha') && (lower.includes('solve') || lower.includes('complete') || lower.includes('challenge')))) return true;

  return false;
}

function summarizeText(text) {
  return normalizeText(text).replace(/\s+/g, ' ').slice(0, 1200);
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanPageText(html) {
  return decodeHtmlEntities(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const blocks = String(html).split(/<tr|<div[^>]*class="[^"]*result[^"]*"/gi);
  for (const block of blocks) {
    const linkMatch =
      block.match(/class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1].includes('uddg=')
      ? decodeURIComponent(linkMatch[1].split('uddg=')[1].split('&')[0])
      : linkMatch[1];
    const title = linkMatch[2].replace(/<[^>]*>/g, '').trim();
    if (!title || title.toLowerCase().includes('sign in')) continue;
    results.push({
      title,
      url: url.startsWith('//') ? `https:${url}` : url,
    });
    if (results.length >= 6) break;
  }
  return results;
}

async function handleSearch(query) {
  const q = normalizeText(query);
  if (!q) return 'Missing query';

  const variants = [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    `https://www.google.com/search?q=${encodeURIComponent(q)}&gbv=1`,
  ];

  let html = '';
  for (const url of variants) {
    try {
      html = await visitWebsite(url);
      if (html) break;
    } catch {
      // try next engine
    }
  }

  if (!html) return `Search failed for "${q}".`;

  const results = parseDuckDuckGoResults(html);
  if (results.length === 0) {
    const cleanText = cleanPageText(html);
    return cleanText ? `Search results for "${q}":\n\n${cleanText.slice(0, 1800)}` : `No clear search results for "${q}".`;
  }

  return `Search results for "${q}":\n\n${results
    .map((result, index) => `${index + 1}. ${result.title}\n${result.url}`)
    .join('\n\n')}`;
}

async function handleWhatsApp(args) {
  const phoneNumber = normalizeText(args.phoneNumber);
  const contactName = normalizeText(args.contactName);
  const message = normalizeText(args.message);
  
  if (getWhatsAppStatus().status === 'connected' && phoneNumber) {
    try {
      appendLog(`[WhatsApp Skill] Routing message programmatically via Baileys to ${phoneNumber}`);
      await sendWhatsAppMessageDirect(phoneNumber, message);
      return {
        ok: true,
        message: `WhatsApp message sent programmatically via background Baileys to ${phoneNumber}.`,
      };
    } catch (err) {
      appendLog(`[WhatsApp Skill] Background send failed: ${err.message}. Falling back to wa.me link.`);
    }
  }

  const query = phoneNumber || contactName;
  return {
    action: 'open-url',
    url: phoneNumber
      ? `https://wa.me/${phoneNumber.replace(/\D/g, '')}${message ? `?text=${encodeURIComponent(message)}` : ''}`
      : `https://wa.me/?text=${encodeURIComponent(message || query || '')}`,
    note: phoneNumber || contactName ? 'Use the generated link in the Android app or browser.' : 'No target provided.',
  };
}

function handleYouTube(args) {
  const query = normalizeText(args.query || args.url || '');
  return {
    action: 'open-url',
    url: query.startsWith('http') ? query : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  };
}

function createConnectorMessage(type, args) {
  const label = normalizeText(args.label || describeConnectorType(type));
  const connector = upsertConnector(type, {
    ...args,
    label,
    status: normalizeText(args.status || 'configured'),
    config: buildProviderConnectorConfig(type, args),
  });
  return {
    connector,
    message: `${label} connector profile saved locally. Provider auth and sync still need wiring.`,
  };
}

function connectorJob(type, args) {
  const job = createJob(type, args);
  return {
    job,
    message: `${describeConnectorType(type)} request queued.`,
  };
}

function syncProviderConnectors(type, args = {}) {
  const now = Date.now();
  const matched = listConnectors(type).map((connector) =>
    touchConnector(connector.id, {
      status: normalizeText(args.status || 'synced'),
      lastSyncAt: now,
      config: {
        ...connector.config,
        lastSyncAt: now,
        syncNote: normalizeText(args.note || ''),
      },
    })
  );

  return {
    synced: matched.filter(Boolean).length,
    connectors: matched.filter(Boolean),
  };
}

function parseBatteryOutput(output) {
  const level = output.match(/level:\s*(\d+)/)?.[1] || 'unknown';
  const ac = output.includes('AC powered: true');
  const usb = output.includes('USB powered: true');
  const wireless = output.includes('Wireless powered: true');
  const charging = ac || usb || wireless;
  return { level: Number(level) || 0, charging, summary: `Battery: ${level}%${charging ? ' (charging)' : ''}` };
}

function compactLines(output, limit = 18) {
  return String(output || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, limit).join('\n');
}

function getBatteryStatus() {
  return executeShell('dumpsys battery')
    .then((raw) => { const b = parseBatteryOutput(raw); return `${b.summary}\n\n${compactLines(raw, 10)}`; })
    .catch((error) => `Battery query failed: ${error.message}`);
}

function healthCheck() {
  return Promise.all([
    executeShell('whoami').catch((error) => `whoami failed: ${error.message}`),
    executeShell('uptime').catch((error) => `uptime failed: ${error.message}`),
  ]).then(([whoami, uptime]) => ({
    whoami: summarizeText(whoami),
    uptime: summarizeText(uptime),
  }));
}

function safeEval(code, ctx) {
  const vm = require('vm');
  const sandbox = {
    ctx,
    console,
    JSON,
    Date,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  const script = new vm.Script(`(async () => { ${code}\n})()`);
  return script.runInContext(sandbox, { timeout: 5000 });
}

async function dumpAndroidUI() {
  try {
    await executeShell('uiautomator dump /data/local/tmp/uidump.xml 2>/dev/null || adb shell uiautomator dump /data/local/tmp/uidump.xml').catch(() => {});
    const res = await executeShell('cat /data/local/tmp/uidump.xml 2>/dev/null || adb shell cat /data/local/tmp/uidump.xml');
    if (res.ok && res.stdout) {
      return res.stdout;
    }
  } catch (err) {
    appendLog(`dumpAndroidUI failed: ${err.message}`);
  }
  return '';
}

function findElementInXml(xml, searchText) {
  const cleanSearch = searchText.toLowerCase().trim();
  const nodeRegex = /<node[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/g;
  let match;
  const candidates = [];
  
  while ((match = nodeRegex.exec(xml)) !== null) {
    const nodeString = match[0];
    const x1 = parseInt(match[1], 10);
    const y1 = parseInt(match[2], 10);
    const x2 = parseInt(match[3], 10);
    const y2 = parseInt(match[4], 10);
    
    const textMatch = nodeString.match(/text="([^"]*)"/);
    const descMatch = nodeString.match(/content-desc="([^"]*)"/);
    const idMatch = nodeString.match(/resource-id="([^"]*)"/);
    
    const text = textMatch ? textMatch[1] : '';
    const desc = descMatch ? descMatch[1] : '';
    const resId = idMatch ? idMatch[1] : '';
    
    if (
      text.toLowerCase().includes(cleanSearch) || 
      desc.toLowerCase().includes(cleanSearch) || 
      resId.toLowerCase().includes(cleanSearch)
    ) {
      candidates.push({
        text,
        desc,
        resId,
        x: Math.floor((x1 + x2) / 2),
        y: Math.floor((y1 + y2) / 2),
        score: (text.toLowerCase() === cleanSearch || desc.toLowerCase() === cleanSearch) ? 2 : 1
      });
    }
  }
  
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

async function executeMacroStep(step) {
  const action = step.action || step.type;
  switch (action) {
    case 'open_app': {
      const pkg = step.packageName || step.package;
      if (!pkg) throw new Error('open_app: packageName missing');
      await executeShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`);
      break;
    }
    case 'tap_text': {
      const text = step.text;
      if (!text) throw new Error('tap_text: text missing');
      const xml = await dumpAndroidUI();
      const el = findElementInXml(xml, text);
      if (!el) throw new Error(`tap_text: element "${text}" not found on screen`);
      await executeShell(`input tap ${el.x} ${el.y}`);
      break;
    }
    case 'tap_xy': {
      const x = step.x;
      const y = step.y;
      if (x == null || y == null) throw new Error('tap_xy: x or y missing');
      await executeShell(`input tap ${x} ${y}`);
      break;
    }
    case 'type_text': {
      const text = step.text;
      if (!text) throw new Error('type_text: text missing');
      await executeShell(`input text "${text.replace(/"/g, '\\"')}"`);
      break;
    }
    case 'press_key': {
      const key = step.key || step.code;
      if (!key) throw new Error('press_key: key missing');
      await executeShell(`input keyevent ${key}`);
      break;
    }
    case 'wait': {
      const duration = Number(step.duration || step.durationMs || 1000);
      await new Promise(resolve => setTimeout(resolve, duration));
      break;
    }
    default:
      throw new Error(`Unsupported macro step action: ${action}`);
  }
}

function buildBridgeContext() {
  return {
    executeShell,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    showToast: (msg) => {
      appendLog(`toast: ${msg}`);
      return msg;
    },
    remember: async (record) => rememberRecord(record),
    searchMemory: async (query, limit) => searchMemory(query, limit),
    forgetMemory: async (kind, key) => forgetMemoryByKey(kind, key),
    forgetMemoryWhere: async (query, kind) => forgetMemory(query, kind),
    getBatteryStatus,
    healthCheck,
    visitWebsite,
    searchWeb: handleSearch,
    dumpUI: dumpAndroidUI,
    findElement: async (text) => {
      const xml = await dumpAndroidUI();
      return findElementInXml(xml, text);
    },
    boundsToCenter: (boundsStr) => {
      const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!match) return null;
      const x1 = parseInt(match[1], 10);
      const y1 = parseInt(match[2], 10);
      const x2 = parseInt(match[3], 10);
      const y2 = parseInt(match[4], 10);
      return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
    },
    isAutonomyEnabled: () => true,
  };
}

async function processMessageThroughModel(threadId, messageText) {
  const thread = upsertChatThread(threadId, `WhatsApp Chat`);
  if (messageText) {
    appendChatMessage(threadId, 'user', messageText);
  }
  
  let replyText = '';
  let loopCount = 0;
  const maxLoops = 5;

  while (loopCount < maxLoops) {
    loopCount++;
    try {
      const result = await generateGeminiReply(thread);

      if (result.functionCalls && result.functionCalls.length > 0) {
        // Format functionCall model response
        const parts = result.functionCalls.map((call) => ({
          functionCall: {
            name: call.name,
            args: call.args || {},
          },
        }));
        appendChatMessage(threadId, 'assistant', '', parts);

        const responseParts = [];
        for (const call of result.functionCalls) {
          appendLog(`[WhatsApp Bot] executing tool: ${call.name} with args ${JSON.stringify(call.args)}`);
          let executionResult;
          try {
            executionResult = await handleCommand(call.name, call.args, null, { threadId });
          } catch (e) {
            appendLog(`[WhatsApp Bot] tool ${call.name} failed: ${e.message}`);
            executionResult = { ok: false, error: e.message };
          }

          responseParts.push({
            functionResponse: {
              name: call.name,
              response: executionResult,
            },
          });
        }
        appendChatMessage(threadId, 'function', '', responseParts);

        // Continue the loop to call Gemini again with the tool output
        continue;
      }

      replyText = result.text || 'idanAI returned an empty reply.';
      appendChatMessage(threadId, 'assistant', replyText);
      break;
    } catch (error) {
      appendLog(`[WhatsApp Bot] idanAI chat loop error: ${error.message}`);
      replyText = `idanAI chat failed: ${error.message}`;
      appendChatMessage(threadId, 'assistant', replyText);
      break;
    }
  }

  return replyText;
}

async function handleCommand(command, args, req, payload) {
  switch (command) {
    // Gmail aliases
    case 'list_gmail_messages':
      return handleCommand('gmail_list', args, req, payload);
    case 'read_gmail_message':
      return handleCommand('gmail_read', args, req, payload);
    case 'send_gmail_email':
      return handleCommand('gmail_send', args, req, payload);
    case 'create_gmail_draft':
    case 'gmail_draft':
    case 'gmail_create_draft':
      return {
        message: 'Gmail draft created.',
        draft: await gmailCreateDraft(args),
      };

    // YouTube aliases
    case 'youtube_search':
      return handleCommand('search_youtube', args, req, payload);

    // Basic Device aliases
    case 'get_device_status': {
      const [batteryRaw, storageRaw, networkRaw] = await Promise.all([
        executeShell('dumpsys battery').catch(() => ''),
        executeShell('df -h /data /sdcard 2>/dev/null || df -h').catch(() => ''),
        executeShell('cmd wifi status 2>/dev/null || dumpsys connectivity').catch(() => ''),
      ]);
      const battery = batteryRaw ? parseBatteryOutput(batteryRaw) : { summary: 'Battery unknown' };
      return {
        ok: true,
        battery: battery.summary,
        batteryLevel: battery.level,
        charging: battery.charging,
        storage: compactLines(storageRaw, 6) || 'Storage unknown',
        network: compactLines(networkRaw, 8) || 'Network unknown',
      };
    }
    case 'get_storage_status': {
      const raw = await executeShell('df -h /data /sdcard 2>/dev/null || df -h').catch(() => '');
      return { storage: compactLines(raw, 10) || 'Storage unknown' };
    }
    case 'get_network_status': {
      const raw = await executeShell('cmd wifi status 2>/dev/null || dumpsys connectivity').catch(() => '');
      return { network: compactLines(raw, 16) || 'Network unknown' };
    }
    case 'search_installed_apps': {
      const query = String(args.query || '').toLowerCase().trim();
      const limit = Math.min(30, Math.max(1, Number(args.limit || 12)));
      try {
        // pm list packages -f returns lines like: package:/path/to/apk=com.example.app
        const raw = await executeShell('pm list packages -f');
        const apps = raw.split('\n')
          .map((line) => {
            const match = line.match(/^package:(.+)=([^=]+)$/);
            if (!match) return null;
            const packageName = match[2].trim();
            return { name: packageName, package: packageName };
          })
          .filter((app) => app && (!query || app.package.toLowerCase().includes(query)))
          .slice(0, limit);
        return { apps };
      } catch (e) {
        appendLog(`search_installed_apps failed: ${e.message}`);
        return { apps: [] };
      }
    }
    case 'open_app_by_package': {
      const pkg = args.packageName;
      if (!pkg) return { ok: false, error: 'No package name provided' };
      appendLog(`[App] Opening app by package via shell: ${pkg}`);
      try {
        const res = await executeShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`);
        if (res.output && res.output.includes('monkey aborted')) {
          await executeShell(`am start -n $(cmd package resolve-activity --brief ${pkg} | tail -n 1) 2>/dev/null`);
        }
        return { ok: true, message: `Opened app ${pkg}` };
      } catch (err) {
        return { action: 'open-app', packageName: pkg };
      }
    }
    case 'open_app_by_name': {
      const query = String(args.query || '').toLowerCase().trim();
      if (!query) return { ok: false, error: 'No query provided' };
      appendLog(`[App] Opening app by name: ${query}`);
      try {
        const commonApps = {
          youtube: 'com.google.android.youtube',
          yt: 'com.google.android.youtube',
          whatsapp: 'com.whatsapp',
          wa: 'com.whatsapp',
          gmail: 'com.google.android.gm',
          mail: 'com.google.android.gm',
          chrome: 'com.android.chrome',
          browser: 'com.android.chrome',
          settings: 'com.android.settings',
          phone: 'com.google.android.dialer',
          dialer: 'com.google.android.dialer',
          messages: 'com.google.android.apps.messaging',
          sms: 'com.google.android.apps.messaging',
          maps: 'com.google.android.apps.maps',
          google: 'com.google.android.googlequicksearchbox',
          camera: 'com.google.android.apps.camera',
          photos: 'com.google.android.apps.photos',
          calendar: 'com.google.android.calendar',
          clock: 'com.google.android.deskclock',
          calculator: 'com.google.android.calculator',
          playstore: 'com.android.vending',
          play: 'com.android.vending',
          spotify: 'com.spotify.music',
          twitter: 'com.twitter.android',
          x: 'com.twitter.android',
          instagram: 'com.instagram.android',
          facebook: 'com.facebook.katana',
          telegram: 'org.telegram.messenger',
          slack: 'com.Slack',
          discord: 'com.discord',
          linkedin: 'com.linkedin.android',
          drive: 'com.google.android.apps.docs',
          docs: 'com.google.android.apps.docs',
          sheets: 'com.google.android.apps.docs.sheets',
          slides: 'com.google.android.apps.docs.slides',
          meet: 'com.google.android.apps.meetings',
          duolingo: 'com.duolingo',
          netflix: 'com.netflix.mediaclient'
        };
        let pkg = commonApps[query.replace(/[^a-z0-9]/g, '')];
        if (!pkg) {
          const raw = await executeShell('pm list packages -f');
          const apps = raw.split('\n')
            .map((line) => {
              const match = line.match(/^package:(.+)=([^=]+)$/);
              return match ? match[2].trim() : null;
            })
            .filter(p => Boolean(p));
          pkg = apps.find(p => p.toLowerCase().includes(query)) || null;
        }
        
        if (pkg) {
          const res = await executeShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`);
          if (res.output && res.output.includes('monkey aborted')) {
            await executeShell(`am start -n $(cmd package resolve-activity --brief ${pkg} | tail -n 1) 2>/dev/null`);
          }
          return { ok: true, message: `Opened app ${pkg}` };
        }
      } catch (err) {
        appendLog(`[App] Failed to open app by name: ${err.message}`);
      }
      return { action: 'open-app', query: args.query };
    }
    case 'open_app_info':
      // Try shell first, fall back to app-side action
      await executeShell(`am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d 'package:${String(args.packageName || '').replace(/'/g, '')}' 2>/dev/null`)
        .catch(() => { });
      return { action: 'open-app-info', packageName: args.packageName };
    case 'open_android_settings':
      return { action: 'open-settings', page: args.page };
    case 'wake_screen':
      await executeShell('input keyevent KEYCODE_WAKEUP 2>/dev/null || input keyevent 224').catch(() => { });
      return { action: 'wake-screen', ok: true };
    case 'share_text':
      return { action: 'share-text', text: args.text };

    // Basic Phone aliases
    case 'search_contacts': {
      const query = String(args.query || '').toLowerCase().trim();
      let contacts = [];
      try {
        // termux-contact-list returns a JSON array of {name, number}
        const raw = await executeShell('termux-contact-list');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          contacts = parsed
            .filter((c) => {
              if (!query) return true;
              const name = String(c.name || '').toLowerCase();
              const number = String(c.number || c.phone || '').toLowerCase();
              return name.includes(query) || number.includes(query);
            })
            .slice(0, 20)
            .map((c) => ({ name: c.name || '', phone: c.number || c.phone || '' }));
        }
      } catch (e) {
        appendLog(`search_contacts failed: ${e.message}`);
        // Fall back gracefully — model will get an empty list
      }
      return { contacts };
    }
    case 'check_contact_exists': {
      const query = String(args.query || '').toLowerCase().trim();
      let exists = false;
      let matchedNames = [];
      try {
        const raw = await executeShell('termux-contact-list');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && query) {
          const matches = parsed.filter((c) => String(c.name || '').toLowerCase().includes(query));
          exists = matches.length > 0;
          matchedNames = matches.slice(0, 5).map((c) => c.name);
        }
      } catch (e) {
        appendLog(`check_contact_exists failed: ${e.message}`);
      }
      return { exists, matchedNames };
    }
    case 'get_recent_missed_calls': {
      const limit = Math.min(25, Math.max(1, Number(args.limit || 10)));
      let calls = [];
      try {
        // termux-telephony-calllog returns JSON array of call log entries
        const raw = await executeShell('termux-telephony-calllog');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          calls = parsed
            .filter((c) => String(c.type || '').toUpperCase() === 'MISSED')
            .slice(0, limit)
            .map((c) => ({
              name: c.name || c.number || 'Unknown',
              phone: c.number || '',
              time: c.date ? new Date(Number(c.date)).toLocaleString() : 'Unknown time',
              isNew: true,
            }));
        }
      } catch (e) {
        appendLog(`get_recent_missed_calls failed: ${e.message}`);
      }
      return { calls };
    }
    case 'open_contact':
      return { action: 'open-contact', query: args.query };
    case 'open_dialer':
      return { action: 'open-dialer', phoneNumber: args.phoneNumber };
    case 'open_sms_composer':
      return { action: 'open-sms', phoneNumber: args.phoneNumber, body: args.body };

    // Native Settings aliases
    case 'toggle_flashlight':
      {
        const state = args.state || 'on';
        const isOn = state === 'on';
        const flashErrors = [];
        // 1. cmd torch (Android 10+ stock, most reliable)
        const r1 = await executeShell(`cmd torch ${isOn ? 'on' : 'off'}`)
          .catch((e) => { flashErrors.push(`cmd torch: ${e.message}`); return null; });
        // 2. termux-torch (Termux:API)
        if (r1 === null) {
          const r2 = await executeShell(`termux-torch ${state}`)
            .catch((e) => { flashErrors.push(`termux-torch: ${e.message}`); return null; });
          // 3. MIUI broadcast fallback
          if (r2 === null) {
            await executeShell(`am broadcast -a miui.intent.action.TOGGLE_TORCH --ez state ${isOn}`)
              .catch((e) => { flashErrors.push(`am broadcast: ${e.message}`); });
          }
        }
        if (flashErrors.length > 0) appendLog(`toggle_flashlight errors: ${flashErrors.join('; ')}`);
        return { action: 'toggle-flashlight', state, ok: flashErrors.length < 3 };
      }
    case 'set_volume':
      {
        const pct = Number(args.percent || args.level || 50);
        const level15 = Math.round((pct / 100) * 15);
        const volErrors = [];
        await executeShell(`termux-volume music ${level15}`)
          .catch((e) => { volErrors.push(`termux-volume: ${e.message}`); });
        await executeShell(`cmd audio volume set-volume 3 ${level15}`)
          .catch((e) => { volErrors.push(`cmd audio: ${e.message}`); });
        if (volErrors.length > 0) appendLog(`set_volume errors: ${volErrors.join('; ')}`);
        return { action: 'set-volume', stream: args.stream, level: args.level, percent: pct, ok: volErrors.length < 2 };
      }
    case 'set_wifi':
      {
        const enabled = Boolean(args.enabled);
        const wifiErrors = [];
        await executeShell(`termux-wifi-enable ${enabled}`)
          .catch((e) => { wifiErrors.push(`termux-wifi-enable: ${e.message}`); });
        await executeShell(`svc wifi ${enabled ? 'enable' : 'disable'}`)
          .catch((e) => { wifiErrors.push(`svc wifi: ${e.message}`); });
        if (wifiErrors.length > 0) appendLog(`set_wifi errors: ${wifiErrors.join('; ')}`);
        return { action: 'set-wifi', enabled, ok: wifiErrors.length < 2 };
      }
    case 'set_mobile_data':
      {
        const enabled = Boolean(args.enabled);
        const dataErr = await executeShell(`svc data ${enabled ? 'enable' : 'disable'}`)
          .then(() => null).catch((e) => e.message);
        if (dataErr) appendLog(`set_mobile_data error: ${dataErr}`);
        return { action: 'set-mobile-data', enabled, ok: !dataErr };
      }
    case 'set_dnd':
      {
        const enabled = Boolean(args.enabled);
        const dndErrors = [];
        // Primary: settings put (more reliable across Android versions)
        await executeShell(`settings put global zen_mode ${enabled ? '1' : '0'}`)
          .catch((e) => { dndErrors.push(`settings put: ${e.message}`); });
        // Fallback: cmd notification
        if (dndErrors.length > 0) {
          await executeShell(`cmd notification set_dnd_zen ${enabled ? 1 : 0}`)
            .catch((e) => { dndErrors.push(`cmd notification: ${e.message}`); });
        }
        if (dndErrors.length > 1) appendLog(`set_dnd errors: ${dndErrors.join('; ')}`);
        return { action: 'set-dnd', enabled, ok: dndErrors.length < 2 };
      }

    // Notifications aliases
    case 'configure_notification_auto_reply':
      return configureNotificationAutoReply(args);
    case 'show_notification_auto_reply':
      return showNotificationAutoReply();
    case 'clear_notification_auto_reply':
      return clearNotificationAutoReply();
    case 'list_notifications':
      return listNotifications(args);
    case 'open_notification':
    case 'reply_to_latest_notification':
      return openNotification(args);
    case 'open_notification_settings':
      return openNotificationSettings();

    // Phone Macro aliases
    case 'list_macro_actions':
      return {
        actions: ['open_app', 'tap_text', 'tap_xy', 'type_text', 'press_key', 'wait']
      };

    // Self-Improving App Navigator aliases
    case 'open_demo_recorder_settings':
      await executeShell('am start -a android.settings.ACCESSIBILITY_SETTINGS 2>/dev/null || adb shell am start -a android.settings.ACCESSIBILITY_SETTINGS').catch(() => {});
      return { ok: true, message: 'Opened Accessibility Settings' };
    case 'open_demo_overlay_settings':
      await executeShell('am start -a android.settings.action.MANAGE_OVERLAY_PERMISSION 2>/dev/null || adb shell am start -a android.settings.action.MANAGE_OVERLAY_PERMISSION').catch(() => {});
      return { ok: true, message: 'Opened Draw-Over-Apps Overlay Settings' };
    case 'show_demo_overlay':
    case 'hide_demo_overlay':
    case 'start_app_demonstration':
    case 'finish_app_demonstration':
      return { ok: true, message: `${command} is handled dynamically by local environment.` };
    case 'observe_current_screen': {
      const xml = await dumpAndroidUI();
      if (!xml) return { ok: false, error: 'Could not dump Android UI hierarchy. Ensure ADB is paired and awake.' };
      const nodeRegex = /<node[^>]*text="([^"]*)"[^>]*content-desc="([^"]*)"[^>]*resource-id="([^"]*)"[^>]*class="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/g;
      let match;
      const elements = [];
      while ((match = nodeRegex.exec(xml)) !== null) {
        const text = match[1];
        const desc = match[2];
        const resId = match[3];
        const cls = match[4].split('.').pop();
        const x1 = parseInt(match[5], 10);
        const y1 = parseInt(match[6], 10);
        const x2 = parseInt(match[7], 10);
        const y2 = parseInt(match[8], 10);
        if (text || desc) {
          elements.push({
            text: text || undefined,
            description: desc || undefined,
            resourceId: resId || undefined,
            type: cls,
            center: [Math.floor((x1 + x2) / 2), Math.floor((y1 + y2) / 2)],
            bounds: `[${x1},${y1}][${x2},${y2}]`
          });
        }
      }
      return { ok: true, elements: elements.slice(0, args.limit || 60) };
    }
    case 'capture_visible_text': {
      let fullText = '';
      const scrolls = Number(args.scrolls || 0);
      const pkg = args.packageName;
      const url = args.url;
      const waitMs = Number(args.waitMs || 1800);
      
      if (pkg) {
        await executeShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`).catch(() => {});
        if (url) {
          await executeShell(`am start -a android.intent.action.VIEW -d '${url}' 2>/dev/null`).catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      
      for (let i = 0; i <= scrolls; i++) {
        const xml = await dumpAndroidUI();
        if (xml) {
          const textMatches = xml.match(/text="([^"]*)"/g) || [];
          const descMatches = xml.match(/content-desc="([^"]*)"/g) || [];
          const textList = textMatches.map(m => m.slice(6, -1)).filter(Boolean);
          const descList = descMatches.map(m => m.slice(14, -1)).filter(Boolean);
          const pageText = [...new Set([...textList, ...descList])].join(' | ');
          fullText += `--- Screen ${i + 1} ---\n${pageText}\n\n`;
        }
        if (i < scrolls) {
          await executeShell('input swipe 500 1500 500 500 500').catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      
      if (args.rememberKey) {
        rememberRecord({ kind: 'text_capture', key: args.rememberKey, value: fullText });
      }
      
      return { ok: true, capturedText: fullText };
    }
    case 'connect_linkedin_profile': {
      const url = args.url;
      const scrolls = args.scrolls || 2;
      const rememberKey = args.rememberKey || 'linkedin:profile:self';
      const captureResult = await handleCommand('capture_visible_text', {
        packageName: 'com.linkedin.android',
        url,
        scrolls,
        rememberKey
      }, req, payload);
      return { ok: true, message: `LinkedIn profile connected and saved under key ${rememberKey}.`, captureResult };
    }
    case 'learn_app_procedure': {
      const record = {
        kind: 'procedure',
        key: args.name,
        value: {
          name: args.name,
          packageName: args.packageName,
          goal: args.goal,
          steps: args.steps,
          successSignals: args.successSignals,
          failureSignals: args.failureSignals,
          confidence: args.confidence
        }
      };
      const saved = rememberRecord(record);
      return { ok: true, saved };
    }
    case 'list_learned_app_procedures': {
      const query = args.query || args.packageName || '';
      const limit = args.limit || 20;
      const results = searchMemory(query, limit, 'procedure');
      return { ok: true, procedures: results.map(r => r.value) };
    }
    case 'delete_learned_app_procedure': {
      const name = args.name;
      const count = forgetMemoryByKey('procedure', name);
      return { ok: true, deletedCount: count };
    }
    case 'run_learned_app_procedure': {
      const name = args.name;
      const memoryMatches = memory.filter(m => m.kind === 'procedure' && m.key === name);
      if (memoryMatches.length === 0) {
        return { ok: false, error: `Procedure "${name}" not found in memory.` };
      }
      const procedure = memoryMatches[0];
      const steps = procedure.value ? procedure.value.steps : [];
      const results = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        try {
          await executeMacroStep(step);
          results.push(`Step ${i + 1} (${step.action || step.type}): Success`);
        } catch (err) {
          results.push(`Step ${i + 1} (${step.action || step.type}): Failed: ${err.message}`);
          return { ok: false, error: err.message, stepsRun: results };
        }
      }
      return { ok: true, stepsRun: results };
    }

    // YouTube control aliases
    case 'youtube_play_pause':
      await executeShell('input keyevent 85 2>/dev/null || adb shell input keyevent 85').catch(() => {});
      return { ok: true, message: 'Toggled YouTube Play/Pause' };
    case 'youtube_share_current': {
      const xml = await dumpAndroidUI();
      const el = findElementInXml(xml, 'Share');
      if (el) {
        await executeShell(`input tap ${el.x} ${el.y}`).catch(() => {});
        return { ok: true, message: 'Clicked YouTube Share button' };
      }
      return { ok: false, error: 'Share button not found on screen' };
    }
    case 'youtube_comment_current': {
      const commentText = args.text || args.comment || '';
      const xml = await dumpAndroidUI();
      const el = findElementInXml(xml, 'Add a comment');
      if (el) {
        await executeShell(`input tap ${el.x} ${el.y}`).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        await executeShell(`input text "${commentText.replace(/"/g, '\\"')}"`).catch(() => {});
        const postXml = await dumpAndroidUI();
        const postEl = findElementInXml(postXml, 'Post') || findElementInXml(postXml, 'Send') || findElementInXml(postXml, 'com.google.android.youtube:id/send_button');
        if (postEl) {
          await executeShell(`input tap ${postEl.x} ${postEl.y}`).catch(() => {});
          return { ok: true, message: 'Posted comment successfully' };
        }
      }
      return { ok: false, error: 'Could not post comment on YouTube screen' };
    }
    case 'youtube_observe_screen':
      return handleCommand('observe_current_screen', args, req, payload);

    case 'health':
    case 'status':
      return snapshot();
    case 'version':
      return { version: VERSION };
    case 'pair': {
      // Verify license token before accepting the pair
      const licenseToken = normalizeText(args.licenseToken || '');
      const licensePayload = licenseToken ? verifyLicenseToken(licenseToken) : null;

      if (!licensePayload) {
        appendLog('pair rejected: invalid or missing license token');
        return {
          paired: false,
          licensed: false,
          error: 'License token is missing, invalid, or expired. The app must provide a valid token.',
        };
      }

      // License is valid — activate engine
      licenseState.licensed = true;
      licenseState.expiresAt = licensePayload.exp * 1000;
      appendLog(`license accepted, expires ${new Date(licenseState.expiresAt).toISOString()}`);

      state = { ...state, token: normalizeText(args.token) || null };
      saveState(state);

      // Accept company config from the APK — held in memory only, never persisted
      if (args.config && typeof args.config === 'object') {
        if (args.config.backendApiBaseUrl) engineConfig.backendApiBaseUrl = normalizeText(args.config.backendApiBaseUrl).replace(/\/+$/, '');
        if (args.config.geminiModel) engineConfig.geminiModel = normalizeText(args.config.geminiModel);
        if (args.config.googleClientId) engineConfig.googleClientId = normalizeText(args.config.googleClientId);
        appendLog('engine config received from APK (memory only)');
      }

      appendLog('paired');
      return { paired: true, licensed: true, expiresAt: licenseState.expiresAt };
    }
    case 'getLogs':
      return { lines: fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-200) : [] };

    // ── Custom skill management ───────────────────────────────────────────────
    case 'upload_skill': {
      const filename = String(args.filename || '').trim();
      const code = String(args.code || '').trim();
      if (!filename.endsWith('.skill.js') || filename.includes('/') || filename.includes('..')) {
        return { ok: false, error: 'filename must end in .skill.js and contain no path separators' };
      }
      if (!code) {
        return { ok: false, error: 'code is required' };
      }
      if (!code.includes('module.exports')) {
        return { ok: false, error: 'code must use module.exports = { ... }' };
      }
      if (!fs.existsSync(CUSTOM_SKILLS_DIR)) {
        fs.mkdirSync(CUSTOM_SKILLS_DIR, { recursive: true });
      }
      const destPath = path.join(CUSTOM_SKILLS_DIR, filename);
      fs.writeFileSync(destPath, code, 'utf8');
      appendLog(`skill uploaded: ${filename}`);
      // Hot-reload
      skills = loadSkills();
      const uploadedDecls = (skills.find((s) => s.id === filename.replace('.skill.js', ''))?.toolDeclarations || []).length;
      return { ok: true, filename, toolCount: uploadedDecls };
    }

    case 'list_custom_skills': {
      if (!fs.existsSync(CUSTOM_SKILLS_DIR)) {
        return { skills: [] };
      }
      const files = fs.readdirSync(CUSTOM_SKILLS_DIR).filter((f) => f.endsWith('.skill.js'));
      const result = files.map((filename) => {
        const filePath = path.join(CUSTOM_SKILLS_DIR, filename);
        const stat = fs.statSync(filePath);
        const loaded = skills.find((s) => s.id === filename.replace('.skill.js', ''));
        return {
          filename,
          name: loaded?.name || filename,
          enabled: loaded?.enabled !== false,
          toolCount: (loaded?.toolDeclarations || []).length,
          updatedAt: stat.mtimeMs,
        };
      });
      return { skills: result };
    }

    case 'delete_custom_skill': {
      const filename = String(args.filename || '').trim();
      if (!filename.endsWith('.skill.js') || filename.includes('/') || filename.includes('..')) {
        return { ok: false, error: 'invalid filename' };
      }
      const targetPath = path.join(CUSTOM_SKILLS_DIR, filename);
      if (!fs.existsSync(targetPath)) {
        return { ok: false, error: `Skill file not found: ${filename}` };
      }
      fs.unlinkSync(targetPath);
      appendLog(`skill deleted: ${filename}`);
      // Hot-reload
      jsSkillHandlers.clear();
      skills = loadSkills();
      return { ok: true, filename };
    }

    case 'reload_skills': {
      jsSkillHandlers.clear();
      skills = loadSkills();
      return { ok: true, skillCount: skills.length, jsHandlerCount: jsSkillHandlers.size };
    }
    // ── End skill management ─────────────────────────────────────────────────

    case 'runTask':
      return { job: createJob(normalizeText(args.taskName) || 'generic-task', args) };
    case 'listJobs':
      return { jobs: Array.from(jobs.values()) };
    case 'update':
      if (!fs.existsSync(path.join(DATA_DIR, '.git'))) {
        return { output: 'Engine repo is not a git checkout yet. Clone the engine repo in Termux, then run update again.' };
      }
      try {
        const { stdout } = await execFileAsync('git', ['-C', DATA_DIR, 'pull', '--rebase'], {
          cwd: DATA_DIR,
          maxBuffer: 1024 * 1024 * 4,
        });
        return { output: summarizeText(stdout) };
      } catch (error) {
        return { output: `git pull failed: ${error.message}` };
      }
    case 'remember':
    case 'remember_user_fact':
      return { record: rememberRecord(args) };
    case 'show_memory':
    case 'show_user_memory':
      return { records: searchMemory(args.query || '', args.limit || 20, args.kind) };
    case 'forget_memory':
    case 'forget_user_memory':
      return { removed: forgetMemory(args.query || '', args.kind) };
    case 'forget_memory_by_key':
      return { removed: forgetMemoryByKey(normalizeText(args.kind || 'fact'), normalizeText(args.key || '')) };
    case 'create_plan':
      return { plan: createPlan(args) };
    case 'list_plans':
      return { plans: listPlans() };
    case 'configure_connector':
      return { connector: upsertConnector(normalizeText(args.type || 'generic'), args) };
    case 'list_connectors':
      return { connectors: listConnectors(normalizeText(args.type || '')) };
    case 'remove_connector':
      return { removed: removeConnector(normalizeText(args.id || '')) };
    case 'gmail_connect':
      if (args.accessToken || args.refreshToken) {
        saveGoogleAuthState({
          accessToken: args.accessToken,
          refreshToken: args.refreshToken,
          expiryMs: args.expiryMs || args.expiresAt || 0,
          email: args.email || googleAuth.email,
          clientId: args.clientId || googleAuth.clientId,
          apiBaseUrl: args.apiBaseUrl || googleAuth.apiBaseUrl,
          androidClientId: args.androidClientId || googleAuth.androidClientId,
        });
      }
      return {
        connector: upsertConnector('gmail', {
          ...args,
          label: normalizeText(args.label || args.email || 'Gmail'),
          status: 'configured',
          config: {
            ...args,
            authState: getGoogleAuthStatus().connected ? 'connected' : 'missing',
            syncState: 'idle',
          },
        }),
        auth: getGoogleAuthStatus(),
      };
    case 'gmail_send':
      return {
        message: 'Gmail send queued.',
        sent: await gmailSendMessage(args),
      };
    case 'gmail_list':
      return gmailListMessages({
        query: args.query || '',
        limit: args.limit || 10,
      });
    case 'gmail_read':
      {
        let messageId = normalizeText(args.messageId || args.id || '');
        if (!messageId && normalizeText(args.query || '')) {
          const found = await gmailListMessages({ query: args.query, limit: 1 });
          messageId = found.messages[0]?.id || '';
        }
        if (!messageId) throw new Error('Provide a Gmail messageId or query.');
        return {
          message: await gmailGetMessage(messageId, 'full'),
        };
      }
    case 'mail_watch_start':
    case 'mail_watch_enable':
      return {
        rule: upsertEmailWatchRule({
          ...args,
          enabled: true,
          mode: 'gmail_query',
        }),
        message: 'Email watch rule saved.',
      };
    case 'mail_watch_stop':
    case 'mail_watch_disable':
      return {
        rule: upsertEmailWatchRule({
          ...args,
          enabled: false,
          mode: 'gmail_query',
        }),
        message: 'Email watch rule disabled.',
      };
    case 'mail_watch_list':
      return { rules: listEmailWatchRules() };
    case 'list_email_watch_rules':
      return { rules: listEmailWatchRules() };
    case 'configure_email_watch':
      return {
        rule: upsertEmailWatchRule({
          ...args,
          mode: 'gmail_query',
        }),
      };
    case 'cancel_email_watch':
      return { cancelled: cancelEmailWatchRule(normalizeText(args.ruleId || args.id || '')) };
    case 'check_email_watch_now':
      return checkEmailWatchRuleNow(normalizeText(args.ruleId || args.id || ''));
    case 'create_reminder':
      return { reminder: createReminder(args) };
    case 'list_reminders':
      return { reminders: listReminders(Boolean(args.includePast)) };
    case 'cancel_reminder':
      return { removed: cancelReminder(args) };
    case 'set_alarm':
      return setAlarm(args);
    case 'dismiss_alarm':
      return dismissAlarm();
    case 'plan_my_day':
      return { plan: buildDayPlan(args), text: buildDayPlan(args) };
    case 'schedule_recurring_task':
      return { task: scheduleRecurringTask(args) };
    case 'list_recurring_tasks':
      return { tasks: recurringTasks };
    case 'cancel_recurring_task':
      return { removed: cancelRecurringTask(normalizeText(args.taskId)) };
    case 'google_search': {
      const query = args.query || '';
      const preferStatic = !!args.preferStatic || !!args.static;

      let summary = '';
      if (preferStatic) {
        try {
          summary = await handleSearch(query);
        } catch (e) {
          summary = `Search failed: ${e.message}`;
        }
      }

      // Automatically run dynamic search by default unless preferStatic is true AND succeeded
      const runDynamic = !preferStatic ||
        !summary ||
        summary.startsWith('Search failed') ||
        summary.includes('No clear search results') ||
        summary.includes('No search results') ||
        isBotProtectionBlock(summary) ||
        summary.length < 80;

      if (runDynamic) {
        const jobId = 'scrape_search_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
        const goal = `Find the answer for query: "${query}" from the search results.`;

        activeScrapeJobs.set(jobId, {
          jobId,
          threadId: payload?.threadId || null,
          url: searchUrl,
          goal,
          outputSchema: null,
          maxSteps: 8,
          currentStep: 0,
          history: [],
          status: 'started',
          createdAt: Date.now()
        });

        appendLog(`[Scraper] Starting automatic dynamic search scrape job ${jobId} for URL ${searchUrl}`);

        return {
          action: 'webview-scrape-start',
          jobId,
          url: searchUrl,
          goal,
          status: 'scraping_started',
          message: `Launching dynamic webview search for "${query}" to find the answer...`
        };
      }
      return { summary };
    }
    case 'visit_website':
    case 'scrape_url': {
      const url = normalizeText(args.url || args.query || 'https://example.com');
      let pageHtml = '';
      try {
        pageHtml = await visitWebsite(url);
      } catch (err) {
        pageHtml = `Error visiting page: ${err.message}`;
      }

      const pageText = cleanPageText(pageHtml);
      const isBlocked = isBotProtectionBlock(pageText) ||
        !pageText ||
        pageText.includes('JavaScript is required') ||
        pageText.includes('enable cookies') ||
        pageText.length < 150;

      if (isBlocked) {
        const jobId = 'scrape_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const goal = `Read the content of this webpage and extract the useful details or text from it.`;

        activeScrapeJobs.set(jobId, {
          jobId,
          threadId: payload?.threadId || null,
          url,
          goal,
          outputSchema: null,
          maxSteps: 8,
          currentStep: 0,
          history: [],
          status: 'started',
          createdAt: Date.now()
        });

        appendLog(`[Scraper] Static website visit failed or blocked. Initialized scrape job ${jobId} for URL ${url}`);

        return {
          action: 'webview-scrape-start',
          jobId,
          url,
          goal,
          status: 'scraping_started',
          message: `Static visit to ${url} failed or was blocked. Launching dynamic webview scraper to extract content...`
        };
      }

      return {
        text: summarizeText(pageText)
      };
    }
    case 'agentic_dynamic_scrape': {
      const jobId = 'scrape_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const url = normalizeText(args.url || args.query || 'https://example.com');
      const goal = normalizeText(args.goal || 'Scrape the page content');

      activeScrapeJobs.set(jobId, {
        jobId,
        threadId: payload?.threadId || null,
        url,
        goal,
        outputSchema: args.outputSchema || null,
        maxSteps: Number(args.maxSteps) || 12,
        currentStep: 0,
        history: [],
        status: 'started',
        createdAt: Date.now()
      });

      appendLog(`[Scraper] Initialized job ${jobId} for URL ${url} with goal: "${goal}"`);

      return {
        action: 'webview-scrape-start',
        jobId,
        url,
        goal,
        status: 'scraping_started',
        message: `Starting a dynamic scrape for ${url} to find "${goal}". I will update you once it's complete.`
      };
    }
    case 'stop_scraping': {
      activeScrapeJobs.clear();
      appendLog('[Scraper] User requested stop. Cleared all active scrape jobs.');
      return {
        action: 'webview-scrape-stop',
        status: 'stopped',
        message: 'All active scraping and web search jobs have been stopped.'
      };
    }
    case 'report_scrape_step': {
      const jobId = normalizeText(args.jobId);
      const pageText = normalizeText(args.pageText || '');
      const currentUrl = normalizeText(args.currentUrl || '');

      const job = activeScrapeJobs.get(jobId);
      if (!job) {
        appendLog(`[Scraper] report_scrape_step error: Job ${jobId} not found`);
        return { error: 'Job not found' };
      }

      job.currentStep += 1;
      if (job.currentStep > job.maxSteps) {
        job.status = 'failed';
        appendLog(`[Scraper ${jobId}] Failed: Exceeded max steps`);
        return { nextAction: { type: 'finish', data: 'Failed: exceeded maximum navigation steps' } };
      }

      // Trim page text to prevent exceeding LLM context limits
      const trimmedText = pageText.slice(0, 10000);

      // Abort immediately if any captcha or bot-protection wall is detected
      if (isBotProtectionBlock(trimmedText)) {
        job.status = 'failed';
        appendLog(`[Scraper ${jobId}] Aborted: Captcha/bot-protection wall detected at ${currentUrl}`);
        if (job.threadId) {
          appendChatMessage(job.threadId, 'system', `[System Scraper Log]: Step ${job.currentStep}/${job.maxSteps} - Aborted: Bot protection wall detected.`);
        }
        activeScrapeJobs.delete(jobId);
        return { nextAction: { type: 'finish', data: `Blocked: The site at ${currentUrl} is protected by a captcha or bot-protection system (Cloudflare, reCAPTCHA, hCaptcha, Akamai, etc.) and cannot be automatically scraped. Try rephrasing your search or asking about a different source.`, reason: 'bot-protection' } };
      }

      const systemInstruction = `You are a dynamic web scraper agent. Your task is to achieve the user's scraping goal.
You are interacting with a webpage inside an Android WebView.
We will show you the current page URL, the extracted visible text, and the history of actions taken so far.
Based on this, you must choose the next logical browser action to get closer to the goal.

Available Actions:
1. {"type": "click", "selector": "CSS_SELECTOR", "reason": "Brief reason"}
2. {"type": "type", "selector": "CSS_SELECTOR", "text": "text to type", "reason": "Brief reason"}
3. {"type": "scroll", "direction": "down"|"up", "reason": "Brief reason"}
4. {"type": "wait", "durationMs": 3000, "reason": "Brief reason"}
5. {"type": "finish", "data": "The final extracted data answering the scraping goal", "reason": "Brief reason"}

Guidelines:
- Prefer CSS selectors that are standard (like ID, class, tag). Keep them simple.
- If the goal is fully satisfied by the visible text, return the "finish" action with the extracted data immediately.
- If you get stuck or see an error page, return "finish" with a clear error message.
- NEVER attempt to navigate to Cloudflare or captcha pages. If you see them, return "finish" immediately.
- Output ONLY the JSON object. Do not wrap in markdown blocks, do not add other text. Just raw JSON.`;

      const promptText = `Scraping Goal: ${job.goal}
Current URL: ${currentUrl}
Step: ${job.currentStep}/${job.maxSteps}

Previous Steps History:
${job.history.map((h, i) => `Step ${i + 1}: Action: ${JSON.stringify(h.action)} -> Result: ${h.result}`).join('\n') || 'None'}

Current Visible Page Text:
"""
${trimmedText}
"""

What is the next action?`;

      appendLog(`[Scraper ${jobId}] Step ${job.currentStep}: Prompting Gemini for next action...`);

      let nextAction;
      try {
        const result = await generateScraperGeminiReply(systemInstruction, promptText);
        // Parse the JSON action
        const cleanedText = result.text.replace(/```json/g, '').replace(/```/g, '').trim();
        nextAction = JSON.parse(cleanedText);
      } catch (err) {
        appendLog(`[Scraper ${jobId}] Failed to get action from Gemini: ${err.message}`);
        nextAction = { type: 'finish', data: 'Error planning next action: ' + err.message };
      }

      // Update history
      job.history.push({
        action: nextAction,
        result: nextAction.type === 'finish' ? 'Finished' : 'Executed ' + nextAction.type
      });

      if (nextAction.type === 'finish') {
        job.status = 'completed';
        job.result = nextAction.data;
      } else {
        job.status = 'executing';
      }

      appendLog(`[Scraper ${jobId}] Decided action: ${JSON.stringify(nextAction)}`);

      if (job.threadId && nextAction.type !== 'finish') {
        appendChatMessage(job.threadId, 'system', `[System Scraper Log]: Step ${job.currentStep}/${job.maxSteps} - Decided action: ${nextAction.type} (${nextAction.reason || ''})`);
      }

      return { nextAction };
    }
    case 'run_shell_command': {
      const cmd = normalizeText(args.command || '');
      if (!cmd) return { ok: false, error: 'No command provided' };
      const timeoutMs = Math.min(Number(args.timeout || 30), 120) * 1000;

      appendLog(`[Shell] Executing: ${cmd}`);
      try {
        const output = await Promise.race([
          (async () => {
            const { stdout, stderr } = await execFileAsync('sh', ['-c', cmd], {
              cwd: DATA_DIR,
              maxBuffer: 1024 * 1024 * 4,
            }).catch(async (err) => {
              return { stdout: '', stderr: err.message };
            });
            return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)), timeoutMs))
        ]);
        appendLog(`[Shell] Done: ${cmd}`);
        return {
          ok: true,
          command: cmd,
          stdout: output.stdout.slice(0, 8000),
          stderr: output.stderr.slice(0, 2000),
          output: (output.stdout + (output.stderr ? '\n[stderr]: ' + output.stderr : '')).trim().slice(0, 8000),
        };
      } catch (err) {
        appendLog(`[Shell] Failed: ${cmd} — ${err.message}`);
        return { ok: false, command: cmd, error: err.message };
      }
    }
    case 'read_file': {
      const filePath = normalizeText(args.path || '');
      if (!filePath) return { ok: false, error: 'No path provided' };
      const expanded = filePath.replace(/^~/, DATA_DIR);
      try {
        const content = fs.readFileSync(expanded, 'utf8');
        const lines = content.split('\n');
        const maxLines = Number(args.maxLines || 100);
        const sliced = lines.slice(0, maxLines);
        return {
          ok: true,
          path: filePath,
          content: sliced.join('\n'),
          totalLines: lines.length,
          returnedLines: sliced.length,
        };
      } catch (err) {
        return { ok: false, path: filePath, error: err.message };
      }
    }
    case 'write_file': {
      const filePath = normalizeText(args.path || '');
      const content = String(args.content || '');
      if (!filePath) return { ok: false, error: 'No path provided' };
      const expanded = filePath.replace(/^~/, DATA_DIR);
      try {
        if (args.append) {
          fs.appendFileSync(expanded, content, 'utf8');
        } else {
          fs.mkdirSync(path.dirname(expanded), { recursive: true });
          fs.writeFileSync(expanded, content, 'utf8');
        }
        return { ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8'), mode: args.append ? 'append' : 'write' };
      } catch (err) {
        return { ok: false, path: filePath, error: err.message };
      }
    }
    case 'list_directory': {
      const dirPath = normalizeText(args.path || '~');
      const expanded = dirPath.replace(/^~/, DATA_DIR);
      try {
        const entries = fs.readdirSync(expanded, { withFileTypes: true });
        const items = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? (() => { try { return fs.statSync(path.join(expanded, e.name)).size; } catch { return 0; } })() : null,
        }));
        return { ok: true, path: dirPath, items, count: items.length };
      } catch (err) {
        return { ok: false, path: dirPath, error: err.message };
      }
    }
    case 'run_js_script':
      return { result: await safeEval(normalizeText(args.code || ''), buildBridgeContext()) };
    case 'app_navigator':
    case 'navigate_app':
      return {
        screen: normalizeText(args.screen || args.route || 'home'),
        params: args.params || {},
      };
    case 'get_device_info':
    case 'basic_device_info':
      return {
        model: await executeShell('getprop ro.product.model').catch(() => 'unknown'),
        device: await executeShell('getprop ro.product.device').catch(() => 'unknown'),
        manufacturer: await executeShell('getprop ro.product.manufacturer').catch(() => 'unknown'),
      };
    case 'adb_pair': {
      const port = Number(args.port);
      const code = String(args.code || '').trim();
      if (!port || !code) {
        return { ok: false, error: 'Both pairing port and pairing code are required.' };
      }
      
      appendLog(`[ADB] Running pair command for port ${port}`);
      try {
        const result = await new Promise((resolve, reject) => {
          execFile('adb', ['pair', `127.0.0.1:${port}`, code], { timeout: 10000 }, (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '');
            if (err) {
              reject(new Error(out.trim() || err.message));
            } else {
              resolve(out.trim());
            }
          });
        });
        
        appendLog(`[ADB] Pair successful: ${result}`);
        connectAdb();
        return { ok: true, message: result };
      } catch (err) {
        appendLog(`[ADB] Pair failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    }
    case 'basic_phone_info':
    case 'phone_info':
      return {
        message: 'Phone info is now engine-side. Add a telephony connector if you need richer data.',
      };
    case 'phone_macro':
    case 'run_phone_macro':
      return {
        message: 'Phone macro requests should be modeled as engine jobs with explicit inputs.',
        job: createJob('phone-macro', args),
      };
    case 'native_settings':
    case 'open_native_settings':
      return {
        message: 'Use explicit settings shortcuts in the Android UI instead of hidden native mutations.',
      };
    case 'notifications':
    case 'list_notifications':
      return {
        message: 'Notification access should stay out of the public APK. Route notifications through the engine if you have an explicit connector.',
      };
    case 'mail_watch':
    case 'gmail_watch':
      return {
        message: 'Mail watch is engine-managed. Add a provider connector to poll or subscribe to messages.',
      };
    case 'set_google_auth_state':
      saveGoogleAuthState(args);
      upsertConnector('gmail', {
        id: 'google-auth',
        label: `Google Workspace (${googleAuth.email || 'account'})`,
        status: getGoogleAuthStatus().connected ? 'connected' : 'configured',
        config: {
          ...getGoogleAuthStatus(),
        },
      });
      return { auth: getGoogleAuthStatus() };
    case 'get_google_auth_state':
      return { auth: getGoogleAuthStatus() };
    case 'clear_google_auth_state':
      clearGoogleAuthState();
      removeConnector('google-auth');
      return { cleared: true, auth: getGoogleAuthStatus() };
    case 'set_app_auth_state':
      saveAppAuthState(args);
      return { auth: getAppAuthStatus() };
    case 'get_app_auth_state':
      return { auth: getAppAuthStatus() };
    case 'clear_app_auth_state':
      clearAppAuthState();
      return { cleared: true, auth: getAppAuthStatus() };
    case 'get_local_google_auth_url': {
      const clientId = normalizeText(args.clientId || googleAuth.clientId || '');
      if (!clientId) throw new Error('Google Client ID is missing.');
      const scopes = [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/forms.responses',
        'https://www.googleapis.com/auth/userinfo.email'
      ].join(' ');

      const redirectUri = `http://localhost:${PORT}/auth/google/callback`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes,
        access_type: 'offline',
        prompt: 'consent'
      }).toString();

      return { url: authUrl };
    }
    case 'google_docs_open':
    case 'google_docs_create':
    case 'create_google_doc': {
      const doc = await createGoogleDoc(args);
      const connector = upsertConnector('google-docs', {
        id: doc.documentId,
        label: normalizeText(args.title || doc.title || 'Google Doc'),
        status: 'synced',
        config: {
          documentId: doc.documentId,
          url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
        },
      });
      return { doc, connector };
    }
    case 'read_google_doc': {
      const documentId = documentIdFrom(args.documentId || args.id || '');
      const doc = await docsApi(`/${encodeURIComponent(documentId)}`);
      return { documentId: doc.documentId, title: doc.title, text: extractGoogleDocText(doc), doc };
    }
    case 'append_google_doc_text': {
      const documentId = documentIdFrom(args.documentId || args.id || '');
      const doc = await docsApi(`/${encodeURIComponent(documentId)}`);
      const prefix = extractGoogleDocText(doc) ? '\n' : '';
      const result = await docsApi(`/${encodeURIComponent(documentId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            insertText: {
              location: { index: appendGoogleDocIndex(doc) },
              text: `${prefix}${normalizeText(args.text || '')}`,
            },
          }],
        }),
      });
      return { result };
    }
    case 'replace_google_doc_text': {
      const documentId = documentIdFrom(args.documentId || args.id || '');
      const result = await docsApi(`/${encodeURIComponent(documentId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            replaceAllText: {
              containsText: { text: normalizeText(args.findText || ''), matchCase: Boolean(args.matchCase) },
              replaceText: normalizeText(args.replaceText || ''),
            },
          }],
        }),
      });
      return { result };
    }
    case 'google_sheets_open':
    case 'google_sheets_create':
    case 'create_google_sheet': {
      const spreadsheet = await createGoogleSheet(args);
      const connector = upsertConnector('google-sheets', {
        id: spreadsheet.spreadsheetId,
        label: normalizeText(args.title || spreadsheet.properties?.title || 'Google Sheet'),
        status: 'synced',
        config: {
          spreadsheetId: spreadsheet.spreadsheetId,
          url: spreadsheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheet.spreadsheetId}/edit`,
        },
      });
      return { spreadsheet, connector };
    }
    case 'read_google_sheet_range': {
      const spreadsheetId = spreadsheetIdFrom(args.spreadsheetId || args.id || '');
      const range = normalizeText(args.range || '');
      const data = await sheetsApi(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
      return { range: data.range, values: data.values || [], data };
    }
    case 'append_google_sheet_row': {
      const spreadsheetId = spreadsheetIdFrom(args.spreadsheetId || args.id || '');
      const range = normalizeText(args.range || '');
      const values = Array.isArray(args.values) ? args.values.map((cell) => cell == null ? '' : cell) : [];
      const params = new URLSearchParams({
        valueInputOption: normalizeText(args.valueInputOption || 'USER_ENTERED').toUpperCase() === 'RAW' ? 'RAW' : 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      });
      const update = await sheetsApi(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`, {
        method: 'POST',
        body: JSON.stringify({ majorDimension: 'ROWS', values: [values] }),
      });
      return { update };
    }
    case 'append_google_sheet_rows': {
      const spreadsheetId = spreadsheetIdFrom(args.spreadsheetId || args.id || '');
      const range = normalizeText(args.range || '');
      let rows = Array.isArray(args.rows) ? args.rows : [];
      if (rows.length === 0 && typeof args.rowsJson === 'string') {
        try {
          rows = JSON.parse(args.rowsJson);
        } catch (e) {
          appendLog(`failed to parse rowsJson: ${e.message}`);
        }
      }
      const params = new URLSearchParams({
        valueInputOption: normalizeText(args.valueInputOption || 'USER_ENTERED').toUpperCase() === 'RAW' ? 'RAW' : 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      });
      const update = await sheetsApi(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`, {
        method: 'POST',
        body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
      });
      return { update };
    }
    case 'update_google_sheet_range': {
      const spreadsheetId = spreadsheetIdFrom(args.spreadsheetId || args.id || '');
      const range = normalizeText(args.range || '');
      let rows = Array.isArray(args.values) ? args.values : [];
      if (rows.length === 0 && typeof args.valuesJson === 'string') {
        try {
          rows = JSON.parse(args.valuesJson);
        } catch (e) {
          appendLog(`failed to parse valuesJson: ${e.message}`);
        }
      }
      const params = new URLSearchParams({
        valueInputOption: normalizeText(args.valueInputOption || 'USER_ENTERED').toUpperCase() === 'RAW' ? 'RAW' : 'USER_ENTERED',
      });
      const update = await sheetsApi(`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`, {
        method: 'PUT',
        body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
      });
      return { update };
    }
    case 'google_forms_open':
    case 'google_forms_create':
    case 'create_google_form': {
      const form = await createGoogleForm(args);
      const connector = upsertConnector('google-forms', {
        id: form.formId,
        label: normalizeText(args.title || form.info?.title || 'Google Form'),
        status: 'synced',
        config: {
          formId: form.formId,
          url: `https://docs.google.com/forms/d/${form.formId}/edit`,
        },
      });
      return { form, connector };
    }
    case 'get_google_form': {
      const formId = formIdFrom(args.formId || args.id || '');
      const form = await formsApi(`/${encodeURIComponent(formId)}`);
      return { form };
    }
    case 'list_google_form_responses': {
      const formId = formIdFrom(args.formId || args.id || '');
      const params = new URLSearchParams();
      const pageSize = Number(args.pageSize || 20);
      if (Number.isFinite(pageSize) && pageSize > 0) params.set('pageSize', String(Math.min(1000, Math.floor(pageSize))));
      if (normalizeText(args.filter || '')) params.set('filter', normalizeText(args.filter || ''));
      const data = await formsApi(`/${encodeURIComponent(formId)}/responses${params.toString() ? `?${params.toString()}` : ''}`);
      return { responses: data.responses || [] };
    }
    case 'batch_update_google_form': {
      const formId = formIdFrom(args.formId || args.id || '');
      const requests = Array.isArray(args.requests) ? args.requests : [];
      const result = await formsApi(`/${encodeURIComponent(formId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          includeFormInResponse: Boolean(args.includeFormInResponse),
          requests,
        }),
      });
      return { result };
    }
    case 'add_google_form_questions': {
      const formId = formIdFrom(args.formId || args.id || '');
      const questions = normalizeFormQuestions(args.questions);
      const form = await formsApi(`/${encodeURIComponent(formId)}`);
      const requests = questions.map((question, index) => buildFormQuestionRequest(question, Array.isArray(form.items) ? form.items.length + index : index));
      const result = await formsApi(`/${encodeURIComponent(formId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          includeFormInResponse: true,
          requests,
        }),
      });
      return { result };
    }
    case 'sync_connectors':
      return {
        auth: getGoogleAuthStatus(),
        gmail: syncProviderConnectors('gmail', {
          ...args,
          status: getGoogleAuthStatus().connected ? 'connected' : 'missing',
        }),
        docs: syncProviderConnectors('google-docs', args),
        sheets: syncProviderConnectors('google-sheets', args),
        forms: syncProviderConnectors('google-forms', args),
        mailWatch: syncProviderConnectors('mail-watch', args),
      };
    case 'list_chat_threads':
      return { threads: listChatThreads() };
    case 'get_chat_thread':
      return { thread: getChatThread(args.threadId) };
    case 'clear_chat_thread':
      return { cleared: clearChatThread(args.threadId) };
    case 'whatsapp_status':
      return getWhatsAppStatus();
    case 'whatsapp_connect': {
      const code = await connectWhatsApp(args.phoneNumber, appendLog, processMessageThroughModel);
      return { ok: true, pairingCode: code };
    }
    case 'whatsapp_disconnect':
      await disconnectWhatsApp();
      return { ok: true };
    case 'get_recent_logs': {
      try {
        if (!fs.existsSync(LOG_FILE)) return { logs: [] };
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
        return { logs: lines.slice(-10) };
      } catch (err) {
        return { logs: [`Error reading logs: ${err.message}`] };
      }
    }
    case 'chat': {
      const threadId = normalizeThreadId(args.threadId);
      const messageText = normalizeText(args.message);
      const thread = upsertChatThread(threadId, args.title || 'Chat');
      const userMessage = messageText ? appendChatMessage(threadId, 'user', messageText) : null;
      let replyText = '';
      let assistantMessage = null;
      let loopCount = 0;
      const maxLoops = 5;

      while (loopCount < maxLoops) {
        loopCount++;
        try {
          const result = await generateGeminiReply(thread);

          if (result.functionCalls && result.functionCalls.length > 0) {
            // Format functionCall model response
            const parts = result.functionCalls.map((call) => ({
              functionCall: {
                name: call.name,
                args: call.args || {},
              },
            }));
            appendChatMessage(threadId, 'assistant', '', parts);

            const responseParts = [];
            for (const call of result.functionCalls) {
              appendLog(`engine executing tool: ${call.name} with args ${JSON.stringify(call.args)}`);
              let executionResult;
              try {
                executionResult = await handleCommand(call.name, call.args, req, { ...payload, threadId });
              } catch (e) {
                appendLog(`tool ${call.name} failed: ${e.message}`);
                executionResult = { ok: false, error: e.message };
              }

              responseParts.push({
                functionResponse: {
                  name: call.name,
                  response: executionResult,
                },
              });
            }
            appendChatMessage(threadId, 'function', '', responseParts);

            // Continue the loop to call Gemini again with the tool output
            continue;
          }

          replyText = result.text || 'idanAI returned an empty reply.';
          assistantMessage = appendChatMessage(threadId, 'assistant', replyText);
          break;
        } catch (error) {
          appendLog(`idanAI chat loop error: ${error.message}`);
          replyText = `idanAI chat failed: ${error.message}`;
          assistantMessage = appendChatMessage(threadId, 'assistant', replyText);
          break;
        }
      }

      return {
        thread: getChatThread(threadId),
        userMessage,
        assistantMessage,
        reply: replyText,
      };
    }
    case 'get_battery_status':
      return { output: summarizeText(await getBatteryStatus()) };
    case 'run_shizuku_health_check':
      return { output: await healthCheck() };
    case 'open_whatsapp_chat':
    case 'send_whatsapp_message':
    case 'search_whatsapp_chat':
      return await handleWhatsApp(args);
    case 'open_youtube':
    case 'search_youtube':
      return handleYouTube(args);
    case 'open_link':
    case 'open_url':
      return {
        action: 'open-url',
        url: normalizeText(args.url || args.link || ''),
      };
    default: {
      // ── JS custom skill dispatch ──────────────────────────────────────────
      // Check if a loaded .skill.js file registered a handler for this command
      const jsHandler = jsSkillHandlers.get(command);
      if (jsHandler) {
        const ctx = buildBridgeContext();
        ctx.appendLog = appendLog;
        ctx.rememberRecord = rememberRecord;
        ctx.searchMemory = searchMemory;
        try {
          return await jsHandler(command, args, ctx);
        } catch (e) {
          appendLog(`JS skill handler '${command}' threw: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }
      return { message: `Unsupported command: ${command}` };
    }
  }
}

ensureRecurringTimers();
startRemindersScheduler();
startAdbManager();
initWhatsApp(appendLog, processMessageThroughModel).catch((err) => {
  appendLog(`[WhatsApp] Auto-init failed: ${err.message}`);
});
appendLog(`engine started v${VERSION}`);

const server = http.createServer(async (req, res) => {
  try {
    appendLog(`request: ${req.method} ${req.url}`); // Log ALL requests

    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, snapshot());
    }

    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, snapshot());
    }

    if (req.method === 'GET' && req.url.startsWith('/auth/google/callback')) {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const code = parsedUrl.searchParams.get('code');
      const error = parsedUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (error) {
        res.end(`
          <html>
            <body style="font-family: sans-serif; background-color: #121212; color: #ffffff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="background-color: #1e1e1e; padding: 40px; border-radius: 12px; border: 1px solid #ff3b30; text-align: center; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                <h1 style="color: #ff3b30; margin-top: 0;">Connection Failed</h1>
                <p style="font-size: 16px; color: #bbbbbb; line-height: 1.5;">Google OAuth error: ${error}</p>
                <p style="font-size: 14px; color: #888888;">You can close this tab and try again.</p>
              </div>
            </body>
          </html>
        `);
        return;
      }

      if (!code) {
        res.end(`
          <html>
            <body style="font-family: sans-serif; background-color: #121212; color: #ffffff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="background-color: #1e1e1e; padding: 40px; border-radius: 12px; border: 1px solid #ff9500; text-align: center; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                <h1 style="color: #ff9500; margin-top: 0;">Missing Code</h1>
                <p style="font-size: 16px; color: #bbbbbb; line-height: 1.5;">No authorization code was returned from Google.</p>
              </div>
            </body>
          </html>
        `);
        return;
      }

      try {
        const clientId = googleAuth.clientId;
        const clientSecret = googleAuth.clientSecret;
        if (!clientId || !clientSecret) {
          throw new Error('Local Google Client ID or Client Secret is not set in the engine.');
        }

        const redirectUri = `http://localhost:${PORT}/auth/google/callback`;
        const params = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        });

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.access_token) {
          throw new Error(tokenData.error_description || tokenData.error || `Token exchange failed: ${tokenRes.status}`);
        }

        // Fetch user email
        const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userInfo = await userInfoRes.json();
        const email = userInfo.email || 'unknown';

        const expiryMs = Number.isFinite(Number(tokenData.expires_in)) && Number(tokenData.expires_in) > 0
          ? Date.now() + Number(tokenData.expires_in) * 1000
          : Date.now() + 3600 * 1000;

        saveGoogleAuthState({
          accessToken: String(tokenData.access_token),
          refreshToken: String(tokenData.refresh_token || googleAuth.refreshToken),
          expiryMs,
          email
        });

        // Update Workspace connectors
        upsertConnector('gmail', {
          id: 'google-auth',
          label: `Google Workspace (${email})`,
          status: 'connected',
          config: {
            ...getGoogleAuthStatus(),
          },
        });

        res.end(`
          <html>
            <body style="font-family: sans-serif; background-color: #121212; color: #ffffff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="background-color: #1e1e1e; padding: 40px; border-radius: 12px; border: 1px solid #333333; text-align: center; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                <h1 style="color: #00e676; margin-top: 0;">Connected!</h1>
                <p style="font-size: 16px; color: #bbbbbb; line-height: 1.5;">Your Google Workspace account (<b>${email}</b>) has been successfully connected to Idan AI locally.</p>
                <p style="font-size: 14px; color: #888888;">You can now close this tab and return to the application.</p>
              </div>
            </body>
          </html>
        `);
      } catch (e) {
        appendLog(`local oauth callback error: ${e.message}`);
        res.end(`
          <html>
            <body style="font-family: sans-serif; background-color: #121212; color: #ffffff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0;">
              <div style="background-color: #1e1e1e; padding: 40px; border-radius: 12px; border: 1px solid #ff3b30; text-align: center; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                <h1 style="color: #ff3b30; margin-top: 0;">Connection Failed</h1>
                <p style="font-size: 16px; color: #bbbbbb; line-height: 1.5;">Error exchanging token: ${e.message}</p>
                <p style="font-size: 14px; color: #888888;">Please check your credentials and try again.</p>
              </div>
            </body>
          </html>
        `);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      const payload = await readBody(req);
      const command = payload.command;
      const args = payload.args || {};

      appendLog(`received RPC: ${command}`); // Log incoming requests

      if (command !== 'health' && command !== 'status' && command !== 'version' && command !== 'pair') {
        if (!requireAuth(req, res, payload)) return;

        // License gate — engine refuses all commands until a valid license token is received
        if (!licenseState.licensed || Date.now() > licenseState.expiresAt) {
          return json(res, 403, {
            v: 1,
            id: payload.id || null,
            ok: false,
            error: {
              code: 'LICENSE_EXPIRED',
              message: 'Engine license has expired or was never set. Open the app to renew.',
            },
          });
        }
      }

      const result = await handleCommand(command, args, req, payload);
      return json(res, 200, {
        v: 1,
        id: payload.id || null,
        ok: true,
        result,
      });
    }

    return json(res, 404, {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
    });
  } catch (error) {
    appendLog(`error: ${error.message}`);
    return json(res, 500, {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error && error.message ? error.message : 'Unknown engine error',
      },
    });
  }
});

server.listen(PORT, HOST, () => {
  appendLog(`listening on http://${HOST}:${PORT}`);
  console.log(`Idan engine listening on http://${HOST}:${PORT}`);
  executeShell('termux-wake-lock').catch(() => { });
});
