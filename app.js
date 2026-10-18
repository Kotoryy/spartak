'use strict';

// ---------- Настройки источника данных ----------
const API = 'https://www.thesportsdb.com/api/v1/json/123';
const TEAM_ID = '134097';   // ФК «Спартак» Москва
const LEAGUE_ID = '4355';   // РПЛ
const CACHE_KEY = 'spartak-cache-v1';
const FRESH_MS = 30 * 60 * 1000;        // как часто обновлять «живые» данные
const ROUND_TTL_MS = 6 * 60 * 60 * 1000; // как часто перепроверять будущие туры
const REQUEST_GAP_MS = 2100;             // пауза между запросами (у бесплатного API лимит ~30 в минуту)
const RETRY_SOON_MS = 2 * 60 * 1000;     // если что-то не загрузилось — повторить через 2 минуты
const ROUNDS_AHEAD = 5;
const ROUNDS_BEHIND = 5;

const TEAM_RU = {
  'Spartak Moscow': 'Спартак',
  'Zenit Saint Petersburg': 'Зенит', 'Zenit St Petersburg': 'Зенит',
  'CSKA Moscow': 'ЦСКА',
  'Dynamo Moscow': 'Динамо',
  'Lokomotiv Moscow': 'Локомотив',
  'Krasnodar': 'Краснодар', 'FK Krasnodar': 'Краснодар',
  'Rostov': 'Ростов', 'FK Rostov': 'Ростов',
  'Rubin Kazan': 'Рубин',
  'Krylia Sovetov Samara': 'Крылья Советов', 'Krylia Sovetov': 'Крылья Советов',
  'Fakel Voronezh': 'Факел',
  'Akhmat Grozny': 'Ахмат',
  'Orenburg': 'Оренбург', 'Gazovik Orenburg': 'Оренбург',
  'Nizhny Novgorod': 'Пари НН', 'Pari Nizhny Novgorod': 'Пари НН',
  'Dynamo Makhachkala': 'Динамо Мх',
  'Akron Togliatti': 'Акрон', 'Akron Tolyatti': 'Акрон',
  'Khimki': 'Химки',
  'Baltika Kaliningrad': 'Балтика',
  'Sochi': 'Сочи', 'PFC Sochi': 'Сочи',
  'Rodina Moscow': 'Родина',
  'Torpedo Moscow': 'Торпедо',
  'Ural Yekaterinburg': 'Урал', 'Ural': 'Урал',
  'Arsenal Tula': 'Арсенал',
  'Chernomorets Novorossiysk': 'Черноморец',
  'KAMAZ': 'КАМАЗ', 'Kamaz Naberezhnye Chelny': 'КАМАЗ',
  'Yenisey Krasnoyarsk': 'Енисей',
  'Shinnik Yaroslavl': 'Шинник',
  'Neftekhimik Nizhnekamsk': 'Нефтехимик',
  'SKA-Khabarovsk': 'СКА-Хабаровск',
  'Tekstilshchik Ivanovo': 'Текстильщик',
  'Volga Ulyanovsk': 'Волга',
  'Spartak Kostroma': 'Спартак Кс',
};
const LEAGUE_RU = {
  'Russian Football Premier League': 'РПЛ',
  'Russia Cup': 'Кубок России',
  'Russian Cup': 'Кубок России',
  'Russian Super Cup': 'Суперкубок',
  'Club Friendlies': 'Товарищеский',
};
const FINISHED = new Set(['FT', 'AET', 'PEN', 'Match Finished', 'AP']);
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'In Progress']);
const CANCELLED = new Set(['PST', 'CANC', 'ABD', 'Postponed', 'Cancelled', 'Match Postponed']);

// ---------- Утилиты ----------
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ru = (name) => TEAM_RU[name] || name || '—';
const leagueRu = (name) => LEAGUE_RU[name] || name || '';

const fmtWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtMon = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
const fmtWdShort = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const fmtStamp = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; } catch { return null; }
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch { /* хранилище недоступно */ }
}

let state = loadCache() || { ts: 0, events: {}, rounds: {}, table: [], season: null };

// ---------- Модель матча ----------
function toMatch(e) {
  const hasTime = e.strTime && e.strTime !== '00:00:00';
  let kickoff;
  if (e.strTimestamp) kickoff = new Date(e.strTimestamp.replace(' ', 'T') + (/[zZ+]/.test(e.strTimestamp.slice(10)) ? '' : 'Z'));
  else kickoff = new Date(`${e.dateEvent}T${hasTime ? e.strTime : '12:00:00'}Z`);

  const home = e.idHomeTeam === TEAM_ID;
  const hs = e.intHomeScore != null && e.intHomeScore !== '' ? Number(e.intHomeScore) : null;
  const as = e.intAwayScore != null && e.intAwayScore !== '' ? Number(e.intAwayScore) : null;
  const status = e.strStatus || '';
  const now = Date.now();
  const k = kickoff.getTime();

  let phase = 'upcoming';
  if (CANCELLED.has(status)) phase = 'postponed';
  else if (FINISHED.has(status) || (hs != null && now > k + 2.5 * 3600e3)) phase = 'finished';
  else if (LIVE.has(status) || (now >= k && now < k + 2 * 3600e3)) phase = 'live';
  else if (now > k + 2.5 * 3600e3) phase = 'finished';

  let result = null;
  if (phase === 'finished' && hs != null && as != null) {
    const my = home ? hs : as, their = home ? as : hs;
    result = my > their ? 'W' : my < their ? 'L' : 'D';
  }

  return {
    id: e.idEvent,
    kickoff, hasTime, home, phase, result, status,
    homeName: ru(e.strHomeTeam), awayName: ru(e.strAwayTeam),
    homeBadge: e.strHomeTeamBadge, awayBadge: e.strAwayTeamBadge,
    opponent: ru(home ? e.strAwayTeam : e.strHomeTeam),
    opponentBadge: home ? e.strAwayTeamBadge : e.strHomeTeamBadge,
    hs, as,
    league: leagueRu(e.strLeague),
    round: e.intRound && e.intRound !== '0' ? e.intRound : null,
    venue: e.strVenue || '',
  };
}

function allMatches() {
  return Object.values(state.events)
    .filter((e) => e.idHomeTeam === TEAM_ID || e.idAwayTeam === TEAM_ID)
    .map(toMatch)
    .sort((a, b) => a.kickoff - b.kickoff);
}

// ---------- Загрузка ----------
async function getJSON(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${API}/${path}`, { cache: 'no-store' });
      if (res.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim().startsWith('{')) { await sleep(4000 * (i + 1)); continue; } // страница лимита Cloudflare
      return JSON.parse(text);
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1500);
    }
  }
  throw new Error('Источник данных временно ограничил запросы');
}

function mergeEvents(list) {
  for (const e of list || []) if (e && e.idEvent) state.events[e.idEvent] = e;
}

let loading = false;
let doneOnce = false; // первая загрузка завершена
async function refresh(force = false) {
  if (loading) return;
  if (!force && Date.now() - state.ts < FRESH_MS && Object.keys(state.events).length) { render(); return; }
  loading = true;
  setBusy(true);
  let errors = 0;
  const step = async (fn) => {
    if (errors >= 2) return; // источник ограничил запросы — не добиваем его, догрузим позже
    try { await fn(); } catch { errors++; }
    render();
    saveCache();
    await sleep(REQUEST_GAP_MS);
  };

  let next = null, last = null;
  await step(async () => { next = (await getJSON(`eventsnext.php?id=${TEAM_ID}`)).events?.[0] || null; mergeEvents([next]); });
  await step(async () => { last = (await getJSON(`eventslast.php?id=${TEAM_ID}`)).results?.[0] || null; mergeEvents([last]); });

  // Определяем текущий тур чемпионата
  const leagueRef = [next, last].find((e) => e && e.idLeague === LEAGUE_ID);
  const season = leagueRef?.strSeason || state.season;
  let round = null;
  if (next && next.idLeague === LEAGUE_ID) round = Number(next.intRound);
  else if (last && last.idLeague === LEAGUE_ID) round = Number(last.intRound) + 1;
  if (season) state.season = season;

  if (season && round) {
    const order = [round];
    for (let i = 1; i <= Math.max(ROUNDS_AHEAD, ROUNDS_BEHIND); i++) {
      if (i <= ROUNDS_AHEAD) order.push(round + i);
      if (i <= ROUNDS_BEHIND) order.push(round - i);
    }
    for (const r of order.filter((r) => r >= 1 && r <= 34)) {
      const key = `${season}:${r}`;
      const info = state.rounds[key];
      if (info && (info.done || (!force && Date.now() - info.ts < ROUND_TTL_MS && r !== round))) continue;
      await step(async () => {
        const events = (await getJSON(`eventsround.php?id=${LEAGUE_ID}&r=${r}&s=${season}`)).events || [];
        const mine = events.filter((e) => e.idHomeTeam === TEAM_ID || e.idAwayTeam === TEAM_ID);
        mergeEvents(mine);
        state.rounds[key] = { ts: Date.now(), done: mine.length > 0 && mine.every((e) => FINISHED.has(e.strStatus)) };
      });
    }
  }

  if (season) {
    await step(async () => {
      const t = (await getJSON(`lookuptable.php?l=${LEAGUE_ID}&s=${season}`)).table;
      if (t && t.length) state.table = t;
    });
  }

  state.ts = errors ? Date.now() - FRESH_MS + RETRY_SOON_MS : Date.now();
  if (errors < 2) state.updated = Date.now();
  saveCache();
  loading = false;
  doneOnce = true;
  setBusy(false);
  render();
  if (errors) toast('Часть данных не загрузилась — догрузим через пару минут');
}

// ---------- Отрисовка ----------
function badge(src, cls, alt = '') {
  if (!src) return `<div class="${cls}" style="border-radius:50%;background:rgba(255,255,255,.15)"></div>`;
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" onerror="this.style.visibility='hidden'">`;
}

function metaLine(m) {
  const parts = [m.league];
  if (m.round) parts.push(`${m.round} тур`);
  if (m.venue) parts.push(m.venue === 'Lukoil Arena' ? 'Лукойл Арена' : m.venue);
  return parts.filter(Boolean).join(' · ');
}

function renderHero(matches) {
  const hero = $('#hero');
  const now = Date.now();
  const m = matches.find((x) => x.phase === 'live') ||
            matches.find((x) => x.phase === 'upcoming' && x.kickoff.getTime() > now - 3 * 3600e3);

  if (!m) {
    const noData = !Object.keys(state.events).length;
    if (noData && !doneOnce) return; // оставляем скелетон
    hero.innerHTML = `<div class="hero-label"><span>Следующий матч</span></div>
      <div class="hero-when" style="padding:30px 0"><div class="hero-date">${noData ? 'Не удалось загрузить расписание' : 'Расписание пока не объявлено'}</div>
      <div class="hero-meta">${noData ? 'Источник данных занят — повторим через пару минут' : 'Загляните позже — данные обновятся автоматически'}</div></div>`;
    return;
  }

  const live = m.phase === 'live';
  const center = live && m.hs != null
    ? `<div class="score-big">${m.hs}:${m.as}</div>`
    : `<div class="vs">VS</div>`;
  const wd = fmtWeekday.format(m.kickoff);
  const dateStr = wd.charAt(0).toUpperCase() + wd.slice(1);
  const timeStr = m.hasTime ? fmtTime.format(m.kickoff) : 'время уточняется';

  hero.innerHTML = `
    <div class="hero-label">
      <span>${live ? 'Сейчас идёт' : 'Следующий матч'}</span>
      ${live ? '<span class="chip live">LIVE</span>' : `<span class="chip">${m.home ? 'Дома' : 'В гостях'}</span>`}
    </div>
    <div class="matchup">
      <div class="team">${badge(m.homeBadge, 'team-badge', m.homeName)}<div class="team-name">${esc(m.homeName)}</div></div>
      ${center}
      <div class="team">${badge(m.awayBadge, 'team-badge', m.awayName)}<div class="team-name">${esc(m.awayName)}</div></div>
    </div>
    <div class="hero-when">
      <div class="hero-date">${esc(dateStr)} · ${esc(timeStr)}</div>
      <div class="hero-meta">${esc(metaLine(m))}</div>
    </div>
    ${live ? '' : `<div class="countdown" id="countdown" data-t="${m.kickoff.getTime()}"></div>`}
    <div class="hero-actions">
      <button class="btn" id="calBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
        В календарь
      </button>
      <button class="btn ghost" id="shareBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>
        Поделиться
      </button>
    </div>`;

  $('#calBtn').onclick = () => downloadIcs(m);
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
  const cells = [
    [d, plural(d, 'день', 'дня', 'дней')],
    [h, plural(h, 'час', 'часа', 'часов')],
    [mi, 'мин'],
    [s, 'сек'],
  ];
  el.innerHTML = cells.map(([n, l]) =>
    `<div class="cd-cell"><div class="cd-num">${String(n).padStart(2, '0')}</div><div class="cd-lbl">${l}</div></div>`).join('');
}

function dateBox(d) {
  return `<div class="date-box"><div class="date-day">${d.getDate()}</div><div class="date-mon">${fmtMon.format(d).replace('.', '')}</div></div>`;
}

function renderUpcoming(matches) {
  const list = matches.filter((m) => m.phase === 'upcoming' || m.phase === 'live' || m.phase === 'postponed');
  const el = $('#panel-upcoming');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${loading || !doneOnce ? 'Загружаем расписание…' : 'Нет запланированных матчей'}</div>`;
    return;
  }
  el.innerHTML = `<div class="list">${list.map((m) => `
    <div class="match">
      ${dateBox(m.kickoff)}
      <div class="match-main">
        <div class="match-teams">${badge(m.opponentBadge, '', m.opponent)}<span>${esc(m.opponent)}</span></div>
        <div class="match-sub">${esc(fmtWdShort.format(m.kickoff))}, ${m.phase === 'postponed' ? 'перенесён' : m.hasTime ? fmtTime.format(m.kickoff) : 'время уточняется'} · ${esc(m.league)}${m.round ? ` · ${m.round} тур` : ''}</div>
      </div>
      <span class="ha ${m.home ? 'home' : ''}">${m.phase === 'live' ? 'LIVE' : m.home ? 'Дома' : 'В гостях'}</span>
    </div>`).join('')}</div>`;
}

function renderResults(matches) {
  const list = matches.filter((m) => m.phase === 'finished').reverse();
  const el = $('#panel-results');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${loading || !doneOnce ? 'Загружаем результаты…' : 'Пока нет сыгранных матчей'}</div>`;
    return;
  }
  const label = { W: 'Победа', D: 'Ничья', L: 'Поражение' };
  const form = list.slice(0, 5).filter((m) => m.result);
  el.innerHTML = `
    ${form.length ? `<div class="form-strip"><span class="lbl">Форма, последние ${form.length}</span>
      <div class="form-dots">${form.slice().reverse().map((m) => `<span class="form-dot ${m.result}">${{ W: 'В', D: 'Н', L: 'П' }[m.result]}</span>`).join('')}</div></div>` : ''}
    <div class="list">${list.map((m) => `
      <div class="match">
        ${dateBox(m.kickoff)}
        <div class="match-main">
          <div class="match-teams">${badge(m.opponentBadge, '', m.opponent)}<span>${esc(m.opponent)}</span></div>
          <div class="match-sub">${m.home ? 'Дома' : 'В гостях'} · ${esc(m.league)}${m.round ? ` · ${m.round} тур` : ''}</div>
        </div>
        <div>
          <div class="res-score">${m.hs ?? '–'}:${m.as ?? '–'}</div>
          ${m.result ? `<span class="res-tag ${m.result}">${label[m.result]}</span>` : ''}
        </div>
      </div>`).join('')}</div>`;
}

function renderTable() {
  const el = $('#panel-table');
  const t = state.table || [];
  if (!t.length) {
    el.innerHTML = `<div class="empty">${loading || !doneOnce ? 'Загружаем таблицу…' : 'Таблица недоступна'}</div>`;
    return;
  }
  const hasMe = t.some((r) => r.idTeam === TEAM_ID);
  el.innerHTML = `
    <div class="table-card">
      <div class="trow head"><span class="pos">#</span><span>Команда</span><span class="num">И</span><span class="pts">О</span></div>
      ${t.map((r) => `
        <div class="trow ${r.idTeam === TEAM_ID ? 'me' : ''}">
          <span class="pos">${esc(r.intRank)}</span>
          <span class="tname">${badge(r.strBadge || r.strTeamBadge, '', r.strTeam)}<span>${esc(ru(r.strTeam))}</span></span>
          <span class="num">${esc(r.intPlayed)}</span>
          <span class="pts">${esc(r.intPoints)}</span>
        </div>`).join('')}
    </div>
    <p class="note">РПЛ, сезон ${esc(state.season || '')}. Бесплатный источник отдаёт только верх таблицы${hasMe ? '' : ' — «Спартака» в нём сейчас нет'}.</p>`;
}

function render() {
  const matches = allMatches();
  renderHero(matches);
  renderUpcoming(matches);
  renderResults(matches);
  renderTable();
  $('#status').textContent = loading
    ? 'Обновляем данные…'
    : state.updated ? `Обновлено ${fmtStamp.format(new Date(state.updated))}` : 'Данные пока не загрузились';
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

function icsDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

function downloadIcs(m) {
  const end = new Date(m.kickoff.getTime() + 2 * 3600e3);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Spartak Matches//RU', 'BEGIN:VEVENT',
    `UID:${m.id}@spartak-matches`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(m.kickoff)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:⚽ ${m.homeName} — ${m.awayName}`,
    `DESCRIPTION:${metaLine(m)}`,
    `LOCATION:${m.venue === 'Lukoil Arena' ? 'Лукойл Арена' : m.venue}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Скоро матч!', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spartak-${m.kickoff.toISOString().slice(0, 10)}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Событие с напоминанием за час сохранено');
}

async function share(m) {
  const text = `⚽ ${m.homeName} — ${m.awayName}\n${fmtWeekday.format(m.kickoff)}${m.hasTime ? ', ' + fmtTime.format(m.kickoff) : ''}\n${metaLine(m)}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Матч «Спартака»', text }); } catch { /* отмена */ }
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
    try { localStorage.setItem('spartak-tab', name); } catch { /* ignore */ }
  };
  tabs.forEach((t) => (t.onclick = () => select(t.dataset.tab)));
  let saved = null;
  try { saved = localStorage.getItem('spartak-tab'); } catch { /* ignore */ }
  if (saved && tabs.some((t) => t.dataset.tab === saved)) select(saved);
}

// ---------- Старт ----------
setupTabs();
$('#refreshBtn').onclick = () => refresh(true);
window.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });
setInterval(tickCountdown, 1000);
setInterval(() => { if (!loading) { render(); refresh(); } }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

render();
refresh();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
