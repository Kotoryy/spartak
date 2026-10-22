'use strict';

// ---------- Настройки ----------
const API = 'https://spartak-api.kotoryy.ru'; // облачный сервер из папки cloud/
// Зеркало данных на GitHub: в России соединения с Cloudflare обрываются после ~16 КБ, а GitHub открывается.
// Сервер раз в минуту-пять кладёт туда снимок под именем текущей минуты (см. cloud/src/mirror.js).
const MIRROR = 'https://raw.githubusercontent.com/Kotoryy/spartak-data/main/s/';
const TEAM_ID = '1941';
const DATA_KEY = 'spartak-data-v2';
const SETTINGS_KEY = 'spartak-settings';
const POLL_IDLE_MS = 5 * 60 * 1000;
const POLL_LIVE_MS = 20 * 1000;
const MIN = 60 * 1000;
const desk = window.desktop || null; // мост из программы для ПК (preload.js)

// ---------- Утилиты ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, def) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* хранилище недоступно */ } },
};

const fmtWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtMon = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
const fmtWdShort = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const fmtShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// У ESPN устаревшая эмблема «Спартака» с одной звездой — подставляем свою, с четырьмя (tools/make-crest.py)
const CREST = 'icons/spartak-crest.png';
function withCrest(d) {
  if (!d) return d;
  for (const m of d.matches || []) for (const t of [m.home, m.away]) if (t && t.id === TEAM_ID) t.logo = CREST;
  for (const r of d.table || []) if (r.id === TEAM_ID) r.logo = CREST;
  return d;
}

let data = withCrest(store.get(DATA_KEY, null)); // { updated, season, matches, table }
let settings = Object.assign({ theme: 'dark', prefs: { remind: true, start: true, goals: true, final: true } }, store.get(SETTINGS_KEY, {}));
const summaries = {};                         // отчёты о матчах: id -> summary
let loading = false;

// ---------- Модель ----------
const kickoff = (m) => new Date(m.date);
const opp = (m) => (m.atHome ? m.away : m.home);
const myScore = (m) => (m.atHome ? m.home.score : m.away.score);
const theirScore = (m) => (m.atHome ? m.away.score : m.home.score);
function result(m) {
  if (m.state !== 'post' || myScore(m) == null) return null;
  return myScore(m) > theirScore(m) ? 'W' : myScore(m) < theirScore(m) ? 'L' : 'D';
}
const isLive = (m) => m.state === 'in';
const inWindow = (m, now = Date.now()) => isLive(m) ||
  (m.state === 'pre' && now >= kickoff(m) - 70 * MIN && now <= kickoff(m).getTime() + 3 * 60 * MIN);

const matches = () => (data?.matches || []).slice().sort((a, b) => a.date.localeCompare(b.date));
const findMatch = (id) => (data?.matches || []).find((m) => m.id === id);

function heroMatch() {
  const list = matches();
  const now = Date.now();
  return list.find(isLive) ||
    // только что закончившийся матч держим на главной ещё 3 часа
    list.filter((m) => m.state === 'post' && now - kickoff(m) < 5 * 60 * MIN).pop() ||
    list.find((m) => m.state === 'pre' || m.state === 'postponed');
}

function metaLine(m) {
  return [m.comp, m.round ? `${m.round} тур` : '', m.venue === 'Lukoil Arena' ? 'Лукойл Арена' : m.venue].filter(Boolean).join(' · ');
}

// ---------- Загрузка ----------
// 4xx — это ответ сервера («нет такого матча»): помечаем final, чтобы не уходить из-за него на зеркало
async function fetchJSON(url, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (res.status >= 400 && res.status < 500) throw Object.assign(new Error('HTTP ' + res.status), { final: true });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json(); // тело ждём не дольше таймаута — при обрыве соединения оно «зависает»
  } finally { clearTimeout(t); }
}

// Как сейчас доступен сервер: { direct: true|false, ts }. Без VPN в России — false, тогда читаем зеркало.
let netMode = store.get('spartak-net', null);
const setNet = (direct) => { netMode = { direct, ts: Date.now() }; store.set('spartak-net', netMode); };

const minuteKey = (t) => new Date(t).toISOString().slice(0, 16).replace(/[-T:]/g, '');
let bundle = null, bundleAt = 0;
async function loadBundle() {
  if (bundle && Date.now() - bundleAt < 20000) return bundle;
  // Снимок текущей минуты; часы телефона могут спешить или отставать — ищем по очереди в обе стороны (0, −1, +1, −2, +2…)
  const offsets = [0];
  for (let i = 1; i <= 12; i++) offsets.push(i, -i);
  for (const off of offsets) {
    try {
      const b = await fetchJSON(MIRROR + minuteKey(Date.now() - off * 60000) + '.json', 10000);
      bundle = b; bundleAt = Date.now();
      return b;
    } catch { /* следующую минуту */ }
  }
  throw new Error('Зеркало данных недоступно');
}
function fromBundle(b, path) {
  const simple = { '/data': 'data', '/squad': 'squad', '/season': 'season', '/news': 'news', '/transfers': 'transfers', '/absences': 'absences', '/club/rotor': 'rotor' };
  if (simple[path]) return b[simple[path]];
  let m;
  if ((m = path.match(/^\/absences\/(.+)$/))) return b.absences?.matchId === decodeURIComponent(m[1]) ? b.absences : { matchId: m[1], home: [], away: [] };
  if ((m = path.match(/^\/match\/(.+)$/))) return b.matches?.[m[1]]?.summary;
  if ((m = path.match(/^\/live\/(.+)$/))) return b.matches?.[m[1]]?.live;
  return null;
}

async function getJSON(path) {
  if (!netMode || netMode.direct) {
    const direct = fetchJSON(API + path, 9000);
    if (netMode?.direct) {
      try { return await direct; } catch (e) { if (e.final) throw e; setNet(false); }
    } else {
      // Первый запуск: даём прямому пути 4 секунды, иначе берём зеркало, а результат прямого запомним
      const r = await Promise.race([direct.then((v) => ({ v }), (e) => ({ e })), new Promise((ok) => setTimeout(() => ok(null), 4000))]);
      if (r && 'v' in r) { setNet(true); return r.v; }
      if (r?.e?.final) throw r.e;
      direct.then(() => setNet(true), (e) => { if (!e.final) setNet(false); });
    }
  } else if (Date.now() - netMode.ts > 30 * MIN) {
    // Изредка проверяем в фоне, не заработал ли прямой путь (например, включили VPN)
    setNet(false);
    fetchJSON(API + '/data', 9000).then(() => setNet(true), () => {});
  }
  const v = fromBundle(await loadBundle(), path);
  if (v == null) throw Object.assign(new Error('Нет в зеркале'), { final: true });
  return v;
}

let pollTimer;
async function refresh(manual = false) {
  if (loading) return;
  loading = true;
  setBusy(true);
  try {
    const fresh = withCrest(await getJSON('/data'));
    const prev = data;
    data = fresh;
    store.set(DATA_KEY, data);
    detectGoals(prev, data);
    const hm = heroMatch();
    if (hm && hm.src === 'espn' && (isLive(hm) || hm.state === 'post')) await loadSummary(hm.id, true);
    const open = sheetMatchId && findMatch(sheetMatchId);
    if (open && isLive(open)) await Promise.all([loadSummary(open.id, true), loadLive(open.id)]);
    desktopWatch();
    // «Ротор»: обновляем, если вкладка открыта или в программе для ПК включены его уведомления
    if (document.querySelector('[data-tab=rotor]')?.classList.contains('active') || (desk && settings.prefs.rotor)) loadRotor();
  } catch (e) {
    if (manual || !data) toast(navigator.onLine ? 'Не удалось обновить — показаны сохранённые данные' : 'Нет интернета — показаны сохранённые данные');
  } finally {
    loading = false;
    setBusy(false);
    render();
    clearTimeout(pollTimer);
    const live = (data?.matches || []).some((m) => inWindow(m));
    pollTimer = setTimeout(refresh, live ? POLL_LIVE_MS : POLL_IDLE_MS);
  }
}

async function loadSummary(id, force = false) {
  if (!force && summaries[id]) return summaries[id];
  try { summaries[id] = await getJSON('/match/' + id); } catch { /* нет отчёта */ }
  return summaries[id];
}

// ---------- Гол! ----------
function detectGoals(prev, next) {
  if (!prev) return;
  for (const m of next.matches) {
    if (!isLive(m) && m.state !== 'post') continue;
    const old = prev.matches.find((x) => x.id === m.id);
    if (!old || old.state === 'pre' && myScore(m) == null) continue;
    if ((myScore(m) ?? 0) > (myScore(old) ?? 0)) celebrate();
  }
}

function celebrate({ text = 'ГОЛ!', sound = true } = {}) {
  const o = $('#goalOverlay');
  o.querySelector('.goal-text').textContent = text;
  o.querySelectorAll('.confetti').forEach((c) => c.remove());
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + '%';
    c.style.background = i % 2 ? '#e1182c' : '#ffffff';
    c.style.animationDelay = Math.random() * 0.6 + 's';
    c.style.animationDuration = 1.8 + Math.random() * 1.4 + 's';
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    o.appendChild(c);
  }
  o.classList.remove('show');
  void o.offsetWidth;
  o.classList.add('show');
  if (sound) playRoar();
  try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* нет вибрации */ }
  setTimeout(() => o.classList.remove('show'), 3800);
}

// ---------- Рёв трибун ----------
// Звук не из файла, а синтезируется: шум толпы + сотни «голосов» на гласной «о» + дудки.
let audioCtx = null;
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
// Браузеры разрешают звук только после касания страницы — «разблокируем» его заранее
['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

function playRoar(force = false) {
  if (!force && settings.sound === false) return;
  const ctx = unlockAudio();
  if (!ctx) return;
  const t = ctx.currentTime + 0.05, dur = 4.8;

  const master = ctx.createGain();
  master.gain.value = 0.55;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);

  // 1. Шум трибун: розовый шум через полосовой фильтр, нарастает и затихает
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 0.7;
  bp.frequency.setValueAtTime(450, t);
  bp.frequency.linearRampToValueAtTime(950, t + 0.7);
  bp.frequency.linearRampToValueAtTime(600, t + dur);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(1, t + 0.45);
  ng.gain.setValueAtTime(1, t + 1.8);
  ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
  noise.connect(bp).connect(ng).connect(master);
  noise.start(t); noise.stop(t + dur);

  // 2. «Го-о-ол!» — много голосов разной высоты на гласной «о»
  const vowel = ctx.createBiquadFilter();
  vowel.type = 'bandpass'; vowel.frequency.value = 520; vowel.Q.value = 2.5;
  const vowel2 = ctx.createBiquadFilter();
  vowel2.type = 'bandpass'; vowel2.frequency.value = 900; vowel2.Q.value = 3;
  const vg = ctx.createGain();
  vg.gain.setValueAtTime(0.0001, t + 0.1);
  vg.gain.exponentialRampToValueAtTime(0.5, t + 0.5);
  vg.gain.setValueAtTime(0.5, t + 2.2);
  vg.gain.exponentialRampToValueAtTime(0.001, t + 3.6);
  vowel.connect(vg); vowel2.connect(vg); vg.connect(master);
  for (let i = 0; i < 40; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = 130 + Math.random() * 160;
    o.frequency.setValueAtTime(f * 0.85, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.4); // голос «взлетает»
    o.frequency.setValueAtTime(f, t + 2.4);
    o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 3.6);
    o.detune.value = Math.random() * 40 - 20;
    const g = ctx.createGain();
    g.gain.value = 0.04;
    o.connect(g); g.connect(vowel); g.connect(vowel2);
    o.start(t + Math.random() * 0.15); o.stop(t + 3.7);
  }

  // 3. Дудки: три коротких сигнала
  const hornF = ctx.createBiquadFilter();
  hornF.type = 'lowpass'; hornF.frequency.value = 2200;
  hornF.connect(master);
  [0.2, 0.55, 0.9].forEach((at, k) => {
    const g = ctx.createGain();
    const st = t + at, en = st + (k === 2 ? 0.55 : 0.25);
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(0.12, st + 0.03);
    g.gain.setValueAtTime(0.12, en - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, en);
    g.connect(hornF);
    for (const f of [466, 587]) {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      o.connect(g); o.start(st); o.stop(en);
    }
  });
}

// ---------- Матч-день и праздник после победы ----------
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function dayMode(now = new Date()) {
  const list = matches();
  const today = list.find((m) => (m.state === 'pre' || isLive(m)) && sameDay(kickoff(m), now));
  if (today) return { type: 'matchday', m: today };
  // После победы — праздник до 6 утра следующего дня
  const last = list.filter((m) => m.state === 'post').pop();
  if (last && result(last) === 'W') {
    const until = new Date(kickoff(last));
    until.setDate(until.getDate() + 1);
    until.setHours(6, 0, 0, 0);
    if (now < until && now - kickoff(last) < 30 * 60 * MIN) return { type: 'victory', m: last };
  }
  return null;
}

function renderDayMode() {
  const mode = dayMode();
  document.body.classList.toggle('mode-matchday', mode?.type === 'matchday');
  document.body.classList.toggle('mode-victory', mode?.type === 'victory');
  const el = $('#dayBanner');
  if (!mode) { el.hidden = true; return; }
  const m = mode.m;
  el.hidden = false;
  if (mode.type === 'victory') {
    el.innerHTML = `<div class="db-title">🎉 Победа!</div>
      <div class="db-sub">${esc(m.home.name)} ${m.home.score}:${m.away.score} ${esc(m.away.name)} · празднуем до утра</div>`;
    // Салют один раз за победу
    const key = 'spartak-victory-' + m.id;
    if (!store.get(key, false)) { store.set(key, true); setTimeout(() => celebrate({ text: 'ПОБЕДА!', sound: false }), 600); }
    return;
  }
  if (isLive(m)) {
    el.innerHTML = `<div class="db-title">🔥 Матч идёт — болеем!</div>
      <div class="db-sub">${esc(m.home.name)} ${m.home.score ?? 0}:${m.away.score ?? 0} ${esc(m.away.name)} · ${esc(m.clock || 'LIVE')}</div>`;
    return;
  }
  el.innerHTML = `<div class="db-title">🔴⚪ Сегодня играем!</div>
    <div class="db-sub">${esc(m.home.name)} — ${esc(m.away.name)}${m.timeValid ? ` в ${fmtTime.format(kickoff(m))}` : ''}${m.tv ? ` · ${esc(m.tv)}` : ''}</div>
    <div class="db-scarf">👕 Не забудь счастливую майку!</div>
    <button class="btn db-btn" id="bigOpen">⏱ Таймер на весь экран</button>`;
  $('#bigOpen').onclick = () => openBigTimer(m.id);
}

let bigTimerId = null;
function openBigTimer(id) {
  const m = findMatch(id);
  if (!m) return;
  bigTimerId = id;
  $('#bigInner').innerHTML = `
    <div class="bt-label">${sameDay(kickoff(m), new Date()) ? 'Сегодня играем!' : 'До матча'}</div>
    <div class="bt-teams">${badge(m.home.logo, 'bt-badge', m.home.name)}<span>—</span>${badge(m.away.logo, 'bt-badge', m.away.name)}</div>
    <div class="bt-names">${esc(m.home.name)} — ${esc(m.away.name)}</div>
    <div class="bt-time" id="btTime"></div>
    <div class="bt-meta">${esc(metaLine(m))}${m.timeValid ? ' · ' + fmtTime.format(kickoff(m)) : ''}</div>
    <div class="bt-scarf">👕 Счастливая майка на тебе?</div>`;
  const el = $('#bigTimer');
  el.hidden = false;
  el.requestFullscreen?.().catch(() => {});
  tickCountdown();
}

function closeBigTimer() {
  bigTimerId = null;
  $('#bigTimer').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function tickBigTimer() {
  if (!bigTimerId) return;
  const m = findMatch(bigTimerId);
  const el = $('#btTime');
  if (!m || !el) return;
  if (m.state !== 'pre') {
    el.innerHTML = isLive(m) ? `<span class="bt-live">${m.home.score ?? 0}:${m.away.score ?? 0}</span>` : 'Финал';
    return;
  }
  let diff = Math.max(0, kickoff(m) - Date.now());
  if (!diff) { el.textContent = 'Начинаем!'; return; }
  const d = Math.floor(diff / 86400e3); diff -= d * 86400e3;
  const h = Math.floor(diff / 3600e3); diff -= h * 3600e3;
  const mi = Math.floor(diff / 60e3); diff -= mi * 60e3;
  const sec = Math.floor(diff / 1e3);
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `${d ? d + 'д ' : ''}${pad(h)}:${pad(mi)}:${pad(sec)}`;
}

// ---------- Отрисовка ----------
function badge(src, cls = '', alt = '') {
  if (!src) return `<span class="${cls} badge-empty"></span>`;
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" onerror="this.style.visibility='hidden'">`;
}
const rivalryChip = (m) => (m.rivalry ? `<span class="rival">${esc(m.rivalry)}</span>` : '');

function renderHero() {
  const hero = $('#hero');
  const m = heroMatch();
  if (!m) {
    if (!data) return; // скелетон, пока нет данных
    hero.innerHTML = `<div class="hero-label"><span>Следующий матч</span></div>
      <div class="hero-when" style="padding:30px 0"><div class="hero-date">Расписание пока не объявлено</div>
      <div class="hero-meta">Загляните позже — данные обновятся автоматически</div></div>`;
    return;
  }
  const live = isLive(m), post = m.state === 'post';
  const showScore = live || post;
  const label = live ? 'Сейчас идёт' : post ? 'Матч завершён' : m.state === 'postponed' ? 'Матч перенесён' : 'Следующий матч';
  const chip = live ? `<span class="chip live">${esc(m.clock || 'LIVE')}</span>`
    : post ? `<span class="chip">${{ W: 'Победа', D: 'Ничья', L: 'Поражение' }[result(m)] || 'Финал'}</span>`
      : `<span class="chip">${m.atHome ? 'Дома' : 'В гостях'}</span>`;
  const s = summaries[m.id];
  const goals = showScore && s ? s.events.filter((e) => ['goal', 'penalty', 'own-goal'].includes(e.type)) : [];
  const timeStr = m.timeValid ? fmtTime.format(kickoff(m)) : 'время уточняется';

  hero.innerHTML = `
    <div class="hero-label"><span>${label}</span><span class="chips">${rivalryChip(m)}${chip}</span></div>
    <button class="matchup" data-open="${esc(m.id)}" aria-label="Подробнее о матче">
      <div class="team">${badge(m.home.logo, 'team-badge', m.home.name)}<div class="team-name">${esc(m.home.name)}</div></div>
      ${showScore ? `<div class="score-big">${m.home.score ?? 0}:${m.away.score ?? 0}</div>` : '<div class="vs">VS</div>'}
      <div class="team">${badge(m.away.logo, 'team-badge', m.away.name)}<div class="team-name">${esc(m.away.name)}</div></div>
    </button>
    ${goals.length ? `<div class="hero-goals">${goals.map((g) => `<span class="${g.side}">⚽ ${esc(g.player)} ${esc(g.minute)}${g.type === 'penalty' ? ' (пен.)' : g.type === 'own-goal' ? ' (авт.)' : ''}</span>`).join('')}</div>` : ''}
    <div class="hero-when">
      <div class="hero-date">${esc(cap(fmtWeekday.format(kickoff(m))))} · ${esc(timeStr)}</div>
      <div class="hero-meta">${esc(metaLine(m))}</div>
      ${m.tv && !post ? `<div class="hero-tv">📺 ${esc(m.tv)}</div>` : ''}
    </div>
    ${!showScore && m.state === 'pre' ? `<div class="countdown" id="countdown" data-t="${kickoff(m).getTime()}"></div>` : ''}
    <div class="hero-actions">
      ${showScore ? `<button class="btn" data-open="${esc(m.id)}">${live ? 'События и составы' : 'Отчёт о матче'}</button>` : `
      <button class="btn" id="calBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
        В календарь
      </button>`}
      <button class="btn ghost" id="shareBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>
        Поделиться
      </button>
    </div>`;

  const cal = $('#calBtn');
  if (cal) cal.onclick = () => downloadIcs(m);
  $('#shareBtn').onclick = () => (post ? openShareCard(m.id) : share(m));
  tickCountdown();
}

function tickCountdown() {
  tickBigTimer();
  tickRotorCountdown();
  const el = $('#countdown');
  if (!el) return;
  let diff = Math.max(0, Number(el.dataset.t) - Date.now());
  const d = Math.floor(diff / 86400e3); diff -= d * 86400e3;
  const h = Math.floor(diff / 3600e3); diff -= h * 3600e3;
  const mi = Math.floor(diff / 60e3); diff -= mi * 60e3;
  const s = Math.floor(diff / 1e3);
  el.innerHTML = [[d, plural(d, 'день', 'дня', 'дней')], [h, plural(h, 'час', 'часа', 'часов')], [mi, 'мин'], [s, 'сек']]
    .map(([n, l]) => `<div class="cd-cell"><div class="cd-num">${String(n).padStart(2, '0')}</div><div class="cd-lbl">${l}</div></div>`).join('');
}

const dateBox = (d) => `<div class="date-box"><div class="date-day">${d.getDate()}</div><div class="date-mon">${fmtMon.format(d).replace('.', '')}</div></div>`;

function matchRow(m, right, sub) {
  const o = opp(m);
  return `<button class="match" data-open="${esc(m.id)}">
    ${dateBox(kickoff(m))}
    <div class="match-main">
      <div class="match-teams">${badge(o.logo, '', o.name)}<span>${esc(o.name)}</span></div>
      <div class="match-sub">${rivalryChip(m)}${sub}</div>
    </div>
    ${right}
  </button>`;
}

function renderUpcoming() {
  const el = $('#panel-upcoming');
  const list = matches().filter((m) => m.state === 'pre' || isLive(m) || m.state === 'postponed');
  if (!list.length) { el.innerHTML = `<div class="empty">${data ? 'Нет запланированных матчей' : 'Загружаем расписание…'}</div>`; return; }
  el.innerHTML = `<div class="list">${list.map((m) => {
    const when = m.state === 'postponed' ? 'перенесён' : m.timeValid ? fmtTime.format(kickoff(m)) : 'время уточняется';
    const right = isLive(m)
      ? `<div class="live-score"><div class="res-score">${m.home.score ?? 0}:${m.away.score ?? 0}</div><span class="ha live">${esc(m.clock || 'LIVE')}</span></div>`
      : `<span class="ha ${m.atHome ? 'home' : ''}">${m.atHome ? 'Дома' : 'В гостях'}</span>`;
    return matchRow(m, right, `${esc(fmtWdShort.format(kickoff(m)))}, ${when} · ${esc(m.comp)}${m.round ? ` · ${m.round} тур` : ''}`);
  }).join('')}</div>`;
}

const RES_LABEL = { W: 'Победа', D: 'Ничья', L: 'Поражение' };
const RES_LETTER = { W: 'В', D: 'Н', L: 'П' };

function renderResults() {
  const el = $('#panel-results');
  const list = matches().filter((m) => m.state === 'post').reverse();
  if (!list.length) { el.innerHTML = `<div class="empty">${data ? 'Пока нет сыгранных матчей' : 'Загружаем результаты…'}</div>`; return; }
  const form = list.slice(0, 5).filter(result);
  const all = list.filter(result);
  const w = all.filter((m) => result(m) === 'W').length, d = all.filter((m) => result(m) === 'D').length, l = all.length - w - d;
  el.innerHTML = `
    <div class="form-strip">
      <div><div class="lbl">Форма</div><div class="season-line">${w}В · ${d}Н · ${l}П за ${all.length} ${plural(all.length, 'матч', 'матча', 'матчей')}</div></div>
      <div class="form-dots">${form.slice().reverse().map((m) => `<span class="form-dot ${result(m)}">${RES_LETTER[result(m)]}</span>`).join('')}</div>
    </div>
    <div class="list">${list.map((m) => matchRow(m, `<div>
        <div class="res-score">${m.home.score ?? '–'}:${m.away.score ?? '–'}</div>
        ${result(m) ? `<span class="res-tag ${result(m)}">${RES_LABEL[result(m)]}</span>` : ''}
      </div>`, `${m.atHome ? 'Дома' : 'В гостях'} · ${esc(m.comp)}${m.round ? ` · ${m.round} тур` : ''}`)).join('')}</div>`;
}

function renderTable() {
  const el = $('#panel-table');
  const t = data?.table || [];
  if (!t.length) { el.innerHTML = `<div class="empty">${data ? 'Таблица недоступна' : 'Загружаем таблицу…'}</div>`; return; }
  const n = t.length;
  el.innerHTML = `
    <div class="table-card">
      <div class="trow head"><span class="pos">#</span><span>Команда</span><span class="num" title="Игры">И</span><span class="num wide" title="Выигрыши">В</span><span class="num wide" title="Ничьи">Н</span><span class="num wide" title="Поражения">П</span><span class="num" title="Разница забитых и пропущенных мячей">±</span><span class="pts" title="Очки">О</span></div>
      ${t.map((r) => {
        const zone = r.rank > n - 2 ? 'zone-out' : r.rank > n - 4 ? 'zone-po' : '';
        return `<div class="trow ${r.id === TEAM_ID ? 'me' : ''} ${zone}">
          <span class="pos">${esc(r.rank)}</span>
          <span class="tname">${badge(r.logo, '', r.name)}<span>${esc(r.name)}</span></span>
          <span class="num">${esc(r.played)}</span>
          <span class="num wide">${esc(r.win)}</span><span class="num wide">${esc(r.draw)}</span><span class="num wide">${esc(r.loss)}</span>
          <span class="num">${r.gd > 0 ? '+' : ''}${esc(r.gd)}</span>
          <span class="pts">${esc(r.pts)}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="t-legend">
      <span><b>И</b> игры</span>
      <span class="wide"><b>В</b> выигрыши</span>
      <span class="wide"><b>Н</b> ничьи</span>
      <span class="wide"><b>П</b> поражения</span>
      <span><b>±</b> разница мячей</span>
      <span><b>О</b> очки</span>
    </div>
    <p class="note"><span class="legend po"></span>стыковые матчи <span class="legend out"></span>вылет · ${esc(data.season || 'РПЛ')}</p>
    <div id="seasonTable"></div>`;
  renderSeasonTable();
}

function render() {
  renderHealth();
  renderDayMode();
  renderHero();
  renderUpcoming();
  renderResults();
  renderTable();
  renderSquad();
  $('#status').textContent = loading ? 'Обновляем данные…'
    : data?.updated ? `Обновлено ${fmtStamp.format(new Date(data.updated))}` : 'Данные пока не загрузились';
  if (sheetMatchId) renderMatchSheet(sheetMatchId, false);
}

// ---------- Сезон, трансферы, травмы, состояние источников ----------
let season = store.get('spartak-season', null);       // { ts, rounds, places, homeAway, scorers, opponents }
let transfers = store.get('spartak-transfers', null); // { ts, window, items, source }
let absences = store.get('spartak-absences', null);   // { ts, matchId, homeName, awayName, home, away, source }
const matchAbsences = {};                              // id матча -> отсутствующие (для карточки матча)

async function loadCached(key, path, ttl, setter, after) {
  const cur = store.get(key, null);
  if (cur && Date.now() - cur.ts < ttl) return;
  try {
    const v = { ...(await getJSON(path)), ts: Date.now() };
    store.set(key, v);
    setter(v);
    after();
  } catch { /* остаются сохранённые данные */ }
}
const loadSeason = () => loadCached('spartak-season', '/season', 10 * MIN, (v) => (season = v), () => { renderSeasonTable(); renderScorers(); });
const loadTransfers = () => loadCached('spartak-transfers', '/transfers', 6 * 60 * MIN, (v) => (transfers = v), renderTransfers);
const loadAbsences = () => loadCached('spartak-absences', '/absences', 60 * MIN, (v) => (absences = v), renderAbsences);

async function loadMatchAbsences(id) {
  if (matchAbsences[id]) return;
  try { matchAbsences[id] = await getJSON('/absences/' + encodeURIComponent(id)); } catch { /* нет данных */ }
  if (sheetMatchId === id) renderMatchSheet(id, false);
}

// Предупреждение, если источник данных сломался или данные давно не обновлялись
function renderHealth() {
  const el = $('#healthNote');
  if (!el) return;
  const h = data?.health;
  const stale = data?.updated && Date.now() - data.updated > 2 * 60 * MIN;
  let text = '';
  if (h && !h.ok && h.problems?.length) text = `${h.problems[0].text}. Показаны данные на ${fmtStamp.format(new Date(data.updated))}.`;
  else if (stale && navigator.onLine) text = `Данные давно не обновлялись — последнее обновление ${fmtStamp.format(new Date(data.updated))}.`;
  el.hidden = !text;
  el.innerHTML = text ? `<span>⚠</span><span>${esc(text)}</span>` : '';
}

const ruOrdinalPlace = (n) => `${n}-е`;

function haCard(title, r) {
  const ppg = r.p ? (r.pts / r.p).toFixed(1).replace('.', ',') : '0';
  return `<div class="ha-card">
    <div class="ha-title">${title}</div>
    <div class="ha-pts">${r.pts} <small>${plural(r.pts, 'очко', 'очка', 'очков')}</small></div>
    <div class="ha-line">${r.w}В · ${r.d}Н · ${r.l}П за ${r.p} ${plural(r.p, 'матч', 'матча', 'матчей')}</div>
    <div class="ha-line">Мячи ${r.gf}–${r.ga} · ${ppg} очка за игру</div>
    <div class="form-dots">${r.form.map((f) => `<span class="form-dot ${f}">${RES_LETTER[f]}</span>`).join('')}</div>
  </div>`;
}

function renderSeasonTable() {
  const el = $('#seasonTable');
  if (!el) return;
  const p = season?.places || [];
  if (!p.length) { el.innerHTML = season ? '' : '<div class="empty small">Загружаем сезон…</div>'; return; }
  const teams = p[0].teams || 16;
  el.innerHTML = `
    <h3 class="sec-title">Место по турам</h3>
    <div class="chart-card"><div id="placeChart"></div></div>
    <details class="tbl-view"><summary>Показать таблицей</summary>
      <table><tr><th>Тур</th><th>Соперник</th><th>Место</th><th>Очки</th></tr>
      ${p.map((x, i) => `<tr><td>${x.round}</td><td>${esc(season.opponents?.[i] || '')}</td><td>${x.place}</td><td>${x.pts}</td></tr>`).join('')}</table>
    </details>
    <h3 class="sec-title">Дома и в гостях</h3>
    <div class="ha-grid">${haCard('Дома', season.homeAway.home)}${haCard('В гостях', season.homeAway.away)}</div>`;
  lineChart($('#placeChart'), {
    series: [{ name: 'Спартак', color: '--s-red', values: p.map((x) => x.place) }],
    labels: p.map((x) => x.round),
    yMin: 1, yMax: teams, invert: true, yTicks: [1, 4, 8, 12, teams],
    endLabel: (s) => `${ruOrdinalPlace(s.values.at(-1))} место`,
    tip: (i) => `<b>${p[i].round} тур</b>${season.opponents?.[i] ? ' · ' + esc(season.opponents[i]) : ''}<br>${p[i].place}-е место · ${p[i].pts} ${plural(p[i].pts, 'очко', 'очка', 'очков')}`,
    ariaLabel: 'Место «Спартака» в таблице РПЛ по турам',
  });
}

function renderScorers() {
  const el = $('#scorersBox');
  if (!el) return;
  const top = (season?.scorers || []).filter((s) => s.total > 0).slice(0, 3);
  if (!top.length || !season.rounds) { el.innerHTML = ''; return; }
  const colors = ['--s1', '--s2', '--s3'];
  const series = top.map((s, i) => ({ name: s.name, color: colors[i], values: s.byRound }));
  const last = (n) => n.split(' ').slice(-1)[0];
  el.innerHTML = `
    <h3 class="sec-title">Голы по ходу сезона</h3>
    <div class="chart-card">
      <div class="legend-row">${series.map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`).join('')}</div>
      <div id="scorerChart"></div>
    </div>
    <details class="tbl-view"><summary>Показать таблицей</summary>
      <table><tr><th>Тур</th><th>Соперник</th>${series.map((s) => `<th>${esc(last(s.name))}</th>`).join('')}</tr>
      ${Array.from({ length: season.rounds }, (_, i) => `<tr><td>${i + 1}</td><td>${esc(season.opponents?.[i] || '')}</td>${series.map((s) => `<td>${s.values[i]}</td>`).join('')}</tr>`).join('')}</table>
    </details>`;
  const maxG = Math.max(...top.map((s) => s.total), 1);
  const tickStep = maxG > 8 ? 2 : 1;
  lineChart($('#scorerChart'), {
    series, labels: Array.from({ length: season.rounds }, (_, i) => i + 1),
    yMin: 0, yMax: maxG, yTicks: Array.from({ length: Math.floor(maxG / tickStep) + 1 }, (_, i) => i * tickStep),
    endLabel: (s) => `${esc(last(s.name))} ${s.values.at(-1)}`,
    tip: (i) => `<b>${i + 1} тур</b>${season.opponents?.[i] ? ' · ' + esc(season.opponents[i]) : ''}<br>${series.map((s) => `<span class="tip-dot" style="background:var(${s.color})"></span>${esc(last(s.name))}: ${s.values[i]}`).join('<br>')}`,
    ariaLabel: 'Голы лучших бомбардиров «Спартака» по турам, нарастающим итогом',
  });
}

// ---------- Второй клуб: «Ротор» Волгоград (данные Sports.ru, см. cloud/src/club.js) ----------
let rotor = store.get('spartak-rotor', null); // { ts, name, league, crest, matches, table, coach, groups, news, transfers }
let rotorTab = store.get('spartak-rotor-tab', 'matches');
let rotorLoading = false;

async function loadRotor(force = false) {
  const live = (rotor?.matches || []).some((m) => inWindow(m));
  if (rotorLoading || (!force && rotor && Date.now() - rotor.ts < (live ? 30 * 1000 : 10 * MIN))) return;
  rotorLoading = true;
  const prev = rotor;
  try {
    rotor = { ...(await getJSON('/club/rotor')), ts: Date.now() };
    store.set('spartak-rotor', rotor);
    rotorDesktopWatch(prev, rotor);
  } catch { /* остаются сохранённые данные */ }
  rotorLoading = false;
  renderRotor();
}

const rotorResult = (m) => {
  if (m.state !== 'post' || m.home.score == null) return null;
  const my = m.atHome ? m.home.score : m.away.score, their = m.atHome ? m.away.score : m.home.score;
  return my > their ? 'W' : my < their ? 'L' : 'D';
};
const initials = (name) => esc(name.replace(/[«»"]/g, '').split(/[\s-]+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase());
const clubBadge = (team, cls) => (team.logo
  ? `<img class="${cls}" src="${esc(team.logo)}" alt="" loading="lazy">`
  : `<span class="${cls} club-initials">${initials(team.name)}</span>`);

function rotorHero() {
  const list = rotor.matches;
  const now = Date.now();
  const m = list.find((x) => x.state === 'in') ||
    list.filter((x) => x.state === 'post' && now - kickoff(x) < 5 * 60 * MIN).pop() ||
    list.find((x) => x.state === 'pre');
  if (!m) return '';
  const started = m.state !== 'pre';
  const r = rotorResult(m);
  return `<div class="rotor-hero">
    <div class="hero-label"><span>${m.state === 'in' ? 'Сейчас идёт' : m.state === 'post' ? 'Матч завершён' : 'Следующий матч'}</span>
      <span class="chip">${m.state === 'in' ? 'LIVE' : r ? RES_LABEL[r] : m.atHome ? 'Дома' : 'В гостях'}</span></div>
    <div class="rh-teams">
      <div class="team">${clubBadge(m.home, 'rh-badge')}<div class="team-name">${esc(m.home.name)}</div></div>
      <div class="rh-score">${started ? `${m.home.score ?? 0}:${m.away.score ?? 0}` : m.timeValid ? fmtTime.format(kickoff(m)) : '—'}</div>
      <div class="team">${clubBadge(m.away, 'rh-badge')}<div class="team-name">${esc(m.away.name)}</div></div>
    </div>
    <div class="hero-when"><div class="hero-date">${esc(cap(fmtWeekday.format(kickoff(m))))}${m.timeValid && started ? ' · ' + fmtTime.format(kickoff(m)) : ''}</div>
      <div class="hero-meta">${esc(m.comp)}</div></div>
    ${!started ? `<div class="countdown" id="rotorCountdown" data-t="${kickoff(m).getTime()}"></div>` : ''}
    ${m.sportsRu ? `<a class="btn rh-btn" href="${esc(m.sportsRu)}" target="_blank" rel="noopener">📝 ${started ? 'Подробности матча' : 'Превью матча'} на Sports.ru</a>` : ''}
  </div>`;
}

function rotorMatchRow(m) {
  const o = m.atHome ? m.away : m.home;
  const r = rotorResult(m);
  const right = m.state === 'pre'
    ? `<span class="ha ${m.atHome ? 'home' : ''}">${m.atHome ? 'Дома' : 'В гостях'}</span>`
    : `<div><div class="res-score">${m.home.score ?? '–'}:${m.away.score ?? '–'}</div>${r ? `<span class="res-tag ${r}">${RES_LABEL[r]}</span>` : m.state === 'in' ? '<span class="ha live">LIVE</span>' : ''}</div>`;
  const when = m.state === 'pre' ? `${fmtWdShort.format(kickoff(m))}, ${m.timeValid ? fmtTime.format(kickoff(m)) : 'время уточняется'}` : (m.atHome ? 'Дома' : 'В гостях');
  return `<a class="match" ${m.sportsRu ? `href="${esc(m.sportsRu)}" target="_blank" rel="noopener"` : ''}>
    ${dateBox(kickoff(m))}
    <div class="match-main">
      <div class="match-teams">${clubBadge(o, 'mini-badge')}<span>${esc(o.name)}</span></div>
      <div class="match-sub">${esc(when)} · ${esc(m.comp)}</div>
    </div>
    ${right}
  </a>`;
}

function rotorMatches() {
  const up = rotor.matches.filter((m) => m.state !== 'post');
  const done = rotor.matches.filter((m) => m.state === 'post').reverse();
  const league = done.filter((m) => m.comp === rotor.league && rotorResult(m));
  const form = league.slice(0, 5);
  return `
    ${form.length ? `<div class="form-strip"><div><div class="lbl">Форма в лиге</div><div class="season-line">${league.filter((m) => rotorResult(m) === 'W').length}В · ${league.filter((m) => rotorResult(m) === 'D').length}Н · ${league.filter((m) => rotorResult(m) === 'L').length}П</div></div>
      <div class="form-dots">${form.slice().reverse().map((m) => `<span class="form-dot ${rotorResult(m)}">${RES_LETTER[rotorResult(m)]}</span>`).join('')}</div></div>` : ''}
    ${up.length ? `<h3 class="sec-title">Расписание</h3><div class="list">${up.map(rotorMatchRow).join('')}</div>` : ''}
    <h3 class="sec-title">Результаты</h3>
    <div class="list">${done.map(rotorMatchRow).join('') || '<div class="empty">Пока нет сыгранных матчей</div>'}</div>`;
}

function rotorTable() {
  const t = rotor.table || [];
  if (!t.length) return '<div class="empty">Таблица недоступна</div>';
  return `<div class="table-card">
      <div class="trow head"><span class="pos">#</span><span>Команда</span><span class="num" title="Игры">И</span><span class="num wide" title="Выигрыши">В</span><span class="num wide" title="Ничьи">Н</span><span class="num wide" title="Поражения">П</span><span class="num" title="Разница мячей">±</span><span class="pts" title="Очки">О</span></div>
      ${t.map((r) => `<div class="trow ${r.slug === 'rotor' ? 'me rotor-me' : ''}">
        <span class="pos">${r.rank}</span><span class="tname"><span>${esc(r.name)}</span></span>
        <span class="num">${r.played}</span><span class="num wide">${r.win}</span><span class="num wide">${r.draw}</span><span class="num wide">${r.loss}</span>
        <span class="num">${r.gd > 0 ? '+' : ''}${r.gd}</span><span class="pts">${r.pts}</span></div>`).join('')}
    </div>
    <div class="t-legend"><span><b>И</b> игры</span><span class="wide"><b>В</b> выигрыши</span><span class="wide"><b>Н</b> ничьи</span><span class="wide"><b>П</b> поражения</span><span><b>±</b> разница мячей</span><span><b>О</b> очки</span></div>
    <p class="note">${esc(rotor.league || '')} · по данным Sports.ru</p>`;
}

function rotorSquad() {
  const c = rotor.coach;
  const all = rotor.groups.flatMap((g) => g.players);
  const best = (k) => all.filter((p) => p[k] > 0).sort((a, b) => b[k] - a[k])[0];
  const sc = best('goals'), as = best('assists');
  const ava = (p) => (p.photo ? `<span class="sq-ph"><img src="${esc(p.photo)}" alt="" loading="lazy">${p.n ? `<b>${esc(p.n)}</b>` : ''}</span>` : `<span class="sq-n">${esc(p.n || '–')}</span>`);
  const meta = (p) => [p.country, p.age ? `${p.age} ${plural(p.age, 'год', 'года', 'лет')}` : ''].filter(Boolean).join(' · ');
  return `
    ${c ? `<div class="coach-head rotor-coach">${c.photo ? `<span class="coach-ph"><img src="${esc(c.photo)}" alt=""></span>` : ''}
      <span><small>Главный тренер</small><b>${esc(c.name)}</b><span class="coach-meta">${esc([c.country, ageOf(c.birthDate) ? `${ageOf(c.birthDate)} ${plural(ageOf(c.birthDate), 'год', 'года', 'лет')}` : ''].filter(Boolean).join(' · '))}</span></span></div>` : ''}
    <div class="leaders">
      ${sc ? `<div class="leader"><div class="leader-lbl">Бомбардир</div><div class="leader-num rotor-num">${sc.goals}</div><div class="leader-name">${esc(sc.name)}</div></div>` : ''}
      ${as ? `<div class="leader"><div class="leader-lbl">Ассистент</div><div class="leader-num rotor-num">${as.assists}</div><div class="leader-name">${esc(as.name)}</div></div>` : ''}
    </div>
    ${rotor.groups.map((g) => `
      <div class="sq-group">
        <div class="sq-title"><span>${esc(g.title)}</span><span class="sq-cols"><span>И</span><span>Г</span><span>П</span></span></div>
        <div class="table-card">${g.players.map((p) => `
          <div class="sq-row">
            ${ava(p)}
            <span style="min-width:0"><div class="sq-name">${esc(p.name)}</div><div class="sq-meta">${esc(meta(p))}</div></span>
            <span class="sq-v">${p.apps}</span><span class="sq-v ${p.goals ? 'hot' : ''}">${p.goals}</span><span class="sq-v ${p.assists ? 'hot' : ''}">${p.assists}</span>
          </div>`).join('')}</div>
      </div>`).join('')}
    <div class="t-legend"><span><b>И</b> игры</span><span><b>Г</b> голы</span><span><b>П</b> голевые передачи</span></div>
    ${rotor.transfers?.items?.length ? `<h3 class="sec-title">Трансферы · ${esc(rotor.transfers.window)}</h3>
      <div class="table-card">${rotor.transfers.items.map((x) => `<div class="tr-row">
        <span class="tr-date">${esc(x.date)}</span>
        <span class="tr-main"><b>${x.dir === 'in' ? '→ ' : '← '}${esc(x.name)}</b><small>${[x.pos, x.dir === 'in' ? (x.from && x.from !== 'Свободный агент' ? `из «${x.from}»` : '') : `в «${x.to}»`, x.note].filter(Boolean).map(esc).join(' · ')}</small></span>
        <span class="tr-fee">${esc(x.fee || '')}</span></div>`).join('')}</div>` : ''}
    <p class="note">Статистика сезона и состав — Sports.ru</p>`;
}

function rotorNews() {
  const items = rotor.news || [];
  if (!items.length) return '<div class="empty">Новостей пока нет</div>';
  return `<div class="table-card">${items.map((n) => `
    <a class="news-row" href="${esc(n.url)}" target="_blank" rel="noopener">
      <span class="news-time">${esc(new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(n.date)).replace('.', ''))}</span>
      <span class="news-main"><b>${esc(n.title)}</b><small>${esc(n.source)} · ${fmtTime.format(new Date(n.date))}</small></span>
    </a>`).join('')}</div>
    <p class="note">Заголовки с Sports.ru; статьи открываются на сайте издания.</p>`;
}

function renderRotor() {
  const el = $('#panel-rotor');
  if (!el) return;
  if (!rotor) { el.innerHTML = `<div class="empty">${rotorLoading ? 'Загружаем «Ротор»…' : 'Данные о «Роторе» пока не загрузились'}</div>`; return; }
  const tabs = [['matches', 'Матчи'], ['table', 'Таблица'], ['squad', 'Состав'], ['news', 'Новости']];
  const body = { matches: rotorMatches, table: rotorTable, squad: rotorSquad, news: rotorNews }[rotorTab] || rotorMatches;
  el.innerHTML = `
    <div class="rotor-head">${rotor.crest ? `<img src="${esc(rotor.crest)}" alt="">` : ''}<div><b>${esc(rotor.name)}</b><small>${esc(rotor.city || '')} · ${esc(rotor.league || '')}</small></div></div>
    ${rotorHero()}
    <div class="seg rotor-seg">${tabs.map(([k, l]) => `<button class="seg-btn ${k === rotorTab ? 'active' : ''}" data-rtab="${k}">${l}</button>`).join('')}</div>
    ${body()}`;
  tickRotorCountdown();
}

function tickRotorCountdown() {
  const el = $('#rotorCountdown');
  if (!el) return;
  let diff = Math.max(0, Number(el.dataset.t) - Date.now());
  const d = Math.floor(diff / 86400e3); diff -= d * 86400e3;
  const h = Math.floor(diff / 3600e3); diff -= h * 3600e3;
  const mi = Math.floor(diff / 60e3); diff -= mi * 60e3;
  const s = Math.floor(diff / 1e3);
  el.innerHTML = [[d, plural(d, 'день', 'дня', 'дней')], [h, plural(h, 'час', 'часа', 'часов')], [mi, 'мин'], [s, 'сек']]
    .map(([n, l]) => `<div class="cd-cell"><div class="cd-num">${String(n).padStart(2, '0')}</div><div class="cd-lbl">${l}</div></div>`).join('');
}

// Программа для ПК: уведомления по «Ротору» сама, по изменению счёта (если включено в настройках)
function rotorDesktopWatch(prev, next) {
  if (!desk || !settings.prefs.rotor || !prev) return;
  for (const m of next.matches) {
    const o = prev.matches.find((x) => x.id === m.id);
    if (!o) continue;
    const title = `${m.home.name} — ${m.away.name}`;
    if (o.state === 'pre' && m.state !== 'pre') desktopNotify(`«${next.name}»: матч начался`, title);
    const before = (o.home.score ?? 0) + (o.away.score ?? 0), after = (m.home.score ?? 0) + (m.away.score ?? 0);
    if (after > before) desktopNotify(`⚽ Гол в матче «${next.name}»`, `${m.home.name} ${m.home.score}:${m.away.score} ${m.away.name}`);
    if (o.state !== 'post' && m.state === 'post') desktopNotify(`«${next.name}»: финал`, `${m.home.name} ${m.home.score}:${m.away.score} ${m.away.name}`);
  }
}

// ---------- Новости ----------
// Только заголовки и ссылки: сами статьи открываются на сайтах изданий
let news = store.get('spartak-news', null); // { ts, items, failed }
let newsSeen = store.get('spartak-news-seen', 0); // время прошлого просмотра — чтобы отметить новые
let newsSeenBefore = newsSeen;

async function loadNews(force = false) {
  if (!force && news && Date.now() - news.ts < 10 * MIN) return;
  try {
    news = { ...(await getJSON('/news')), ts: Date.now() };
    store.set('spartak-news', news);
  } catch { /* остаются сохранённые */ }
  renderNews();
  markNewsTab();
}

function openNews() {
  newsSeenBefore = newsSeen;
  newsSeen = Date.now();
  store.set('spartak-news-seen', newsSeen);
  renderNews();
  markNewsTab();
  loadNews();
}

function markNewsTab() {
  const tab = document.querySelector('[data-tab=news]');
  const fresh = (news?.items || []).filter((n) => Date.parse(n.date) > newsSeen).length;
  tab.dataset.badge = fresh ? (fresh > 9 ? '9+' : String(fresh)) : '';
}

function renderNews() {
  const el = $('#panel-news');
  if (!el) return;
  if (!news?.items?.length) { el.innerHTML = `<div class="empty">${news ? 'Новостей пока нет' : 'Загружаем новости…'}</div>`; return; }
  const today = new Date(), yest = new Date(Date.now() - 864e5);
  const dayName = (d) => (sameDay(d, today) ? 'Сегодня' : sameDay(d, yest) ? 'Вчера' : cap(fmtWeekday.format(d)));
  const groups = [];
  for (const n of news.items) {
    const d = new Date(n.date), name = dayName(d);
    if (!groups.length || groups.at(-1).name !== name) groups.push({ name, items: [] });
    groups.at(-1).items.push(n);
  }
  el.innerHTML = `${groups.map((g) => `
    <h3 class="sec-title">${esc(g.name)}</h3>
    <div class="table-card">${g.items.map((n) => `
      <a class="news-row ${Date.parse(n.date) > newsSeenBefore && newsSeenBefore ? 'fresh' : ''}" href="${esc(n.url)}" target="_blank" rel="noopener">
        <span class="news-time">${fmtTime.format(new Date(n.date))}</span>
        <span class="news-main"><b>${esc(n.title)}</b><small>${esc(n.source)}</small></span>
      </a>`).join('')}</div>`).join('')}
    <p class="note">Заголовки собираются с Sports.ru, «Чемпионата» и «Спорт-Экспресса» раз в 15 минут; статьи открываются на сайтах изданий.${news.failed?.length ? ` Сейчас не отвечает: ${esc(news.failed.join(', '))}.` : ''}</p>`;
}

// ---------- Тренерский штаб (с сайта клуба, файл staff.js) ----------
const STAFF = window.CLUB_STAFF || [];
const ageOf = (iso) => {
  if (!iso) return null;
  const b = new Date(iso), n = new Date();
  return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
};
const staffPhoto = (s, cls) => (s.photo
  ? `<span class="${cls}"><img src="${esc(s.photo)}" alt="" loading="lazy"></span>`
  : `<span class="${cls} st-empty">${esc(s.name.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</span>`);

function renderStaff() {
  const el = $('#staffBox');
  if (!el || !STAFF.length) return;
  const [head, ...rest] = STAFF;
  const meta = (s) => [s.country, ageOf(s.birthday) ? `${ageOf(s.birthday)} ${plural(ageOf(s.birthday), 'год', 'года', 'лет')}` : ''].filter(Boolean).join(' · ');
  el.innerHTML = `
    <h3 class="sec-title">Тренерский штаб</h3>
    <button class="coach-head" data-staff="${esc(head.id)}">
      ${staffPhoto(head, 'coach-ph')}
      <span><small>${esc(head.role)}</small><b>${esc(head.name)}</b><span class="coach-meta">${esc(meta(head))}</span></span>
    </button>
    <div class="table-card">${rest.map((s) => `
      <button class="sq-row st-row" data-staff="${esc(s.id)}">
        ${staffPhoto(s, 'sq-ph')}
        <span style="min-width:0"><div class="sq-name">${esc(s.name)}</div><div class="sq-meta">${esc(s.role)} · ${esc(meta(s))}</div></span>
      </button>`).join('')}
    </div>`;
}

function openStaff(id) {
  const s = STAFF.find((x) => x.id === id);
  if (!s) return;
  sheetMatchId = null;
  const since = s.since ? new Date(s.since) : null;
  const age = ageOf(s.birthday);
  openSheet(`
    <div class="pl-head">
      ${s.photo ? `<div class="pl-photo"><img src="${esc(s.photo)}" alt="${esc(s.name)}"></div>` : ''}
      <div class="pl-name">${esc(s.name)}</div>
      <div class="pl-sub">${esc(s.role)}</div>
    </div>
    <div class="info">
      <div class="info-row"><span class="muted">Гражданство</span><span>${esc(s.country)}</span></div>
      ${age ? `<div class="info-row"><span class="muted">Возраст</span><span>${age} ${plural(age, 'год', 'года', 'лет')} (${esc(new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(s.birthday)))})</span></div>` : ''}
      ${since ? `<div class="info-row"><span class="muted">В клубе</span><span>с ${esc(new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(since).replace(/^\d+\s/, ''))}</span></div>` : ''}
    </div>
    <p class="note" style="text-align:center">По данным официального сайта клуба</p>`);
}

function absList(list) {
  return list.map((p) => `<div class="abs-row"><span class="sq-n">${esc(p.n || '–')}</span><span class="abs-name">${esc(p.name)}<small>${esc(p.pos)}</small></span><span class="abs-tag ${p.reason === 'травма' ? 'inj' : 'sus'}">${esc(p.reason)}</span></div>`).join('');
}

function renderAbsences() {
  const el = $('#absBox');
  if (!el) return;
  const a = absences;
  if (!a?.matchId || !a.homeName) { el.innerHTML = ''; return; }
  const ours = a.homeName === 'Спартак' ? a.home : a.away;
  const opp = a.homeName === 'Спартак' ? a.awayName : a.homeName;
  el.innerHTML = `
    <h3 class="sec-title">Не сыграют против ${esc(opp)}</h3>
    ${ours.length ? `<div class="table-card">${absList(ours)}</div>` : `<div class="empty small">Все игроки «Спартака» в строю 💪</div>`}
    <p class="note">По данным превью матча на Sports.ru. Сроки восстановления источник не указывает.</p>`;
}

function renderTransfers() {
  const el = $('#transfersBox');
  if (!el) return;
  const t = transfers;
  if (!t?.items?.length) { el.innerHTML = ''; return; }
  const row = (x) => `<div class="tr-row">
      <span class="tr-date">${esc(x.date)}</span>
      <span class="tr-main"><b>${esc(x.name)}</b><small>${[x.pos, x.dir === 'in' ? (x.from ? `из «${x.from}»` : '') : `в «${x.to}»`, x.note].filter(Boolean).map(esc).join(' · ')}</small></span>
      <span class="tr-fee">${esc(x.fee || '')}</span>
    </div>`;
  const cleanFrom = (x) => ({ ...x, from: x.from === 'Свободный агент' ? '' : x.from, note: x.from === 'Свободный агент' && !x.note ? 'свободный агент' : x.note });
  const ins = t.items.filter((x) => x.dir === 'in').map(cleanFrom), outs = t.items.filter((x) => x.dir === 'out').map((x) => ({ ...x, note: x.to === 'Свободный агент' && !x.note ? 'свободный агент' : x.note }));
  el.innerHTML = `
    <h3 class="sec-title">Трансферы · ${esc(t.window)}</h3>
    <div class="tr-cols">
      <div><div class="tr-head in">Пришли · ${ins.length}</div><div class="table-card">${ins.map(row).join('') || '<div class="empty small">Нет</div>'}</div></div>
      <div><div class="tr-head out">Ушли · ${outs.length}</div><div class="table-card">${outs.map(row).join('') || '<div class="empty small">Нет</div>'}</div></div>
    </div>
    <p class="note">Источник: <a href="${esc(t.source)}" target="_blank" rel="noopener">Sports.ru</a></p>`;
}

function matchAbsBlock(m) {
  const a = matchAbsences[m.id];
  if (!a || (!a.home?.length && !a.away?.length)) return '';
  const side = (list, name) => `<div class="fm-team"><div class="lu-title">${esc(name)}</div>${list.length ? absList(list) : '<div class="muted small">Все в строю</div>'}</div>`;
  return `<div class="lu-title" style="margin-top:18px">Не сыграют</div>
    <div class="form-grid">${side(a.home || [], m.home.name)}${side(a.away || [], m.away.name)}</div>`;
}

// ---------- Состав ----------
let squad = store.get('spartak-squad', null); // { ts, season, groups }
let squadLoading = false;

async function loadSquad(force = false) {
  const fresh = squad && allPlayers().every(photoOf) ? 60 * MIN : 5 * MIN; // пока фото собираются — чаще
  if (squadLoading || (!force && squad && Date.now() - squad.ts < fresh)) return;
  squadLoading = true;
  try {
    squad = { ...(await getJSON('/squad')), ts: Date.now() };
    store.set('spartak-squad', squad);
  } catch { /* остаётся сохранённый состав */ }
  squadLoading = false;
  renderSquad();
}

const allPlayers = () => (squad?.groups || []).flatMap((g) => g.players);
const absentNames = () => new Set(absences ? (absences.homeName === 'Спартак' ? absences.home : absences.away).map((p) => p.name) : []);

// Фото с официального сайта клуба (папка players/, список в players.js) важнее фото из TheSportsDB
const clubPhotos = new Set(window.CLUB_PHOTOS || []);
const photoOf = (p) => (clubPhotos.has(p.id) ? `players/${p.id}.webp` : p.photo);

function renderSquad() {
  const el = $('#panel-squad');
  if (!squad) { el.innerHTML = `<div class="empty">${squadLoading ? 'Загружаем состав…' : 'Состав пока не загрузился'}</div>`; return; }
  const ps = allPlayers();
  const best = (key) => ps.filter((p) => p[key] > 0).sort((a, b) => b[key] - a[key] || a.apps - b.apps)[0];
  const scorer = best('goals'), assister = best('assists');
  const leader = (p, key, label) => (p ? `<button class="leader" data-player="${esc(p.id)}">
      <div class="leader-lbl">${label}</div><div class="leader-num">${p[key]}</div><div class="leader-name">${esc(p.name)}</div></button>` : '');
  el.innerHTML = `
    <div class="leaders">${leader(scorer, 'goals', 'Бомбардир')}${leader(assister, 'assists', 'Ассистент')}</div>
    <div id="absBox"></div>
    <div id="scorersBox"></div>
    ${squad.groups.map((g) => `
      <div class="sq-group">
        <div class="sq-title"><span>${esc(g.title)}</span><span class="sq-cols"><span>И</span><span>Г</span><span>П</span></span></div>
        <div class="table-card">${g.players.map((p) => `
          <button class="sq-row" data-player="${esc(p.id)}">
            ${avatar(p)}
            <span style="min-width:0"><div class="sq-name">${esc(p.name)}</div>
              <div class="sq-meta">${p.flag ? `<img src="${esc(p.flag)}" alt="" loading="lazy">` : ''}${esc(p.country)}${p.age ? ` · ${p.age} ${plural(p.age, 'год', 'года', 'лет')}` : ''}${p.injured || absentNames().has(p.name) ? ' · <span class="inj">не сыграет</span>' : ''}</div></span>
            <span class="sq-v">${p.apps}</span>
            <span class="sq-v ${p.goals ? 'hot' : ''}">${p.goals}</span>
            <span class="sq-v ${p.assists ? 'hot' : ''}">${p.assists}</span>
          </button>`).join('')}
        </div>
      </div>`).join('')}
    <div class="t-legend"><span><b>И</b> игры</span><span><b>Г</b> голы</span><span><b>П</b> голевые передачи</span></div>
    <p class="note">Статистика в чемпионате · ${esc(squad.season || 'РПЛ')}</p>
    <div id="staffBox"></div>
    <div id="transfersBox"></div>`;
  renderStaff();
  renderAbsences();
  renderScorers();
  renderTransfers();
}

// Фото игрока с номером в уголке; без фото — просто номер
function avatar(p) {
  const photo = photoOf(p);
  if (!photo) return `<span class="sq-n">${esc(p.n || '–')}</span>`;
  const src = photo.endsWith('/small') ? photo.replace(/\/small$/, '/tiny') : photo;
  return `<span class="sq-ph"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg')"><b>${esc(p.n || '')}</b></span>`;
}

function openPlayer(id) {
  const p = allPlayers().find((x) => x.id === id);
  if (!p) return;
  sheetMatchId = null;
  const stat = (v, l) => `<div class="pl-stat"><b>${v ?? 0}</b><span>${l}</span></div>`;
  const gk = p.pos === 'G';
  openSheet(`
    <div class="pl-head">
      ${photoOf(p) ? `<div class="pl-photo"><img src="${esc(photoOf(p))}" alt="${esc(p.name)}"><b>${esc(p.n || '')}</b></div>` : `<div class="pl-n">${esc(p.n || '–')}</div>`}
      <div class="pl-name">${esc(p.name)}</div>
      <div class="pl-sub">${p.flag ? `<img src="${esc(p.flag)}" alt="">` : ''}${esc(p.country)}${p.age ? ` · ${p.age} ${plural(p.age, 'год', 'года', 'лет')}` : ''} · ${esc({ G: 'вратарь', D: 'защитник', M: 'полузащитник', F: 'нападающий' }[p.pos] || '')}</div>
      ${p.injured ? '<div class="pl-sub inj">Травмирован</div>' : ''}
    </div>
    <div class="pl-stats">
      ${stat(p.apps, plural(p.apps, 'матч', 'матча', 'матчей'))}
      ${stat(p.apps - p.subIns, 'в старте')}
      ${stat(p.subIns, 'на замену')}
      ${gk ? stat(p.saves, 'сейвов') + stat(p.conceded, 'пропущено') : stat(p.goals, plural(p.goals, 'гол', 'гола', 'голов')) + stat(p.assists, plural(p.assists, 'передача', 'передачи', 'передач'))}
      ${stat(p.yellow, plural(p.yellow, 'жёлтая', 'жёлтые', 'жёлтых'))}
      ${p.red ? stat(p.red, plural(p.red, 'красная', 'красные', 'красных')) : ''}
    </div>
    <p class="note" style="text-align:center">Чемпионат России · ${esc(squad.season || '')}</p>`);
}

// ---------- Нижняя панель ----------
let sheetMatchId = null;
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  const b = $('#sheetBackdrop');
  b.hidden = false;
  requestAnimationFrame(() => b.classList.add('open'));
  document.body.classList.add('no-scroll');
}
function closeSheet() {
  const b = $('#sheetBackdrop');
  b.classList.remove('open');
  document.body.classList.remove('no-scroll');
  sheetMatchId = null;
  setTimeout(() => { if (!b.classList.contains('open')) b.hidden = true; }, 250);
  if (location.search.includes('match=')) history.replaceState(null, '', location.pathname);
}

// ---------- Карточка матча ----------
let matchTab = 'events';
const EV_ICON = { goal: '⚽', penalty: '⚽', 'own-goal': '⚽', yellow: '🟨', red: '🟥', sub: '🔁' };

async function openMatch(id) {
  const m = findMatch(id);
  if (!m) return;
  sheetMatchId = id;
  matchTab = m.state === 'pre' ? 'form' : 'live';
  if (m.state === 'pre' && m.sportsRu) loadMatchAbsences(id);
  linksOpen = false;
  renderMatchSheet(id, true);
  if (m.src === 'espn') {
    await Promise.all([loadSummary(id, isLive(m) || !summaries[id]), m.state !== 'pre' ? loadLive(id) : null]);
    if (sheetMatchId === id) renderMatchSheet(id, false);
  }
}

function renderMatchSheet(id, opening) {
  const m = findMatch(id);
  if (!m) return;
  const s = summaries[id];
  const started = m.state === 'in' || m.state === 'post';
  const head = `
    <div class="mc-head">
      <div class="mc-comp">${esc(metaLine(m))}${m.rivalry ? ` · <b>${esc(m.rivalry)}</b>` : ''}</div>
      <div class="mc-teams">
        <div class="team">${badge(m.home.logo, 'mc-badge', m.home.name)}<div class="team-name">${esc(m.home.name)}</div></div>
        <div class="mc-score">${started ? `${m.home.score ?? 0}:${m.away.score ?? 0}` : m.timeValid ? fmtTime.format(kickoff(m)) : '—'}
          <div class="mc-state">${isLive(m) ? `<span class="live-dot"></span>${esc(m.clock || 'LIVE')}` : m.state === 'post' ? 'Финал' : esc(cap(fmtWeekday.format(kickoff(m))))}</div></div>
        <div class="team">${badge(m.away.logo, 'mc-badge', m.away.name)}<div class="team-name">${esc(m.away.name)}</div></div>
      </div>
      <div class="mc-actions">
        <button class="btn soft mc-share" data-links="1">📝 Подробная трансляция</button>
        ${m.state === 'post' ? `<button class="btn soft mc-share" data-card="${esc(m.id)}">🖼 Картинка с итогом</button>` : ''}
      </div>
      ${linksOpen ? linksBlock(m) : ''}
    </div>`;

  const tabs = started ? [['live', 'Трансляция'], ['events', 'События'], ['lineups', 'Составы'], ['stats', 'Статистика'], ['form', 'Форма']] : [['form', 'Форма'], ['info', 'О матче']];
  if (!tabs.some(([k]) => k === matchTab)) matchTab = tabs[0][0];
  let body;
  if (m.src !== 'espn') body = `<div class="empty">Подробный отчёт есть только у матчей РПЛ. Ход матча — по кнопке «Подробная трансляция».</div>${infoBlock(m, s)}`;
  else if (!s) body = `<div class="empty">Загружаем отчёт…</div>`;
  else body = { live: liveBlock, events: eventsBlock, lineups: lineupsBlock, stats: statsBlock, form: formBlock, info: infoBlock }[matchTab](m, s);

  const html = `${head}
    ${m.src === 'espn' ? `<div class="seg">${tabs.map(([k, l]) => `<button class="seg-btn ${k === matchTab ? 'active' : ''}" data-mtab="${k}">${l}</button>`).join('')}</div>` : ''}
    <div class="mc-body">${body}</div>`;
  if (opening) openSheet(html);
  else $('#sheetBody').innerHTML = html;
}

// ---------- Подробная трансляция на других сайтах ----------
let linksOpen = false;
function broadcastLinks(m) {
  const vs = `${m.home.name} ${m.away.name}`;
  const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(kickoff(m));
  return [
    ['Sports.ru', m.sportsRu ? 'страница матча с онлайн-трансляцией' : 'календарь «Спартака»', m.sportsRu || 'https://www.sports.ru/football/club/spartak/calendar/'],
    ['Чемпионат', 'поиск матча', `https://www.championat.com/search/?q=${encodeURIComponent(vs)}`],
    ['Спорт-Экспресс', 'раздел РПЛ', 'https://www.sport-express.ru/football/rfpl/'],
    ['Сайт «Спартака»', 'матчи на официальном сайте', 'https://spartak.com/matches'],
    ['Яндекс', 'найти трансляцию', `https://yandex.ru/search/?text=${encodeURIComponent(`${vs} текстовая трансляция ${day}`)}`],
  ];
}
function linksBlock(m) {
  return `<div class="links">${broadcastLinks(m).map(([name, sub, url]) => `
    <a class="link-row" href="${esc(url)}" target="_blank" rel="noopener">
      <span><b>${esc(name)}</b><small>${esc(sub)}</small></span><span class="link-go">↗</span>
    </a>`).join('')}</div>`;
}

// ---------- Текстовая трансляция ----------
const liveFeeds = {}; // id -> { lines, ts }
async function loadLive(id) {
  try { liveFeeds[id] = { ...(await getJSON('/live/' + id)), ts: Date.now() }; } catch { /* нет трансляции */ }
  return liveFeeds[id];
}
const LIVE_ICON = { goal: '⚽', yellow: '🟨', red: '🟥', sub: '🔁', whistle: '📣', shot: '🎯', miss: '💨', corner: '🚩', offside: '🏁', info: '📋' };

function liveBlock(m) {
  const f = liveFeeds[m.id];
  if (!f) return `<div class="empty">Загружаем трансляцию…</div>`;
  if (!f.lines?.length) return `<div class="empty">Трансляция начнётся перед стартовым свистком</div>`;
  return `${isLive(m) ? '<div class="live-note"><span class="live-dot"></span>Обновляется автоматически</div>' : ''}
    <div class="feed">${f.lines.map((l) => `
      <div class="fl ${esc(l.type)} ${l.ours ? 'ours' : ''}">
        <span class="fl-min">${esc(l.minute || '')}</span>
        <span class="fl-icon">${LIVE_ICON[l.type] || '•'}</span>
        <span class="fl-text">${esc(l.text)}</span>
      </div>`).join('')}</div>`;
}

function eventsBlock(m, s) {
  if (!s.events.length) return `<div class="empty">${isLive(m) ? 'Пока без событий' : 'Нет данных о событиях'}</div>${infoBlock(m, s)}`;
  return `<div class="timeline">${s.events.map((e) => `
    <div class="ev ${e.side} ${['goal', 'penalty', 'own-goal'].includes(e.type) ? 'is-goal' : ''}">
      <span class="ev-min">${esc(e.minute)}</span>
      <span class="ev-icon">${EV_ICON[e.type] || '•'}</span>
      <span class="ev-text"><b>${esc(e.player)}</b>${e.type === 'sub' && e.player2 ? `<small>вместо ${esc(e.player2)}</small>` : ''}${e.type === 'penalty' ? '<small>пенальти</small>' : ''}${e.type === 'own-goal' ? '<small>автогол</small>' : ''}</span>
    </div>`).join('')}</div>${infoBlock(m, s)}`;
}

function lineupsBlock(m, s) {
  const col = (side, name) => {
    const l = s.lineups[side];
    if (!l) return `<div class="lu-col"><div class="lu-title">${esc(name)}</div><div class="muted small">Состав не объявлен</div></div>`;
    const row = (p) => `<div class="lu-p"><span class="lu-n">${esc(p.n)}</span><span>${esc(p.name)}</span></div>`;
    return `<div class="lu-col"><div class="lu-title">${esc(name)} <span class="muted">${esc(l.formation)}</span></div>
      ${l.starters.map(row).join('')}
      ${l.subs.length ? `<div class="lu-sub">Запасные</div>${l.subs.map(row).join('')}` : ''}</div>`;
  };
  return `<div class="lineups">${col('home', m.home.name)}${col('away', m.away.name)}</div>`;
}

function statsBlock(m, s) {
  if (!s.stats.length) return `<div class="empty">Статистики пока нет</div>`;
  return `<div class="stats">${s.stats.map((x) => {
    const total = x.home + x.away || 1;
    return `<div class="st">
      <div class="st-row"><b>${x.home}</b><span>${esc(x.label)}</span><b>${x.away}</b></div>
      <div class="st-bar"><i class="h" style="width:${(x.home / total) * 100}%"></i><i class="a" style="width:${(x.away / total) * 100}%"></i></div>
    </div>`;
  }).join('')}</div>`;
}

function formBlock(m, s) {
  const team = (side, name) => {
    const f = s.form[side] || [];
    return `<div class="fm-team"><div class="lu-title">${esc(name)}</div>
      ${f.length ? f.map((g) => `<div class="fm-g"><span class="form-dot ${esc(g.result)}">${RES_LETTER[g.result] || '·'}</span>
        <span class="fm-opp">${g.at === 'away' ? 'в гостях · ' : ''}${esc(g.opp)}</span><b>${esc(g.score)}</b></div>`).join('') : '<div class="muted small">Нет данных</div>'}</div>`;
  };
  const h2h = s.h2h.length ? `<div class="lu-title" style="margin-top:18px">Последние очные встречи</div>
    ${s.h2h.map((g) => `<div class="fm-g"><span class="muted small">${esc(fmtShort.format(new Date(g.date)))}</span>
      <span class="fm-opp">${esc(g.home)} — ${esc(g.away)}</span><b>${g.hs ?? '–'}:${g.as ?? '–'}</b></div>`).join('')}` : '';
  return `<div class="form-grid">${team('home', m.home.name)}${team('away', m.away.name)}</div>${h2h}`;
}

function infoBlock(m, s) {
  const rows = [
    ['Турнир', [m.comp, m.round ? `${m.round} тур` : ''].filter(Boolean).join(', ')],
    ['Начало', `${cap(fmtWeekday.format(kickoff(m)))}${m.timeValid ? ', ' + fmtTime.format(kickoff(m)) : ''}`],
    ['Стадион', m.venue === 'Lukoil Arena' ? 'Лукойл Арена' : m.venue],
    ['Трансляция', m.tv],
    ['Судья', s?.referee],
    ['Зрители', s?.attendance ? s.attendance.toLocaleString('ru-RU') : ''],
  ].filter(([, v]) => v);
  return `${matchAbsBlock(m)}<div class="info">${rows.map(([k, v]) => `<div class="info-row"><span class="muted">${k}</span><span>${esc(v)}</span></div>`).join('')}</div>`;
}

// ---------- Настройки и уведомления ----------
const PREF_LABELS = [['remind', 'За час до матча'], ['start', 'Начало матча'], ['goals', 'Голы'], ['final', 'Финальный счёт'], ['rotor', 'Матчи «Ротора»'], ['alerts', 'Сбои источников данных']];
const THEMES = [['dark', 'Тёмная'], ['light', 'Светлая'], ['classic', 'Классика']];
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = !desk && 'serviceWorker' in navigator && 'PushManager' in window && location.protocol === 'https:';

function saveSettings() { store.set(SETTINGS_KEY, settings); }

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  const color = { dark: '#0d0a0b', light: '#f5f1f1', classic: '#b30f1f' }[settings.theme];
  document.querySelector('meta[name=theme-color]').setAttribute('content', color);
}

async function notifStatus() {
  if (desk) return settings.desktopNotify === false ? 'off' : 'on';
  if (!pushSupported) return isIOS && !standalone ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

async function openSettings() {
  const st = await notifStatus();
  const statusHtml = {
    on: '<span class="ok">Включены</span>',
    off: 'Выключены',
    denied: 'Запрещены в настройках браузера',
    'ios-install': 'Сначала добавьте приложение на экран «Домой»',
    unsupported: 'Этот браузер не поддерживает уведомления',
  }[st];
  const info = desk ? await desk.getInfo() : null;
  openSheet(`
    <h2 class="sh-title">Настройки</h2>

    <div class="sh-section">
      <div class="sh-label">Уведомления · ${statusHtml}</div>
      ${st === 'ios-install' ? `<p class="sh-hint">На iPhone уведомления работают только у приложения на экране «Домой»: в Safari нажмите «Поделиться» → «На экран „Домой“» и откройте приложение оттуда.</p>` : ''}
      <div class="card-list">
        ${PREF_LABELS.map(([k, l]) => `<label class="sw-row"><span>${l}</span><input type="checkbox" data-pref="${k}" ${settings.prefs[k] ? 'checked' : ''}><i class="sw"></i></label>`).join('')}
      </div>
      <div class="sh-actions">
        ${st === 'off' || (desk && st === 'off') ? '<button class="btn primary" id="notifOn">Включить уведомления</button>' : ''}
        ${st === 'on' ? '<button class="btn soft" id="notifTest">Проверить</button><button class="btn soft" id="notifOff">Выключить</button>' : ''}
      </div>
    </div>

    <div class="sh-section">
      <div class="sh-label">Звук</div>
      <div class="card-list">
        <label class="sw-row"><span>Рёв трибун при голе «Спартака»</span><input type="checkbox" id="soundOn" ${settings.sound !== false ? 'checked' : ''}><i class="sw"></i></label>
      </div>
      <div class="sh-actions"><button class="btn soft" id="soundTest">🔊 Послушать</button></div>
    </div>

    <div class="sh-section">
      <div class="sh-label">Оформление</div>
      <div class="seg">${THEMES.map(([k, l]) => `<button class="seg-btn ${settings.theme === k ? 'active' : ''}" data-theme-pick="${k}">${l}</button>`).join('')}</div>
    </div>

    ${info ? `
    <div class="sh-section">
      <div class="sh-label">Программа для ПК</div>
      <div class="card-list">
        <label class="sw-row"><span>Запускать вместе с Windows</span><input type="checkbox" id="autostart" ${info.autostart ? 'checked' : ''}><i class="sw"></i></label>
        <label class="sw-row"><span>При закрытии сворачивать в трей</span><input type="checkbox" id="toTray" ${info.closeToTray ? 'checked' : ''}><i class="sw"></i></label>
      </div>
      <div class="sh-hint" id="updLine">Версия ${esc(info.version)} · ${updateText(info.update)}</div>
      <div class="sh-actions"><button class="btn soft" id="updCheck">Проверить обновления</button></div>
    </div>` : ''}
  `);

  document.querySelectorAll('[data-pref]').forEach((cb) => (cb.onchange = async () => {
    settings.prefs[cb.dataset.pref] = cb.checked;
    saveSettings();
    if (!desk && (await notifStatus()) === 'on') subscribe(true).catch(() => {});
  }));
  $('#soundOn').onchange = (e) => { settings.sound = e.target.checked; saveSettings(); };
  $('#soundTest').onclick = () => playRoar(true);
  document.querySelectorAll('[data-theme-pick]').forEach((b) => (b.onclick = () => {
    settings.theme = b.dataset.themePick; saveSettings(); applyTheme(); openSettings();
  }));
  const on = $('#notifOn'), off = $('#notifOff'), test = $('#notifTest');
  if (on) on.onclick = async () => {
    try {
      if (desk) { settings.desktopNotify = true; saveSettings(); }
      else await subscribe();
      toast('Уведомления включены');
    } catch (e) { toast(e.message || 'Не удалось включить уведомления'); }
    openSettings();
  };
  if (off) off.onclick = async () => {
    if (desk) { settings.desktopNotify = false; saveSettings(); }
    else await unsubscribe();
    toast('Уведомления выключены');
    openSettings();
  };
  if (test) test.onclick = async () => {
    if (desk) { desktopNotify('Уведомления включены', 'Так придёт сообщение о голе «Спартака» ⚽'); return; }
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    try {
      const res = await fetch(API + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      toast(res.ok ? 'Отправили тестовое уведомление' : 'Не удалось отправить');
    } catch { toast('Нет связи с сервером'); }
  };
  if (info) {
    $('#autostart').onchange = (e) => desk.setAutostart(e.target.checked);
    $('#toTray').onchange = (e) => desk.setCloseToTray(e.target.checked);
    $('#updCheck').onclick = () => { desk.checkUpdates(); $('#updLine').textContent = `Версия ${info.version} · проверяем…`; };
  }
}

function updateText(u) {
  if (!u) return 'обновления проверяются автоматически';
  return {
    checking: 'проверяем обновления…',
    none: 'установлена последняя версия',
    available: `найдена версия ${u.version}, скачиваем…`,
    downloading: `скачиваем обновление ${u.percent || 0}%`,
    ready: `версия ${u.version} установится при следующем запуске`,
    error: 'не удалось проверить обновления',
  }[u.state] || '';
}

function b64ToBytes(s) {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribe(updateOnly = false) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (updateOnly) return;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Уведомления не разрешены');
    const { key } = await getJSON('/vapid');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  }
  const res = await fetch(API + '/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub: sub.toJSON(), prefs: settings.prefs }),
  });
  if (!res.ok) throw new Error('Сервер не принял подписку');
}

async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  fetch(API + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe();
}

// ---------- Уведомления в программе для ПК ----------
// Там нет Web Push, поэтому программа сама следит за матчем, пока работает (в том числе свёрнутой в трей).
function desktopNotify(title, body, matchId) {
  const n = new Notification(title, { body, icon: 'icons/icon-192.png', silent: false });
  n.onclick = () => { desk?.focus(); if (matchId) openMatch(matchId); };
}

async function desktopWatch() {
  if (!desk || settings.desktopNotify === false || !data) return;
  const seen = store.get('spartak-notified', {});
  const mark = (k) => { if (seen[k]) return false; seen[k] = Date.now(); return true; };
  const now = Date.now();
  for (const m of data.matches) {
    if (!inWindow(m, now) && !(m.state === 'post' && now - kickoff(m) < 4 * 60 * MIN)) continue;
    const title = `${m.home.name} — ${m.away.name}`;
    const k = kickoff(m).getTime();
    if (settings.prefs.remind && m.timeValid && now >= k - 60 * MIN && now < k && mark('remind:' + m.id)) {
      desktopNotify('Через час матч «Спартака»', `${title}, ${fmtTime.format(kickoff(m))}${m.tv ? ' · ' + m.tv : ''}`, m.id);
    }
    if (m.src !== 'espn' || now < k - 5 * MIN) continue;
    const s = await loadSummary(m.id, true);
    if (!s) continue;
    const first = !seen['watch:' + m.id];
    seen['watch:' + m.id] = now;
    if ((s.state === 'in' || s.state === 'post') && mark('start:' + m.id) && settings.prefs.start && !first) desktopNotify('Матч начался!', title, m.id);
    for (const e of s.events) {
      if (!['goal', 'penalty', 'own-goal'].includes(e.type) || !mark(`goal:${m.id}:${e.id}`)) continue;
      if (first || !settings.prefs.goals) continue; // при первом запуске не засыпаем старыми голами
      const scoredBy = e.type === 'own-goal' ? (e.side === 'home' ? 'away' : 'home') : e.side;
      const ours = (scoredBy === 'home') === m.atHome;
      desktopNotify(ours ? '⚽ ГОЛ «Спартака»!' : 'Гол в ворота «Спартака»',
        `${m.home.name} ${s.home.score ?? 0}:${s.away.score ?? 0} ${m.away.name}\n${e.player} · ${e.minute}`, m.id);
    }
    if (s.state === 'post' && mark('final:' + m.id) && settings.prefs.final && !first) {
      const r = result({ ...m, state: 'post', home: s.home, away: s.away });
      desktopNotify(`Финал: ${{ W: 'Победа! 🔴⚪', D: 'Ничья', L: 'Поражение' }[r] || ''}`, `${m.home.name} ${s.home.score}:${s.away.score} ${m.away.name}`, m.id);
    }
  }
  // Сбой источника дольше 30 минут — одно уведомление на сбой (если включено)
  if (settings.prefs.alerts) {
    for (const p of data.health?.problems || []) {
      if (now - p.since >= 30 * MIN && mark(`health:${p.id}:${p.since}`)) desktopNotify('⚠ Источник данных сломался', p.text);
    }
  }
  for (const [k, t] of Object.entries(seen)) if (now - t > 14 * 24 * 60 * MIN) delete seen[k];
  store.set('spartak-notified', seen);
}

// ---------- Действия ----------
function setBusy(b) { $('#refreshBtn').classList.toggle('spin', b); }

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function downloadIcs(m) {
  const start = kickoff(m), end = new Date(start.getTime() + 2 * 3600e3);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Spartak Matches//RU', 'BEGIN:VEVENT',
    `UID:${m.id}@spartak.kotoryy.ru`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:⚽ ${m.home.name} — ${m.away.name}`,
    `DESCRIPTION:${metaLine(m)}${m.tv ? ' · ' + m.tv : ''}`,
    `LOCATION:${m.venue === 'Lukoil Arena' ? 'Лукойл Арена' : m.venue}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Скоро матч!', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  a.download = `spartak-${start.toISOString().slice(0, 10)}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Событие с напоминанием за час сохранено');
}

async function share(m) {
  const started = m.state === 'in' || m.state === 'post';
  const text = started
    ? `⚽ ${m.home.name} ${m.home.score ?? 0}:${m.away.score ?? 0} ${m.away.name}${isLive(m) ? ` (${m.clock})` : ''}\n${metaLine(m)}`
    : `⚽ ${m.home.name} — ${m.away.name}\n${cap(fmtWeekday.format(kickoff(m)))}${m.timeValid ? ', ' + fmtTime.format(kickoff(m)) : ''}\n${metaLine(m)}${m.tv ? '\n📺 ' + m.tv : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Матч «Спартака»', text, url: location.protocol === 'https:' ? location.origin + '/' : undefined }); } catch { /* отмена */ }
    return;
  }
  try { await navigator.clipboard.writeText(text); toast('Скопировано в буфер обмена'); }
  catch { toast('Не удалось скопировать'); }
}

// ---------- Картинка с итогом матча ----------
function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous'; // иначе холст нельзя будет сохранить
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function drawResultCard(m, s) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const r = result(m);

  // фон: красный градиент с белой полосой, как на форме
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#e1182c'); bg.addColorStop(0.6, '#8a0a17'); bg.addColorStop(1, '#3a040a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.save(); g.translate(W / 2, 560); g.rotate(-0.14);
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(-W, -46, W * 2, 92);
  g.restore();

  g.textAlign = 'center'; g.fillStyle = '#fff';
  g.font = font(700, 38); g.globalAlpha = 0.85;
  g.fillText([m.comp, m.round ? `${m.round} тур` : ''].filter(Boolean).join(' · ').toUpperCase(), W / 2, 120);
  g.font = font(500, 34); g.globalAlpha = 0.7;
  g.fillText(cap(fmtWeekday.format(kickoff(m))) + (m.venue ? ` · ${m.venue === 'Lukoil Arena' ? 'Лукойл Арена' : m.venue}` : ''), W / 2, 172);
  g.globalAlpha = 1;

  // эмблемы и названия
  const [hl, al] = await Promise.all([loadImage(m.home.logo), loadImage(m.away.logo)]);
  const logo = (img, x) => {
    if (!img) return;
    g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 30; g.shadowOffsetY = 12;
    g.drawImage(img, x - 130, 250, 260, 260); g.restore();
  };
  logo(hl, 250); logo(al, W - 250);
  g.font = font(800, 46);
  g.fillText(m.home.name, 250, 580); g.fillText(m.away.name, W - 250, 580);

  // счёт
  g.font = font(900, 210);
  g.fillText(`${m.home.score ?? 0}:${m.away.score ?? 0}`, W / 2, 800);

  // итог для «Спартака»
  const verdict = { W: 'ПОБЕДА!', D: 'НИЧЬЯ', L: 'ПОРАЖЕНИЕ' }[r] || 'ФИНАЛ';
  g.font = font(900, 64);
  const vw = g.measureText(verdict).width + 80;
  g.fillStyle = r === 'W' ? '#ffffff' : 'rgba(255,255,255,0.18)';
  g.beginPath(); g.roundRect(W / 2 - vw / 2, 850, vw, 100, 50); g.fill();
  g.fillStyle = r === 'W' ? '#c8102e' : '#fff';
  g.fillText(verdict, W / 2, 922);

  // авторы голов
  const goals = (s?.events || []).filter((e) => ['goal', 'penalty', 'own-goal'].includes(e.type));
  g.font = font(600, 34); g.fillStyle = '#fff';
  const col = (side, x, align) => {
    g.textAlign = align;
    goals.filter((e) => (e.type === 'own-goal' ? (e.side === 'home' ? 'away' : 'home') : e.side) === side).slice(0, 6)
      .forEach((e, i) => g.fillText(`${e.player} ${e.minute}${e.type === 'penalty' ? ' (п)' : e.type === 'own-goal' ? ' (авт.)' : ''}`, x, 1030 + i * 50));
  };
  col('home', 80, 'left'); col('away', W - 80, 'right');

  // подпись
  g.textAlign = 'center'; g.globalAlpha = 0.75; g.font = font(700, 32);
  g.fillText('🔴⚪ spartak.kotoryy.ru', W / 2, H - 60);
  g.globalAlpha = 1;
  return c;
}

let cardBlob = null;
async function openShareCard(id) {
  const m = findMatch(id);
  if (!m || m.state !== 'post') return;
  sheetMatchId = null;
  openSheet(`<h2 class="sh-title">Итог матча</h2><div class="empty">Рисуем картинку…</div>`);
  const s = m.src === 'espn' ? await loadSummary(id) : null;
  const canvas = await drawResultCard(m, s);
  cardBlob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const url = URL.createObjectURL(cardBlob);
  const name = `spartak-${m.date.slice(0, 10)}.png`;
  const file = new File([cardBlob], name, { type: 'image/png' });
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  $('#sheetBody').innerHTML = `
    <h2 class="sh-title">Итог матча</h2>
    <img class="card-preview" src="${url}" alt="Картинка с итогом матча">
    <div class="sh-actions">
      ${canShareFile ? '<button class="btn primary" id="cardShare">Поделиться</button>' : ''}
      <button class="btn ${canShareFile ? 'soft' : 'primary'}" id="cardSave">Сохранить</button>
    </div>`;
  const sh = $('#cardShare');
  if (sh) sh.onclick = async () => {
    try { await navigator.share({ files: [file], title: `${m.home.name} ${m.home.score}:${m.away.score} ${m.away.name}` }); } catch { /* отмена */ }
  };
  $('#cardSave').onclick = () => {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    toast('Картинка сохранена');
  };
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const ind = $('.tab-indicator');
  // Подсветка — по реальному месту и ширине вкладки (строка вкладок прокручивается на узком экране)
  const place = () => {
    const t = tabs.find((x) => x.classList.contains('active'));
    if (t) { ind.style.left = t.offsetLeft + 'px'; ind.style.width = t.offsetWidth + 'px'; }
  };
  window.addEventListener('resize', place);
  const select = (name) => {
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      if (on) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    place();
    document.body.classList.toggle('tab-rotor', name === 'rotor'); // на вкладке «Ротора» карточка «Спартака» не нужна
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    store.set('spartak-tab', name);
    if (name === 'squad') { loadSquad(); loadSeason(); loadTransfers(); loadAbsences(); }
    if (name === 'table') loadSeason();
    if (name === 'news') openNews();
    if (name === 'rotor') { renderRotor(); loadRotor(); }
  };
  tabs.forEach((t) => (t.onclick = () => select(t.dataset.tab)));
  const saved = store.get('spartak-tab', null);
  if (saved && tabs.some((t) => t.dataset.tab === saved)) select(saved); else place();
}

// ---------- Старт ----------
applyTheme();
setupTabs();
$('#refreshBtn').onclick = () => refresh(true);
$('#settingsBtn').onclick = openSettings;
$('#sheetClose').onclick = closeSheet;
$('#bigClose').onclick = closeBigTimer;
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && bigTimerId) closeBigTimer(); });
$('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); if (bigTimerId) closeBigTimer(); } });
document.addEventListener('click', (e) => {
  const lk = e.target.closest('[data-links]');
  if (lk) { linksOpen = !linksOpen; renderMatchSheet(sheetMatchId, false); return; }
  const rt = e.target.closest('[data-rtab]');
  if (rt) { rotorTab = rt.dataset.rtab; store.set('spartak-rotor-tab', rotorTab); renderRotor(); return; }
  const card = e.target.closest('[data-card]');
  if (card) { openShareCard(card.dataset.card); return; }
  const stf = e.target.closest('[data-staff]');
  if (stf) { openStaff(stf.dataset.staff); return; }
  const pl = e.target.closest('[data-player]');
  if (pl) { openPlayer(pl.dataset.player); return; }
  const open = e.target.closest('[data-open]');
  if (open) { openMatch(open.dataset.open); return; }
  const cd = e.target.closest('#countdown');
  if (cd) { const hm = heroMatch(); if (hm) openBigTimer(hm.id); return; }
  const mt = e.target.closest('[data-mtab]');
  if (mt) { matchTab = mt.dataset.mtab; renderMatchSheet(sheetMatchId, false); }
});
window.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });
setInterval(tickCountdown, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!data || Date.now() - data.updated > 60 * 1000)) refresh();
});
if (desk) desk.onUpdate?.((u) => { const l = $('#updLine'); if (l) l.textContent = `Версия ${u.current || ''} · ${updateText(u)}`; });

render();
loadNews();
refresh().then(() => {
  if (new URLSearchParams(location.search).get('club') === 'rotor') document.querySelector('[data-tab=rotor]')?.click();
  const id = new URLSearchParams(location.search).get('match');
  if (id && findMatch(id)) openMatch(id);
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener?.('message', (e) => {
    if (e.data?.type === 'open-match') openMatch(e.data.id);
  });
}
