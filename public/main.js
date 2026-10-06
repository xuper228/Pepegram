
let myNick    = '';
let soundMuted = false;
let typingTimer;
let isTyping   = false;

// ── Аудіо контекст (Web Audio API) ────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function ensureAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
}

/** Програємо невеликий звук «дзінь» при відправці */
function playSendSound() {
  if (soundMuted) return;
  ensureAudio();
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.12);
  gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.2);
}

/** Програємо звук «поп» при отриманні повідомлення */
function playReceiveSound() {
  if (soundMuted) return;
  ensureAudio();
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.08);
  gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.18);
}

// ── Socket.IO ──────────────────────────────────────────────────────
const socket = io();

// ── DOM-елементи ───────────────────────────────────────────────────
const authOverlay    = document.getElementById('authOverlay');
const authNickInput  = document.getElementById('authNickInput');
const authEnterBtn   = document.getElementById('authEnterBtn');

const app            = document.getElementById('app');
const form           = document.getElementById('form');
const input          = document.getElementById('input');
const messagesList   = document.getElementById('messages');
const messagesWrap   = document.getElementById('messagesWrap');
const userList       = document.getElementById('userList');
const typingStatus   = document.getElementById('typingStatus');
const onlineCount    = document.getElementById('onlineCount');
const myNickDisplay  = document.getElementById('myNickDisplay');
const myAvatar       = document.getElementById('myAvatar');
const changeNickBtn  = document.getElementById('changeNickBtn');
const muteBtn        = document.getElementById('muteBtn');
const emojiBtn       = document.getElementById('emojiBtn');
const emojiPicker    = document.getElementById('emojiPicker');
const bgPicker       = document.getElementById('bgPicker');
const chatMain       = document.querySelector('.chat-main');
const hamburgerBtn   = document.getElementById('hamburgerBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const sidebar        = document.querySelector('.sidebar');

// ── Мобільний сайдбар (drawer) ─────────────────────────────────────
function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('visible');
  document.body.style.overflow = '';
}

hamburgerBtn.addEventListener('click', () => {
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});

sidebarBackdrop.addEventListener('click', closeSidebar);

// Закриваємо сайдбар при виборі шпалер / нікнейму на мобільному
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) closeSidebar();
}


// ── Авторизація ─────────────────────────────────────────────────────
function enterChat(nick) {
  myNick = nick.trim();
  if (!myNick) return;

  // Зберігаємо нік у localStorage
  localStorage.setItem('pepegram_nick', myNick);

  // Оновлюємо UI
  myNickDisplay.textContent = myNick;
  myAvatar.textContent      = myNick[0].toUpperCase();

  // Відправляємо нік серверу
  socket.emit('setUsername', myNick);

  // Показуємо чат
  authOverlay.style.display = 'none';
  app.style.display         = 'flex';

  // Системне повідомлення

}

authEnterBtn.addEventListener('click', () => {
  enterChat(authNickInput.value);
});

authNickInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterChat(authNickInput.value);
});

// Відновлення ніку з localStorage
const savedNick = localStorage.getItem('pepegram_nick');
if (savedNick) {
  authNickInput.value = savedNick;
}

// ── Відправка повідомлення ─────────────────────────────────────────
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  socket.emit('chat message', { text, nick: myNick });
  playSendSound();
  input.value = '';

  // Зупиняємо typing indicator
  if (isTyping) {
    isTyping = false;
    socket.emit('stopTyping');
  }
});

// ── Typing Indicator ───────────────────────────────────────────────
input.addEventListener('input', () => {
  if (!myNick) return;

  if (!isTyping) {
    isTyping = true;
    socket.emit('userTyping', myNick);
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    socket.emit('stopTyping');
  }, 1800);
});

// ── Socket events ──────────────────────────────────────────────────

/** Отримуємо повідомлення */
socket.on('chat message', ({ text, nick }) => {
  const isOwn = nick === myNick;
  addMessage(text, nick, isOwn ? 'outgoing' : 'incoming');
  if (!isOwn) playReceiveSound();
});

/** Список онлайн-користувачів */
socket.on('onlineUsers', (users) => {
  userList.innerHTML = '';
  users.forEach(u => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="u-avatar">${u[0].toUpperCase()}</span>
      <span>${u}</span>
      <span class="u-dot"></span>
    `;
    userList.appendChild(li);
  });
  const count = users.length;
  onlineCount.textContent = `${count} ${pluralUsers(count)}`;
});

/** Typing indicator від інших */
socket.on('userTyping', (nick) => {
  if (nick === myNick) return;
  typingStatus.textContent = `${nick} друкує...`;
});

socket.on('stopTyping', () => {
  typingStatus.textContent = '';
});

/** Системні повідомлення з сервера */
socket.on('system', (msg) => {
  addSystemMessage(msg);
});

// ── Допоміжні функції ──────────────────────────────────────────────

function addMessage(text, nick, direction) {
  const li = document.createElement('li');
  li.className = `msg-item ${direction}`;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' });

  li.innerHTML = `
    <div class="msg-nick">${escapeHtml(nick)}</div>
    <div class="msg-bubble">${escapeHtml(text)}</div>
    <div class="msg-time">${timeStr}</div>
  `;
  messagesList.appendChild(li);
  scrollToBottom();
}

function addSystemMessage(text) {
  const li = document.createElement('li');
  li.className = 'msg-item system';
  li.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  messagesList.appendChild(li);
  scrollToBottom();
}

function scrollToBottom() {
  messagesWrap.scrollTop = messagesWrap.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pluralUsers(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'онлайн';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'онлайн';
  return 'онлайн';
}

// ── Зміна нікнейму (модалка) ───────────────────────────────────────
changeNickBtn.addEventListener('click', () => {
  showNickModal();
});

function showNickModal() {
  const overlay = document.createElement('div');
  overlay.className = 'nick-modal-overlay';
  overlay.innerHTML = `
    <div class="nick-modal">
      <h3>✏️ Змінити нікнейм</h3>
      <input id="newNickInput" type="text" placeholder="Новий нік..." maxlength="20" value="${escapeHtml(myNick)}" />
      <div class="nick-modal-actions">
        <button class="btn-cancel" id="nickCancelBtn">Скасувати</button>
        <button class="btn-save"   id="nickSaveBtn">Зберегти</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const newNickInput = overlay.querySelector('#newNickInput');
  newNickInput.focus();
  newNickInput.select();

  overlay.querySelector('#nickCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#nickSaveBtn').addEventListener('click', () => saveNewNick(overlay, newNickInput));
  newNickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  saveNewNick(overlay, newNickInput);
    if (e.key === 'Escape') overlay.remove();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function saveNewNick(overlay, inp) {
  const newNick = inp.value.trim();
  if (!newNick || newNick === myNick) { overlay.remove(); return; }

  const oldNick = myNick;
  myNick = newNick;
  localStorage.setItem('pepegram_nick', myNick);
  myNickDisplay.textContent = myNick;
  myAvatar.textContent      = myNick[0].toUpperCase();

  socket.emit('setUsername', myNick);
  addSystemMessage(`Ви змінили нік: ${oldNick} → ${myNick}`);
  overlay.remove();
}

// ── Mute Button ─────────────────────────────────────────────────────
muteBtn.addEventListener('click', () => {
  soundMuted = !soundMuted;
  muteBtn.textContent = soundMuted ? '🔕' : '🔔';
  muteBtn.title = soundMuted ? 'Увімкнути звук' : 'Вимкнути звук';
});

// ── Emoji Picker ────────────────────────────────────────────────────
emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle('open');
});

emojiPicker.querySelectorAll('span').forEach(span => {
  span.addEventListener('click', () => {
    input.value += span.textContent;
    input.focus();
    emojiPicker.classList.remove('open');
  });
});

document.addEventListener('click', () => emojiPicker.classList.remove('open'));

// ── Wallpaper ───────────────────────────────────────────────────────
const wpClasses = ['wp-gradient1', 'wp-gradient2', 'wp-gradient3', 'wp-dark'];

document.querySelectorAll('.wp-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    // Якщо це кнопка з color input — не перехоплюємо
    if (btn.dataset.wp === 'custom') return;

    e.stopPropagation();
    document.querySelectorAll('.wp-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Знімаємо всі wp-класи
    chatMain.classList.remove(...wpClasses, 'wp-custom');
    chatMain.style.background = '';

    if (btn.dataset.wp !== 'default') {
      chatMain.classList.add(`wp-${btn.dataset.wp}`);
    }

    localStorage.setItem('pepegram_wp', btn.dataset.wp);
    closeSidebarOnMobile();
  });
});

// Кастомний колір
bgPicker.addEventListener('input', () => {
  chatMain.classList.remove(...wpClasses, 'wp-custom');
  chatMain.style.background = bgPicker.value;

  // Активна кнопка
  document.querySelectorAll('.wp-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.wp-btn[data-wp="custom"]').classList.add('active');
  localStorage.setItem('pepegram_wp', 'custom:' + bgPicker.value);
});

// Відновлення шпалер
const savedWp = localStorage.getItem('pepegram_wp');
if (savedWp) {
  if (savedWp.startsWith('custom:')) {
    const color = savedWp.slice(7);
    bgPicker.value = color;
    chatMain.style.background = color;
    document.querySelector('.wp-btn[data-wp="custom"]').classList.add('active');
    document.querySelector('.wp-btn[data-wp="default"]').classList.remove('active');
  } else if (savedWp !== 'default') {
    const btn = document.querySelector(`.wp-btn[data-wp="${savedWp}"]`);
    if (btn) btn.click();
  }
}


// ── Rephrase (✨) ────────────────────────────────────────────────────
const rephraseBtn        = document.getElementById('rephraseBtn');
const rephrasePanel      = document.getElementById('rephrasePanel');
const rephrasePanelClose = document.getElementById('rephrasePanelClose');
const rephrasePreview    = document.getElementById('rephrasePreview');
const rephraseActions    = document.getElementById('rephraseActions');
const rephraseApplyBtn   = document.getElementById('rephraseApplyBtn');
const rephraseRetryBtn   = document.getElementById('rephraseRetryBtn');

let lastRephraseStyle  = null;
let lastRephraseResult = '';

/** Відкрити/закрити панель */
rephraseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = rephrasePanel.classList.contains('open');
  if (isOpen) {
    closeRephrasePanel();
  } else {
    openRephrasePanel();
  }
});

rephrasePanelClose.addEventListener('click', closeRephrasePanel);

function openRephrasePanel() {
  rephrasePanel.classList.add('open');
  rephraseBtn.classList.add('active');
  // Скидаємо стан якщо текст змінився
  resetRephrasePreview();
}

function closeRephrasePanel() {
  rephrasePanel.classList.remove('open');
  rephraseBtn.classList.remove('active');
}

function resetRephrasePreview() {
  rephrasePreview.className = 'rephrase-preview';
  rephrasePreview.innerHTML = '<span class="rephrase-preview-placeholder">Введи текст у поле і натисни стиль ↓</span>';
  rephraseActions.style.display = 'none';
  lastRephraseResult = '';
  lastRephraseStyle  = null;
  document.querySelectorAll('.rephrase-style-btn').forEach(b => b.classList.remove('active'));
}

/** Клік по стилю перефразування */
document.querySelectorAll('.rephrase-style-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const style = btn.dataset.style;
    const text  = input.value.trim();

    if (!text) {
      rephrasePreview.innerHTML = '<span class="rephrase-preview-placeholder">⚠️ Спочатку введи текст у поле вводу</span>';
      return;
    }

    // Позначаємо активний стиль
    document.querySelectorAll('.rephrase-style-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    lastRephraseStyle = style;

    // Стан завантаження
    setRephraseLoading(true);

    try {
      const res = await fetch('/api/rephrase', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, style })
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Помилка сервера');
      }

      lastRephraseResult = data.result;
      showRephraseResult(data.result);
    } catch (err) {
      setRephraseLoading(false);
      rephrasePreview.classList.remove('loading');
      rephrasePreview.innerHTML = `<span style="color:#e05252">❌ ${escapeHtml(err.message)}</span>`;
      rephraseActions.style.display = 'none';
    }
  });
});

function setRephraseLoading(on) {
  if (on) {
    rephrasePreview.className = 'rephrase-preview loading';
    rephrasePreview.innerHTML = '<div class="rephrase-spinner"></div><span>Qwen думає...</span>';
    rephraseActions.style.display = 'none';
    // Блокуємо кнопки під час завантаження
    document.querySelectorAll('.rephrase-style-btn').forEach(b => b.disabled = true);
  } else {
    rephrasePreview.className = 'rephrase-preview';
    document.querySelectorAll('.rephrase-style-btn').forEach(b => b.disabled = false);
  }
}

function showRephraseResult(text) {
  setRephraseLoading(false);
  rephrasePreview.textContent = text;
  rephraseActions.style.display = 'flex';
}

/** Застосувати результат у поле вводу */
rephraseApplyBtn.addEventListener('click', () => {
  if (!lastRephraseResult) return;
  input.value = lastRephraseResult;
  input.focus();
  closeRephrasePanel();
  // Тригеримо typing indicator щоб оновити placeholder
  input.dispatchEvent(new Event('input'));
});

/** Перегенерувати з тим же стилем */
rephraseRetryBtn.addEventListener('click', () => {
  if (!lastRephraseStyle) return;
  const btn = document.querySelector(`.rephrase-style-btn[data-style="${lastRephraseStyle}"]`);
  if (btn) btn.click();
});

/** Закрити панель при кліку поза нею */
document.addEventListener('click', (e) => {
  if (
    rephrasePanel.classList.contains('open') &&
    !rephrasePanel.contains(e.target) &&
    e.target !== rephraseBtn
  ) {
    closeRephrasePanel();
  }
});
