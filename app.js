// ═══════════════════════════════════════
//  PEPEGRAM — app.js
// ═══════════════════════════════════════

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// Парсимо JSON-тіло запитів
app.use(express.json());

// Роздаємо статику з папки public
app.use(express.static(__dirname + '/public'));

// ── Перефразування через Ollama (Qwen 2.5) ─────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.QWEN_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b';

const REPHRASE_PROMPTS = {
  formal:   'Перефразуй наступний текст у формальному, діловому стилі. Виведи ТІЛЬКИ перефразований текст без пояснень.',
  casual:   'Перефразуй наступний текст у розмовному, дружньому стилі. Виведи ТІЛЬКИ перефразований текст без пояснень.',
  shorter:  'Скороти наступний текст, зберігши головну думку. Виведи ТІЛЬКИ скорочений текст без пояснень.',
  longer:   'Розгорни наступний текст, додавши деталі та пояснення. Виведи ТІЛЬКИ розгорнутий текст без пояснень.',
  emoji:    'Додай доречні емодзі до наступного тексту, зроби його живішим. Виведи ТІЛЬКИ текст з емодзі без пояснень.',
  confident:'Перефразуй наступний текст впевнено та переконливо. Виведи ТІЛЬКИ перефразований текст без пояснень.',
};

const UKRAINIAN_LANGUAGE_RULES = `
КРИТЕРІЇ МОВИ:
1. Відповідь має бути лише українською мовою та українською кирилицею.
2. Не використовуй російські слова, русизми, кальки або суржик.
3. Не змінюй зміст, факти, числа, імена, назви, посилання, @нікнейми та фрагменти коду.
4. Збережи тон і форматування, якщо обраний стиль не вимагає їх зміни.
5. Виведи тільки готовий перефразований текст, без вступу, пояснень, лапок і приміток.
`;

app.post('/api/rephrase', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const style = typeof req.body?.style === 'string' ? req.body.style : '';
  if (!text || !style) {
    return res.status(400).json({ error: 'Потрібні поля text та style' });
  }

  const systemPrompt = REPHRASE_PROMPTS[style];
  if (!systemPrompt) {
    return res.status(400).json({ error: 'Невідомий стиль' });
  }

  try {
    const ollamaRes = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `${UKRAINIAN_LANGUAGE_RULES}\n${systemPrompt}\n\nТекст: ${text}`,
        stream: false,
        options: { temperature: 0.7, num_predict: 300 }
      })
    });

    if (!ollamaRes.ok) {
      throw new Error(`Ollama: ${ollamaRes.status}`);
    }

    const data = await ollamaRes.json();
    const result = (data.response || '').trim();
    if (!result) throw new Error('Модель не повернула результат');
    res.json({ result });
  } catch (err) {
    console.error('[rephrase error]', err.message);
    res.status(500).json({ error: 'Помилка AI: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Зберігаємо онлайн-користувачів: socketId -> nick
const users = {};

io.on('connection', (socket) => {
  console.log(`[+] Підключено: ${socket.id}`);

  // ── Встановити нікнейм ──────────────────────────────────────
  socket.on('setUsername', (nick) => {
    const oldNick = users[socket.id];
    users[socket.id] = nick;

    if (oldNick && oldNick !== nick) {
      // Повідомляємо всіх про зміну ніку
      io.emit('system', `${oldNick} змінив нік на ${nick}`);
    } else if (!oldNick) {
      // Новий користувач зайшов
      io.emit('system', `${nick} приєднався до чату 👋`);
    }

    // Оновлюємо список онлайн для всіх
    io.emit('onlineUsers', Object.values(users));
  });

  // ── Повідомлення в чат ──────────────────────────────────────
  socket.on('chat message', ({ text, nick }) => {
    io.emit('chat message', { text, nick });
  });

  // ── Typing Indicator ────────────────────────────────────────
  socket.on('userTyping', (nick) => {
    socket.broadcast.emit('userTyping', nick);
  });

  socket.on('stopTyping', () => {
    socket.broadcast.emit('stopTyping');
  });

  // ── Відключення ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    const nick = users[socket.id];
    if (nick) {
      io.emit('system', `${nick} покинув чат`);
    }
    delete users[socket.id];
    io.emit('onlineUsers', Object.values(users));
    console.log(`[-] Відключено: ${socket.id} (${nick || 'анонім'})`);
  });
});

// Запускаємо сервер
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log('🐸 Pepegram запущено на http://localhost:3000');
});
