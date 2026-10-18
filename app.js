'use strict';

// ---------- Настройки ----------
const API = 'https://spartak-api.kotoryy.ru'; // облачный сервер из папки cloud/
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

let data = store.get(DATA_KEY, null);       // { updated, season, matches, table }
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
async function getJSON(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API + path, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

let pollTimer;
async function refresh(manual = false) {
  if (loading) return;
  loading = true;
  setBusy(true);
  try {
    const fresh = await getJSON('/data');
    const prev = data;
    data = fresh;
    store.set(DATA_KEY, data);
    detectGoals(prev, data);
    const hm = heroMatch();
    if (hm && hm.src === 'espn' && (isLive(hm) || hm.state === 'post')) await loadSummary(hm.id, true);
    desktopWatch();
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

function celebrate() {
  const o = $('#goalOverlay');
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
  try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* нет вибрации */ }
  setTimeout(() => o.classList.remove('show'), 3800);
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
  $('#shareBtn').onclick = () => share(m);
  tickCountdown();
}

function tickCountdown() {
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
      <div class="trow head"><span class="pos">#</span><span>Команда</span><span class="num">И</span><span class="num wide">В</span><span class="num wide">Н</span><span class="num wide">П</span><span class="num">±</span><span class="pts">О</span></div>
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
    <p class="note"><span class="legend po"></span>стыковые матчи <span class="legend out"></span>вылет · ${esc(data.season || 'РПЛ')}</p>`;
}

function render() {
  renderHero();
  renderUpcoming();
  renderResults();
  renderTable();
  $('#status').textContent = loading ? 'Обновляем данные…'
    : data?.updated ? `Обновлено ${fmtStamp.format(new Date(data.updated))}` : 'Данные пока не загрузились';
  if (sheetMatchId) renderMatchSheet(sheetMatchId, false);
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
  matchTab = m.state === 'pre' ? 'form' : 'events';
  renderMatchSheet(id, true);
  if (m.src === 'espn') {
    await loadSummary(id, isLive(m) || !summaries[id]);
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
    </div>`;

  const tabs = started ? [['events', 'События'], ['lineups', 'Составы'], ['stats', 'Статистика'], ['form', 'Форма']] : [['form', 'Форма'], ['info', 'О матче']];
  if (!tabs.some(([k]) => k === matchTab)) matchTab = tabs[0][0];
  let body;
  if (m.src !== 'espn') body = `<div class="empty">Для кубковых матчей подробного отчёта нет.</div>${infoBlock(m, s)}`;
  else if (!s) body = `<div class="empty">Загружаем отчёт…</div>`;
  else body = { events: eventsBlock, lineups: lineupsBlock, stats: statsBlock, form: formBlock, info: infoBlock }[matchTab](m, s);

  const html = `${head}
    ${m.src === 'espn' ? `<div class="seg">${tabs.map(([k, l]) => `<button class="seg-btn ${k === matchTab ? 'active' : ''}" data-mtab="${k}">${l}</button>`).join('')}</div>` : ''}
    <div class="mc-body">${body}</div>`;
  if (opening) openSheet(html);
  else $('#sheetBody').innerHTML = html;
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
  return `<div class="info">${rows.map(([k, v]) => `<div class="info-row"><span class="muted">${k}</span><span>${esc(v)}</span></div>`).join('')}</div>`;
}

// ---------- Настройки и уведомления ----------
const PREF_LABELS = [['remind', 'За час до матча'], ['start', 'Начало матча'], ['goals', 'Голы'], ['final', 'Финальный счёт']];
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

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const ind = $('.tab-indicator');
  const select = (name) => {
    tabs.forEach((t, i) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      if (on) ind.style.transform = `translateX(${i * 100}%)`;
    });
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    store.set('spartak-tab', name);
  };
  tabs.forEach((t) => (t.onclick = () => select(t.dataset.tab)));
  const saved = store.get('spartak-tab', null);
  if (saved && tabs.some((t) => t.dataset.tab === saved)) select(saved);
}

// ---------- Старт ----------
applyTheme();
setupTabs();
$('#refreshBtn').onclick = () => refresh(true);
$('#settingsBtn').onclick = openSettings;
$('#sheetClose').onclick = closeSheet;
$('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { openMatch(open.dataset.open); return; }
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
refresh().then(() => {
  const id = new URLSearchParams(location.search).get('match');
  if (id && findMatch(id)) openMatch(id);
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener?.('message', (e) => {
    if (e.data?.type === 'open-match') openMatch(e.data.id);
  });
}
