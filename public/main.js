let myNick = '';
let soundMuted = false;
let typingTimer;
let isTyping = false;
let ollamaAvailable = false;

const socket = io();
const $ = (id) => document.getElementById(id);
const authOverlay = $('authOverlay');
const authUsernameInput = $('authUsernameInput') || $('authNickInput');
const authEnterBtn = $('authEnterBtn');
const authForm = authOverlay.querySelector('.auth-form');
const authLabel = authForm.querySelector('label');
if (authLabel) { authLabel.textContent = 'Логін'; authLabel.htmlFor = 'authUsernameInput'; }
authUsernameInput.placeholder = 'Логін';
const authPasswordInput = document.createElement('input');
authPasswordInput.type = 'password'; authPasswordInput.placeholder = 'Пароль (мінімум 8 символів)'; authPasswordInput.minLength = 8; authPasswordInput.maxLength = 128; authPasswordInput.autocomplete = 'current-password';
authForm.insertBefore(authPasswordInput, authEnterBtn);
const authError = document.createElement('div'); authError.className = 'auth-error'; authForm.insertBefore(authError, authEnterBtn);
const authModeBtn = document.createElement('button'); authModeBtn.type = 'button'; authModeBtn.className = 'auth-mode-btn'; authModeBtn.textContent = 'Створити акаунт'; authForm.appendChild(authModeBtn);
let registrationMode = false;
const logoutBtn = document.createElement('button');
logoutBtn.type = 'button'; logoutBtn.className = 'logout-btn'; logoutBtn.textContent = 'Вийти з акаунта';
document.querySelector('.sidebar-bottom')?.appendChild(logoutBtn);
logoutBtn.addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); socket.disconnect(); window.location.reload(); });
const app = $('app');
const form = $('form');
const input = $('input');
const messagesList = $('messages');
const messagesWrap = $('messagesWrap');
const userList = $('userList');
const typingStatus = $('typingStatus');
const onlineCount = $('onlineCount');
const myNickDisplay = $('myNickDisplay');
const myAvatar = $('myAvatar');
const changeNickBtn = $('changeNickBtn');
const muteBtn = $('muteBtn');
const emojiBtn = $('emojiBtn');
const emojiPicker = $('emojiPicker');
const bgPicker = $('bgPicker');
const chatMain = document.querySelector('.chat-main');
const hamburgerBtn = $('hamburgerBtn');
const sidebarBackdrop = $('sidebarBackdrop');
const sidebar = document.querySelector('.sidebar');
const roomForm = document.getElementById('roomForm');
const roomInput = document.getElementById('roomInput');
const generalRoomBtn = document.getElementById('generalRoomBtn');
const roomSubmitBtn = roomForm?.querySelector('button[type="submit"]');
const roomPasswordInput = document.createElement('input');
roomPasswordInput.type = 'password'; roomPasswordInput.maxLength = 128; roomPasswordInput.placeholder = 'пароль нової кімнати'; roomPasswordInput.autocomplete = 'new-password';
roomForm?.insertBefore(roomPasswordInput, roomSubmitBtn);
if (roomSubmitBtn) roomSubmitBtn.textContent = 'Створити';
const roomListElement = document.createElement('ul'); roomListElement.className = 'room-list'; roomListElement.id = 'roomList';
generalRoomBtn?.parentElement?.appendChild(roomListElement);
const headerTitle = document.querySelector('.header-title');
const aiRoomBtn = document.createElement('button');
aiRoomBtn.type = 'button'; aiRoomBtn.className = 'ai-room-btn'; aiRoomBtn.textContent = '🤖 Qwen AI';
generalRoomBtn?.parentElement?.insertBefore(aiRoomBtn, generalRoomBtn);
aiRoomBtn.addEventListener('click', () => socket.emit('joinRoom', { name: 'ai' }));
const rephraseBtn = $('rephraseBtn');
const rephrasePanel = $('rephrasePanel');
const rephrasePanelClose = $('rephrasePanelClose');
const rephrasePreview = $('rephrasePreview');
const rephraseActions = $('rephraseActions');
const rephraseApplyBtn = $('rephraseApplyBtn');
const rephraseRetryBtn = $('rephraseRetryBtn');
const styleButtons = [...document.querySelectorAll('.rephrase-style-btn')];
let lastRephraseStyle = null;
let lastRephraseResult = '';

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;
function playSound(start, end, volume, duration) {
  if (soundMuted || !AudioCtx) return;
  audioCtx ||= new AudioCtx();
  const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
  osc.connect(gain); gain.connect(audioCtx.destination); osc.type = 'sine';
  osc.frequency.setValueAtTime(start, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(end, audioCtx.currentTime + duration * 0.7);
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.start(); osc.stop(audioCtx.currentTime + duration + 0.02);
}
const playSendSound = () => playSound(880, 440, 0.18, 0.18);
const playReceiveSound = () => playSound(660, 880, 0.12, 0.15);

function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('visible'); document.body.style.overflow = 'hidden'; }
function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('visible'); document.body.style.overflow = ''; }
hamburgerBtn.addEventListener('click', () => sidebar.classList.contains('open') ? closeSidebar() : openSidebar());
sidebarBackdrop.addEventListener('click', closeSidebar);
function closeSidebarOnMobile() { if (window.innerWidth <= 768) closeSidebar(); }

function updateIdentity() {
  myNickDisplay.textContent = myNick;
  myAvatar.textContent = myNick.charAt(0).toUpperCase();
}

function submitNick(value, { initial = false, onSuccess = () => {}, onError = () => {} } = {}) {
  const candidate = String(value || '').trim().slice(0, 20);
  if (!candidate) return onError('Нік не може бути порожнім');
  socket.emit('setUsername', { nick: candidate }, (result) => {
    if (!result || !result.ok) return onError(result?.error || 'Не вдалося встановити нік');
    myNick = result.nick;
    localStorage.setItem('pepegram_nick', myNick);
    updateIdentity();
    if (initial) { authOverlay.style.display = 'none'; app.style.display = 'flex'; }
    onSuccess();
  });
}

function activateChat(username) {
  myNick = username; localStorage.setItem('pepegram_nick', myNick); updateIdentity();
  authOverlay.style.display = 'none'; app.style.display = 'flex';
}
async function enterChat() {
  authError.textContent = '';
  const username = authUsernameInput.value.trim(); const password = authPasswordInput.value;
  if (!username || !password) { authError.textContent = 'Вкажіть логін і пароль'; return; }
  try {
    const endpoint = registrationMode ? '/api/auth/register' : '/api/auth/login';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Помилка авторизації');
    window.location.reload();
    return;
    if (registrationMode) {
      window.location.reload();
      return;
      /* The page reload establishes the new session before Socket.IO reconnects. */
      registrationMode = false;
      authEnterBtn.textContent = 'Увійти в чат →';
      authModeBtn.textContent = 'Створити акаунт';
      authPasswordInput.value = '';
      authError.textContent = 'Акаунт створено. Тепер увійдіть із цим логіном і паролем.';
      return;
    }
    socket.emit('authenticate', (result) => {
      if (!result?.ok) { authError.textContent = result?.error || 'Сесія не підтверджена'; return; }
      activateChat(username);
      socket.emit('setUsername', { nick: username }, (nickResult) => {
        if (!nickResult?.ok) { authError.textContent = nickResult?.error || 'Не вдалося підтвердити нік'; socket.disconnect(); }
      });
    });
  } catch (error) { authError.textContent = error.message; }
}
authEnterBtn.addEventListener('click', enterChat);
authModeBtn.addEventListener('click', () => { registrationMode = !registrationMode; authEnterBtn.textContent = registrationMode ? 'Зареєструватися' : 'Увійти в чат →'; authModeBtn.textContent = registrationMode ? 'У мене вже є акаунт' : 'Створити акаунт'; authPasswordInput.autocomplete = registrationMode ? 'new-password' : 'current-password'; });
authUsernameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') enterChat(); });
authPasswordInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') enterChat(); });

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim().slice(0, 500);
  if (!text || !myNick) return;
  socket.emit('chat message', { text });
  playSendSound(); input.value = '';
  if (isTyping) { isTyping = false; socket.emit('stopTyping'); }
});
roomForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = roomInput.value.trim();
  if (!name) return;
  socket.emit('createRoom', { name, password: roomPasswordInput.value }, (result) => {
    if (result?.ok) { roomInput.value = ''; roomPasswordInput.value = ''; closeSidebarOnMobile(); }
    else addSystemMessage(result?.error || 'Не вдалося створити кімнату');
  });
});
generalRoomBtn?.addEventListener('click', () => socket.emit('joinRoom', { name: 'general' }));

input.addEventListener('input', () => {
  if (!myNick) return;
  if (!isTyping) { isTyping = true; socket.emit('userTyping'); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { isTyping = false; socket.emit('stopTyping'); }, 1800);
});

socket.on('connect', async () => {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) return;
    const data = await response.json();
    socket.emit('authenticate', (result) => {
      if (result?.ok) {
        activateChat(data.username);
        socket.emit('setUsername', { nick: data.username }, (nickResult) => { if (!nickResult?.ok) socket.disconnect(); });
      }
    });
  } catch { /* Сервер авторизації ще недоступний. */ }
});
socket.on('history', (items) => {
  messagesList.replaceChildren();
  if (Array.isArray(items)) items.forEach((item) => renderEvent(item, false));
  scrollToBottom();
});
socket.on('roomState', (state = {}) => {
  if (headerTitle && typeof state.name === 'string') headerTitle.textContent = state.name;
  aiRoomBtn.classList.toggle('active', state.ai === true);
  generalRoomBtn?.classList.toggle('active', state.name === 'general');
});
socket.on('roomList', (items) => {
  roomListElement.replaceChildren();
  if (!Array.isArray(items)) return;
  items.filter((room) => room && typeof room.name === 'string' && room.name !== 'general').forEach((room) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'room-list-item';
    button.textContent = `${room.protected ? '🔒 ' : ''}${room.title || room.name}${room.creator && room.creator !== 'system' ? ` · ${room.creator}` : ''}`;
    button.title = room.protected ? 'Захищена паролем кімната' : 'Відкрита кімната';
    button.addEventListener('click', () => {
      const password = room.protected && !room.unlocked ? window.prompt(`Пароль кімнати «${room.title || room.name}»:`) : '';
      if (room.protected && password === null) return;
      socket.emit('joinRoom', { name: room.name, password }, (result) => { if (!result?.ok) addSystemMessage(result?.error || 'Не вдалося увійти в кімнату'); });
    });
    const item = document.createElement('li'); item.appendChild(button); roomListElement.appendChild(item);
  });
});
socket.on('chat message', (item) => renderEvent(item, true));
socket.on('system', (item) => addSystemMessage(typeof item === 'object' ? item.text : item));
socket.on('onlineUsers', (items) => {
  userList.replaceChildren();
  const list = Array.isArray(items) ? items : [];
  list.forEach((item) => {
    const nick = typeof item === 'object' ? item.nick : item;
    if (typeof nick !== 'string') return;
    const li = document.createElement('li');
    const avatar = document.createElement('span'); avatar.className = 'u-avatar'; avatar.textContent = nick.charAt(0).toUpperCase();
    const name = document.createElement('span'); name.textContent = nick;
    const dot = document.createElement('span'); dot.className = 'u-dot';
    li.append(avatar, name, dot);
    if (typeof item === 'object' && item.id && item.id !== socket.id) {
      li.title = 'Відкрити приватний чат';
      li.addEventListener('click', () => socket.emit('openPrivateChat', { socketId: item.id }));
    }
    userList.appendChild(li);
  });
  onlineCount.textContent = `${list.length} онлайн`;
});
socket.on('userTyping', (nick) => { if (typeof nick === 'string' && nick !== myNick) typingStatus.textContent = `${nick} друкує...`; });
socket.on('stopTyping', () => { typingStatus.textContent = ''; });
socket.on('ollamaStatus', ({ available } = {}) => setOllamaAvailability(Boolean(available)));

function renderEvent(item, playSoundOnMessage) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'system') return addSystemMessage(item.text);
  const text = typeof item.text === 'string' ? item.text : '';
  const nick = typeof item.nick === 'string' ? item.nick : 'Невідомий';
  const own = item.senderId === socket.id;
  addMessage(text, nick, own ? 'outgoing' : 'incoming', item.createdAt);
  if (playSoundOnMessage && !own) playReceiveSound();
}
function addMessage(text, nick, direction, createdAt) {
  const li = document.createElement('li'); li.className = `msg-item ${direction}`;
  const name = document.createElement('div'); name.className = 'msg-nick'; name.textContent = nick;
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble'; bubble.textContent = text;
  const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = new Date(createdAt || Date.now()).toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' });
  li.append(name, bubble, time); messagesList.appendChild(li); scrollToBottom();
}
function addSystemMessage(text) {
  const li = document.createElement('li'); li.className = 'msg-item system';
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble'; bubble.textContent = typeof text === 'string' ? text : '';
  li.appendChild(bubble); messagesList.appendChild(li); scrollToBottom();
}
function scrollToBottom() { messagesWrap.scrollTop = messagesWrap.scrollHeight; }
authUsernameInput
changeNickBtn.addEventListener('click', showNickModal);
function showNickModal() {
  const overlay = document.createElement('div'); overlay.className = 'nick-modal-overlay';
  const modal = document.createElement('div'); modal.className = 'nick-modal';
  const title = document.createElement('h3'); title.textContent = '✏️ Змінити нікнейм';
  const newInput = document.createElement('input'); newInput.type = 'text'; newInput.maxLength = 20; newInput.value = myNick; newInput.placeholder = 'Новий нік...';
  const actions = document.createElement('div'); actions.className = 'nick-modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'btn-cancel'; cancel.textContent = 'Скасувати';
  const save = document.createElement('button'); save.className = 'btn-save'; save.textContent = 'Зберегти';
  const error = document.createElement('div'); error.className = 'nick-error';
  actions.append(cancel, save); modal.append(title, newInput, error, actions); overlay.appendChild(modal); document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const saveNick = () => submitNick(newInput.value, { onSuccess: close, onError: (message) => { error.textContent = message; } });
  cancel.addEventListener('click', close); save.addEventListener('click', saveNick);
  newInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') saveNick(); if (event.key === 'Escape') close(); });
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); }); newInput.focus(); newInput.select();
}

muteBtn.addEventListener('click', () => { soundMuted = !soundMuted; muteBtn.textContent = soundMuted ? '🔕' : '🔔'; });
emojiBtn.addEventListener('click', (event) => { event.stopPropagation(); emojiPicker.classList.toggle('open'); });
emojiPicker.querySelectorAll('span').forEach((span) => span.addEventListener('click', () => { input.value += span.textContent; input.focus(); emojiPicker.classList.remove('open'); }));
document.addEventListener('click', () => emojiPicker.classList.remove('open'));

const wpClasses = ['wp-gradient1', 'wp-gradient2', 'wp-gradient3', 'wp-dark'];
document.querySelectorAll('.wp-btn').forEach((button) => button.addEventListener('click', (event) => {
  if (button.dataset.wp === 'custom') return; event.stopPropagation();
  document.querySelectorAll('.wp-btn').forEach((item) => item.classList.remove('active')); button.classList.add('active');
  chatMain.classList.remove(...wpClasses, 'wp-custom'); chatMain.style.background = '';
  if (button.dataset.wp !== 'default') chatMain.classList.add(`wp-${button.dataset.wp}`);
  localStorage.setItem('pepegram_wp', button.dataset.wp); closeSidebarOnMobile();
}));
bgPicker.addEventListener('input', () => { chatMain.classList.remove(...wpClasses, 'wp-custom'); chatMain.style.background = bgPicker.value; document.querySelectorAll('.wp-btn').forEach((b) => b.classList.remove('active')); document.querySelector('.wp-btn[data-wp="custom"]').classList.add('active'); localStorage.setItem('pepegram_wp', `custom:${bgPicker.value}`); });

function setOllamaAvailability(available) {
  ollamaAvailable = available; rephraseBtn.disabled = !available; rephraseBtn.title = available ? 'Перефразувати' : 'Ollama недоступна';
  styleButtons.forEach((button) => { button.disabled = !available; });
}
rephraseBtn.addEventListener('click', () => { if (ollamaAvailable) { rephrasePanel.classList.toggle('open'); rephraseBtn.classList.toggle('active'); if (rephrasePanel.classList.contains('open')) resetRephrasePreview(); } });
rephrasePanelClose.addEventListener('click', () => { rephrasePanel.classList.remove('open'); rephraseBtn.classList.remove('active'); });
function resetRephrasePreview() { rephrasePreview.className = 'rephrase-preview'; rephrasePreview.replaceChildren(); const placeholder = document.createElement('span'); placeholder.className = 'rephrase-preview-placeholder'; placeholder.textContent = 'Введи текст у поле і натисни стиль ↓'; rephrasePreview.appendChild(placeholder); rephraseActions.style.display = 'none'; lastRephraseResult = ''; lastRephraseStyle = null; styleButtons.forEach((b) => b.classList.remove('active')); }
function setRephraseLoading(loading) { rephrasePreview.className = loading ? 'rephrase-preview loading' : 'rephrase-preview'; rephrasePreview.replaceChildren(); if (loading) { const spinner = document.createElement('div'); spinner.className = 'rephrase-spinner'; const label = document.createElement('span'); label.textContent = 'Qwen думає...'; rephrasePreview.append(spinner, label); } styleButtons.forEach((b) => { b.disabled = loading || !ollamaAvailable; }); rephraseActions.style.display = 'none'; }
styleButtons.forEach((button) => button.addEventListener('click', async () => {
  if (!ollamaAvailable) return;
  const text = input.value.trim().slice(0, 500); if (!text) { rephrasePreview.textContent = '⚠️ Спочатку введи текст у поле вводу'; return; }
  styleButtons.forEach((b) => b.classList.remove('active')); button.classList.add('active'); lastRephraseStyle = button.dataset.style; setRephraseLoading(true);
  try { const response = await fetch('/api/rephrase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, style: lastRephraseStyle }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Помилка сервера'); lastRephraseResult = data.result; setRephraseLoading(false); rephrasePreview.textContent = lastRephraseResult; rephraseActions.style.display = 'flex'; }
  catch (error) { setRephraseLoading(false); rephrasePreview.textContent = `❌ ${error.message}`; }
}));
rephraseApplyBtn.addEventListener('click', () => { if (lastRephraseResult) { input.value = lastRephraseResult; input.focus(); rephrasePanel.classList.remove('open'); input.dispatchEvent(new Event('input')); } });
rephraseRetryBtn.addEventListener('click', () => { const button = styleButtons.find((item) => item.dataset.style === lastRephraseStyle); if (button) button.click(); });


