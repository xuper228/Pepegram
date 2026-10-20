require('dotenv').config();

const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MAX_TEXT_LENGTH = 500;
const MAX_NICK_LENGTH = 20;
const MAX_ROOM_LENGTH = 32;
const HISTORY_LIMIT = 100;
const users = Object.create(null);
const roomHistory = new Map();
const rateLimits = new Map();
const publicRooms = new Set(['general']);
const rooms = new Map();
const roomAccess = new Map();
const accounts = new Map();
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const AI_ROOM = 'room:ai';
const parseBoolean = (value, fallback) => typeof value === 'string' ? value.trim().toLowerCase() === 'true' : fallback;
const AI_PRIVATE = parseBoolean(process.env.AI_PRIVATE, true);
const AI_IN_GENERAL_CHAT = parseBoolean(process.env.AI_IN_GENERAL_CHAT, false);

let mongoCollection = null;
let accountCollection = null;
let roomCollection = null;
let ollamaAvailable = false;
let ollamaStarting = null;

const normalizeText = (value, max = MAX_TEXT_LENGTH) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const normalizeNick = (value) => normalizeText(value, MAX_NICK_LENGTH).replace(/[\u0000-\u001f\u007f]/g, '');
const normalizeRoom = (value) => normalizeText(value, MAX_ROOM_LENGTH).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '');
const roomId = (name) => `room:${normalizeRoom(name) || 'general'}`;
const aiRoomFor = (account) => AI_PRIVATE
  ? `room:ai:${crypto.createHash('sha256').update(account.username).digest('hex').slice(0, 16)}`
  : AI_ROOM;
const isAiRoom = (room) => AI_PRIVATE ? room.startsWith('room:ai:') : room === AI_ROOM;
const aiEnabledInRoom = (room) => isAiRoom(room) || (AI_IN_GENERAL_CHAT && room === roomId('general'));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const normalizeUsername = (value) => typeof value === 'string' && /^[\p{L}\p{N}_]{3,20}$/u.test(value.trim()) ? value.trim().toLocaleLowerCase() : '';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, derivedKey) => error ? reject(error) : resolve(`${salt}:${derivedKey.toString('hex')}`)));
}

async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = await hashPassword(password, salt);
  const candidateHash = Buffer.from(candidate.split(':')[1], 'hex');
  const storedHash = Buffer.from(hash, 'hex');
  return candidateHash.length === storedHash.length && crypto.timingSafeEqual(candidateHash, storedHash);
}

function cookieOptions(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `auth_token=${token}; Max-Age=${SESSION_TTL / 1000}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=')) .filter(([key, value]) => key && value));
}

async function findAccount(username) {
  if (accountCollection) return accountCollection.findOne({ username });
  return accounts.get(username) || null;
}

async function saveAccount(account) {
  accounts.set(account.username, account);
  if (accountCollection) await accountCollection.updateOne({ username: account.username }, { $set: account }, { upsert: true });
}

function createSession(account) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { account, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; }
  return session.account;
}

function accountFromRequest(req) {
  return getSession(parseCookies(req.headers.cookie || '').auth_token);
}

function socketIsAuthenticated(socket) {
  return Boolean(socket.data.sessionToken && getSession(socket.data.sessionToken));
}

function roomList() {
  return [
    { name: 'general', title: 'Загальний чат', protected: false, creator: 'system' },
    ...[...rooms.values()].map((room) => ({ name: room.name, title: room.name, protected: Boolean(room.passwordHash), creator: room.creatorUsername, createdAt: room.createdAt }))
  ];
}

function roomListForAccount(account) {
  const username = account?.username;
  return roomList().map((room) => ({ ...room, unlocked: !room.protected || Boolean(username && roomAccess.get(username)?.has(room.name)) }));
}

function broadcastRoomList() {
  for (const socket of io.sockets.sockets.values()) socket.emit('roomList', roomListForAccount(socket.data.account));
}

function countCreatedRooms(username) {
  return [...rooms.values()].filter((room) => room.creatorUsername === username).length;
}

function grantRoomAccess(username, name) {
  const allowed = roomAccess.get(username) || new Set();
  allowed.add(name); roomAccess.set(username, allowed);
}

function addMemory(entry) {
  const list = roomHistory.get(entry.roomId) || [];
  list.push(entry);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  roomHistory.set(entry.roomId, list);
}

async function saveEntry(entry) {
  addMemory(entry);
  if (!mongoCollection) return;
  try { await mongoCollection.insertOne(entry); }
  catch (error) { console.error('[MongoDB save error]', error.message); }
}

async function getHistory(room) {
  const cached = roomHistory.get(room);
  if (cached && (!mongoCollection || cached.length > 0)) return cached;
  if (!mongoCollection) return [];
  try {
    const list = await mongoCollection.find({ roomId: room }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).toArray();
    list.reverse(); roomHistory.set(room, list); return list;
  } catch (error) {
    console.error('[MongoDB history error]', error.message); return [];
  }
}

async function connectMongo() {
  if (!process.env.MONGODB_URI) {
    console.log('MongoDB не налаштована: історія зберігається лише в памʼяті.');
    return;
  }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'pepegram');
    mongoCollection = db.collection('messages');
    accountCollection = db.collection('accounts');
    roomCollection = db.collection('rooms');
    await mongoCollection.createIndex({ roomId: 1, createdAt: -1 });
    await accountCollection.createIndex({ username: 1 }, { unique: true });
    await roomCollection.createIndex({ name: 1 }, { unique: true });
    const storedRooms = await roomCollection.find({}).toArray();
    storedRooms.forEach((room) => rooms.set(room.name, room));
    broadcastRoomList();
    console.log('MongoDB підключена.');
  } catch (error) {
    console.error('[MongoDB connection error]', error.message);
  }
}

async function saveRoom(room) {
  rooms.set(room.name, room);
  if (roomCollection) await roomCollection.updateOne({ name: room.name }, { $set: room }, { upsert: true });
}

function emitSystem(room, text) {
  if (isAiRoom(room)) return;
  const entry = { type: 'system', roomId: room, text: normalizeText(text), createdAt: Date.now() };
  saveEntry(entry);
  io.to(room).emit('system', entry);
}

function onlineUsers() {
  return Object.entries(users).map(([id, user]) => ({ id, nick: user.nick, roomId: user.roomId }));
}

function isNickTaken(nick, socketId) {
  const normalized = nick.toLocaleLowerCase('uk');
  return Object.entries(users).some(([id, user]) => id !== socketId && user.nick.toLocaleLowerCase('uk') === normalized);
}

function limited(key, max, windowMs) {
  const now = Date.now();
  const recent = (rateLimits.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= max) return false;
  recent.push(now); rateLimits.set(key, recent); return true;
}

app.use(express.json({ limit: '8kb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(__dirname + '/public'));

const swaggerDocument = {
  openapi: '3.0.3',
  info: { title: 'Pepegram API', version: '1.0.0', description: 'Авторизація, локальний Qwen та історія чату. Socket.IO події описані внизу документа.' },
  servers: [{ url: 'http://localhost:3000' }],
  components: {
    securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'auth_token' } },
    schemas: {
      Credentials: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', minLength: 3, maxLength: 20, description: 'Unicode-букви, цифри або _' }, password: { type: 'string', minLength: 8, maxLength: 128, format: 'password' } } },
      TextRequest: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 500 } } }
    }
  },
  paths: {
    '/api/auth/register': { post: { summary: 'Створити акаунт', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } } }, responses: { 201: { description: 'Акаунт створено' }, 400: { description: 'Некоректні дані' }, 409: { description: 'Логін зайнятий' } } } },
    '/api/auth/login': { post: { summary: 'Увійти', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } } }, responses: { 200: { description: 'Сесія створена' }, 401: { description: 'Невірні дані' } } } },
    '/api/auth/me': { get: { summary: 'Перевірити сесію', security: [{ sessionCookie: [] }], responses: { 200: { description: 'Авторизовано' }, 401: { description: 'Не авторизовано' } } } },
    '/api/auth/logout': { post: { summary: 'Вийти', security: [{ sessionCookie: [] }], responses: { 200: { description: 'Сесію завершено' } } } },
    '/api/ai/chat': { post: { summary: 'Запит до локального Qwen', security: [{ sessionCookie: [] }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TextRequest' } } } }, responses: { 200: { description: 'Відповідь моделі' }, 401: { description: 'Не авторизовано' }, 429: { description: 'Rate limit' }, 503: { description: 'Ollama недоступна' } } } },
    '/api/rephrase': { post: { summary: 'Перефразувати текст через Qwen', security: [{ sessionCookie: [] }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TextRequest' } } } }, responses: { 200: { description: 'Перефразований текст' }, 401: { description: 'Не авторизовано' }, 429: { description: 'Rate limit' } } } }
  },
  'x-socket-io-events': {
    'authenticate': 'Підтвердження HttpOnly-сесії після підключення.',
    'setUsername': 'Приймає лише { nick }; сервер перевіряє сесію, унікальність і довжину.',
    'chat message': 'Приймає лише { text }; nick, senderId і roomId формуються сервером.',
    'joinRoom': 'Перемикання публічної кімнати або персональної AI-кімнати через { name: "ai" }.',
    'createRoom': 'Створює захищену кімнату; максимум 3 кімнати на акаунт. Приймає { name, password }.',
    'roomList': 'Список кімнат без passwordHash; захищені кімнати позначаються protected=true.',
    'openPrivateChat': 'Відкрити приватну кімнату з онлайн-користувачем.',
    'ai message': 'Доступна тільки авторизованому користувачу в AI-кімнаті або при AI_IN_GENERAL_CHAT=true.'
  }
};
app.get('/api-docs.json', (req, res) => res.json(swaggerDocument));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.post('/api/auth/register', async (req, res) => {
  try {
    if (!isObject(req.body)) return res.status(400).json({ error: 'Некоректні дані' });
    const username = normalizeUsername(req.body.username); const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!username || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Логін: 3–20 букв, пароль: 8–128 символів' });
    if (!limited(`register:${req.ip}`, 5, 10 * 60 * 1000)) return res.status(429).json({ error: 'Забагато спроб. Спробуйте пізніше.' });
    if (await findAccount(username)) return res.status(409).json({ error: 'Такий логін уже зайнятий' });
    const account = { username, passwordHash: await hashPassword(password), createdAt: Date.now() };
    await saveAccount(account);
    const token = createSession(account);
    res.setHeader('Set-Cookie', cookieOptions(token));
    return res.status(201).json({ registered: true, username });
  } catch (error) { console.error('[register error]', error); return res.status(500).json({ error: 'Не вдалося створити акаунт' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!isObject(req.body)) return res.status(400).json({ error: 'Некоректні дані' });
    const username = normalizeUsername(req.body.username); const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!username || !password || !limited(`login:${req.ip}`, 8, 10 * 60 * 1000)) return res.status(429).json({ error: 'Забагато спроб входу. Спробуйте пізніше.' });
    const account = await findAccount(username);
    if (!account || !(await verifyPassword(password, account.passwordHash))) return res.status(401).json({ error: 'Невірний логін або пароль' });
    const token = createSession(account); res.setHeader('Set-Cookie', cookieOptions(token));
    return res.json({ username });
  } catch (error) { console.error('[login error]', error); return res.status(500).json({ error: 'Не вдалося виконати вхід' }); }
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie || '').auth_token;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'auth_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const account = accountFromRequest(req);
  if (!account) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, username: account.username });
});

const OLLAMA_BASE_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '').replace(/\/api\/(generate|chat)$/, '');
const OLLAMA_URL = `${OLLAMA_BASE_URL}/api/generate`;
const AI_MODEL = process.env.QWEN_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:4b';
const OLLAMA_EXE = process.env.OLLAMA_EXE || (process.platform === 'win32' && process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : 'ollama');

function publishOllamaStatus(reason = '') {
  io.emit('ollamaStatus', { available: ollamaAvailable, model: AI_MODEL, reason });
}

async function ollamaTags() {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  return response.json();
}

async function waitForOllama() {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try { return await ollamaTags(); }
    catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  return null;
}

function startOllamaProcess() {
  if (ollamaStarting) return ollamaStarting;
  ollamaStarting = new Promise((resolve) => {
    try {
      const child = spawn(OLLAMA_EXE, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', (error) => { console.error(`[Ollama] Не вдалося запустити ${OLLAMA_EXE}: ${error.message}`); resolve(false); });
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch (error) { console.error('[Ollama] Помилка запуску:', error.message); resolve(false); }
  }).finally(() => { ollamaStarting = null; });
  return ollamaStarting;
}

async function warmOllama() {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: AI_MODEL, prompt: 'Відповідай одним словом: готово.', stream: false, keep_alive: '10m', options: { num_predict: 2, temperature: 0 } })
  });
  if (!response.ok) throw new Error(`Модель ${AI_MODEL} HTTP ${response.status}`);
}

async function ensureOllama({ warm = false } = {}) {
  let tags;
  try { tags = await ollamaTags(); }
  catch {
    console.log(`[Ollama] Сервіс не відповідає. Запускаю ${OLLAMA_EXE} serve...`);
    await startOllamaProcess();
    tags = await waitForOllama();
  }
  if (!tags) { ollamaAvailable = false; publishOllamaStatus('service_unavailable'); return false; }
  const models = Array.isArray(tags.models) ? tags.models.map((item) => item.name) : [];
  const modelExists = models.some((name) => name === AI_MODEL || name.startsWith(`${AI_MODEL}:`));
  if (!modelExists) {
    ollamaAvailable = false; console.error(`[Ollama] Модель ${AI_MODEL} не знайдена. Виконай: ollama pull ${AI_MODEL}`); publishOllamaStatus('model_missing'); return false;
  }
  if (warm) {
    try { console.log(`[Ollama] Завантажую модель ${AI_MODEL} у пам'ять...`); await warmOllama(); }
    catch (error) { ollamaAvailable = false; console.error(`[Ollama] Не вдалося прогріти модель: ${error.message}`); publishOllamaStatus('model_start_failed'); return false; }
  }
  ollamaAvailable = true; console.log(`[Ollama] Готова модель ${AI_MODEL}`); publishOllamaStatus('ready'); return true;
}

async function askOllama(prompt, options = {}) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: AI_MODEL, prompt, stream: false, options: { temperature: 0.75, num_predict: 400, ...options } })
  });
  if (!response.ok) throw new Error(`Ollama: ${response.status}`);
  const data = await response.json();
  const result = typeof data.response === 'string' ? data.response.trim() : '';
  if (!result) throw new Error('Модель не повернула результат');
  return result;
}

ensureOllama({ warm: true });
const ollamaHealthTimer = setInterval(() => ensureOllama({ warm: !ollamaAvailable }), 30000);
ollamaHealthTimer.unref();

const REPHRASE_PROMPTS = {
  formal: 'Перефразуй текст у формальному діловому стилі.',
  casual: 'Перефразуй текст у розмовному дружньому стилі.',
  shorter: 'Скороти текст, зберігши головну думку.',
  longer: 'Розгорни текст, додавши доречні деталі.',
  emoji: 'Додай доречні емодзі, не змінюючи зміст.',
  confident: 'Перефразуй текст впевнено та переконливо.'
};
const LANGUAGE_RULES = 'Відповідай українською. Не змінюй факти, числа, імена, посилання, ніки та код. Виведи лише готовий текст без пояснень.';

app.post('/api/rephrase', async (req, res) => {
  try {
    if (!accountFromRequest(req)) return res.status(401).json({ error: 'Потрібно увійти в акаунт' });
    if (!isObject(req.body)) return res.status(400).json({ error: 'Некоректне тіло запиту' });
    const text = normalizeText(req.body.text); const style = typeof req.body.style === 'string' ? req.body.style : '';
    if (!text || !REPHRASE_PROMPTS[style]) return res.status(400).json({ error: 'Некоректні text або style' });
    if (!ollamaAvailable) return res.status(503).json({ error: 'Ollama недоступна' });
    if (!limited(`rephrase:${req.socket.remoteAddress || 'unknown'}`, 10, 60000)) return res.status(429).json({ error: 'Забагато запитів. Спробуйте через хвилину.' });
    const result = await askOllama(`${LANGUAGE_RULES}\n${REPHRASE_PROMPTS[style]}\n\nТекст:\n${text}`, { num_predict: 300 });
    return res.json({ result, model: AI_MODEL });
  } catch (error) {
    console.error('[rephrase error]', error.message); return res.status(error.name === 'TimeoutError' ? 504 : 500).json({ error: 'Не вдалося виконати перефразування' });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    if (!accountFromRequest(req)) return res.status(401).json({ error: 'Потрібно увійти в акаунт' });
    if (!isObject(req.body)) return res.status(400).json({ error: 'Некоректне тіло запиту' });
    const text = normalizeText(req.body.text); if (!text) return res.status(400).json({ error: 'Порожнє повідомлення' });
    if (!ollamaAvailable) return res.status(503).json({ error: 'Ollama недоступна' });
    if (!limited(`ai:${req.socket.remoteAddress || 'unknown'}`, 20, 60000)) return res.status(429).json({ error: 'Забагато AI-запитів. Спробуйте пізніше.' });
    const result = await askOllama(`Ти локальний помічник у чаті. Відповідай українською коротко, живо й по суті.\nПовідомлення користувача:\n${text}`);
    return res.json({ result, model: AI_MODEL });
  } catch (error) {
    console.error('[ai chat error]', error.message); return res.status(error.name === 'TimeoutError' ? 504 : 500).json({ error: 'AI не відповідає' });
  }
});

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

io.on('connection', async (socket) => {
  const initialToken = parseCookies(socket.handshake.headers.cookie || '').auth_token;
  const cookieAccount = getSession(initialToken);
  socket.data.sessionToken = initialToken;
  socket.data.account = cookieAccount;
  // Після входу стартуємо із загального чату. AI-кімната відкривається окремо.
  socket.data.roomId = roomId('general');
  socket.join(socket.data.roomId);
  async function sendInitialState() {
    socket.emit('roomState', { roomId: socket.data.roomId, name: isAiRoom(socket.data.roomId) ? 'Qwen AI' : 'general', private: false, ai: isAiRoom(socket.data.roomId) });
    socket.emit('history', await getHistory(socket.data.roomId));
    socket.emit('onlineUsers', onlineUsers());
    socket.emit('roomList', roomListForAccount(socket.data.account));
    socket.emit('ollamaStatus', { available: ollamaAvailable, model: AI_MODEL });
  }
  if (socket.data.account) await sendInitialState();

  socket.on('authenticate', async (acknowledge) => {
    try {
      const account = getSession(parseCookies(socket.handshake.headers.cookie || '').auth_token);
      if (!account) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Потрібно увійти в акаунт' });
      socket.data.account = account;
      socket.data.sessionToken = parseCookies(socket.handshake.headers.cookie || '').auth_token;
      const nextRoom = roomId('general');
      if (socket.data.roomId !== nextRoom) { socket.leave(socket.data.roomId); socket.join(nextRoom); socket.data.roomId = nextRoom; }
      await sendInitialState();
      if (typeof acknowledge === 'function') acknowledge({ ok: true, username: account.username });
    } catch (error) { console.error('[socket auth error]', error); }
  });
 
  socket.on('setUsername', async (payload, acknowledge) => {
    try {
      if (!socketIsAuthenticated(socket)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Необхідна авторизація' });
      if (!isObject(payload)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Некоректний нік' });
      const nick = normalizeNick(payload.nick);
      if (!nick) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Нік не може бути порожнім' });
      if (isNickTaken(nick, socket.id)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Цей нік уже зайнятий' });
      const oldNick = users[socket.id]?.nick; users[socket.id] = { nick, roomId: socket.data.roomId };
      if (oldNick && oldNick !== nick) emitSystem(socket.data.roomId, `${oldNick} змінив нік на ${nick}`);
      else if (!oldNick) emitSystem(socket.data.roomId, `${nick} приєднався до чату 👋`);
      io.emit('onlineUsers', onlineUsers());
      if (typeof acknowledge === 'function') acknowledge({ ok: true, nick });
    } catch (error) { console.error('[setUsername error]', error); if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Не вдалося встановити нік' }); }
  });

  socket.on('createRoom', async (payload, acknowledge) => {
    try {
      if (!socketIsAuthenticated(socket)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Необхідна авторизація' });
      if (!isObject(payload)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Некоректні дані кімнати' });
      const name = normalizeRoom(payload.name);
      const password = typeof payload.password === 'string' ? payload.password : '';
      if (!name || name === 'general' || name === 'ai') return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Некоректна або зарезервована назва' });
      if (password.length < 4 || password.length > 128) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Пароль кімнати: від 4 до 128 символів' });
      if (rooms.has(name)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Кімната з такою назвою вже існує' });
      if (countCreatedRooms(socket.data.account.username) >= 3) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Можна створити максимум 3 кімнати' });
      const room = { name, passwordHash: await hashPassword(password), creatorUsername: socket.data.account.username, createdAt: Date.now() };
      await saveRoom(room);
      grantRoomAccess(socket.data.account.username, name);
      const roomKey = roomId(name);
      const createdEntry = { type: 'system', roomId: roomKey, text: `Кімнату створив ${room.creatorUsername}`, createdAt: room.createdAt };
      await saveEntry(createdEntry);
      broadcastRoomList();
      const previousRoom = socket.data.roomId;
      socket.leave(previousRoom); socket.join(roomKey); socket.data.roomId = roomKey;
      if (users[socket.id]) users[socket.id].roomId = roomKey;
      socket.emit('roomState', { roomId: roomKey, name, private: false, ai: false });
      socket.emit('history', await getHistory(roomKey));
      socket.emit('roomList', roomListForAccount(socket.data.account));
      if (typeof acknowledge === 'function') acknowledge({ ok: true, name });
    } catch (error) { console.error('[createRoom error]', error); if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Не вдалося створити кімнату' }); }
  });

  socket.on('joinRoom', async (payload, acknowledge) => {
    try {
      if (!socketIsAuthenticated(socket)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Необхідна авторизація' });
      if (!isObject(payload)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Некоректні дані кімнати' });
      const name = normalizeRoom(payload.name); if (!name) return;
      if (name !== 'general' && name !== 'ai' && !rooms.has(name)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Такої кімнати не існує' });
      const room = rooms.get(name);
      if (room?.passwordHash && !roomAccess.get(socket.data.account.username)?.has(name)) {
        if (!limited(`room-password:${socket.id}:${name}`, 10, 60000)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Забагато спроб пароля' });
        const password = typeof payload.password === 'string' ? payload.password : '';
        if (!(await verifyPassword(password, room.passwordHash))) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Неправильний пароль кімнати' });
        grantRoomAccess(socket.data.account.username, name);
      }
      const nextRoom = name === 'ai' ? aiRoomFor(socket.data.account) : roomId(name); const previousRoom = socket.data.roomId;
      const nick = users[socket.id]?.nick;
      if (previousRoom !== nextRoom) {
        if (nick && !isAiRoom(previousRoom)) emitSystem(previousRoom, `${nick} покинув кімнату`);
        socket.leave(previousRoom); socket.join(nextRoom); socket.data.roomId = nextRoom;
        if (nick && !isAiRoom(nextRoom)) emitSystem(nextRoom, `${nick} приєднався до кімнати`);
      }
      if (users[socket.id]) users[socket.id].roomId = nextRoom;
      const items = await getHistory(nextRoom);
      socket.emit('roomState', { roomId: nextRoom, name: isAiRoom(nextRoom) ? 'Qwen AI' : name, private: false, ai: isAiRoom(nextRoom) }); socket.emit('history', items);
      socket.emit('roomList', roomListForAccount(socket.data.account));
      if (typeof acknowledge === 'function') acknowledge({ ok: true, roomId: nextRoom, name });
    } catch (error) { console.error('[joinRoom error]', error); }
  });

  socket.on('openPrivateChat', async (payload, acknowledge) => {
    try {
      if (!socketIsAuthenticated(socket)) return;
      if (!isObject(payload) || typeof payload.socketId !== 'string' || !users[payload.socketId] || payload.socketId === socket.id) return;
      const targetId = payload.socketId; const nextRoom = `dm:${[socket.id, targetId].sort().join(':')}`; const previousRoom = socket.data.roomId;
      if (previousRoom !== nextRoom) { socket.leave(previousRoom); socket.join(nextRoom); socket.data.roomId = nextRoom; }
      if (users[socket.id]) users[socket.id].roomId = nextRoom;
      const targetSocket = io.sockets.sockets.get(targetId); if (targetSocket) { targetSocket.join(nextRoom); targetSocket.data.roomId = nextRoom; if (users[targetId]) users[targetId].roomId = nextRoom; targetSocket.emit('roomState', { roomId: nextRoom, name: `Приватний чат: ${users[socket.id]?.nick || 'користувач'}`, private: true }); targetSocket.emit('history', await getHistory(nextRoom)); }
      socket.emit('roomState', { roomId: nextRoom, name: `Приватний чат: ${users[targetId].nick}`, private: true }); socket.emit('history', await getHistory(nextRoom));
      if (typeof acknowledge === 'function') acknowledge({ ok: true, roomId: nextRoom });
    } catch (error) { console.error('[private chat error]', error); }
  });

  socket.on('chat message', async (payload) => {
    try {
      if (!socketIsAuthenticated(socket)) return;
      if (!isObject(payload)) return; const text = normalizeText(payload.text); const user = users[socket.id];
      if (!user || !text || !limited(`message:${socket.id}`, 60, 60000)) return;
      const entry = { type: 'message', roomId: socket.data.roomId, text, nick: user.nick, senderId: socket.id, createdAt: Date.now() };
      await saveEntry(entry); io.to(socket.data.roomId).emit('chat message', entry);
      if (aiEnabledInRoom(socket.data.roomId) && ollamaAvailable && limited(`ai-auto:${socket.id}`, 20, 60000)) {
        try {
          const result = await askOllama(`Ти локальний помічник у чаті. Відповідай українською коротко, живо й по суті.\nПовідомлення користувача:\n${text}`);
          const aiEntry = { type: 'message', roomId: socket.data.roomId, text: result, nick: 'Qwen 3.5', senderId: 'local-ai', createdAt: Date.now() };
          await saveEntry(aiEntry); io.to(socket.data.roomId).emit('chat message', aiEntry);
        } catch (error) { console.error('[auto AI error]', error.message); }
      }
    } catch (error) { console.error('[chat message error]', error); }
  });
  socket.on('ai message', async (payload, acknowledge) => {
    try {
      if (!socketIsAuthenticated(socket)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Необхідна авторизація' });
      if (!isObject(payload)) return;
      const text = normalizeText(payload.text); const user = users[socket.id];
      if (!user || !text || !aiEnabledInRoom(socket.data.roomId) || !ollamaAvailable) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Qwen недоступна в цій кімнаті' });
      if (!limited(`ai-socket:${socket.id}`, 20, 60000)) return typeof acknowledge === 'function' && acknowledge({ ok: false, error: 'Забагато AI-запитів' });
      const result = await askOllama(`Ти локальний помічник у чаті. Відповідай українською коротко, живо й по суті.\nПовідомлення користувача:\n${text}`);
      const entry = { type: 'message', roomId: socket.data.roomId, text: result, nick: 'Qwen 3.5', senderId: 'local-ai', createdAt: Date.now() };
      await saveEntry(entry); io.to(socket.data.roomId).emit('chat message', entry);
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    } catch (error) {
      console.error('[ai socket error]', error.message);
      if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Qwen не відповідає' });
    }
  });
  socket.on('userTyping', () => { try { if (!socketIsAuthenticated(socket)) return; const nick = users[socket.id]?.nick; if (nick) socket.to(socket.data.roomId).emit('userTyping', nick); } catch (error) { console.error('[typing error]', error); } });
  socket.on('stopTyping', () => { try { if (socketIsAuthenticated(socket)) socket.to(socket.data.roomId).emit('stopTyping'); } catch (error) { console.error('[stopTyping error]', error); } });
  socket.on('disconnect', () => { try { const nick = users[socket.id]?.nick; if (nick) emitSystem(socket.data.roomId, `${nick} покинув чат`); delete users[socket.id]; io.emit('onlineUsers', onlineUsers()); } catch (error) { console.error('[disconnect error]', error); } });
});

connectMongo();
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && error.body) return res.status(400).json({ error: 'Некоректний JSON' });
  return next(error);
});
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`Pepegram запущено на http://localhost:${PORT}; модель: ${AI_MODEL}`));
