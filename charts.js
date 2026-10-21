'use strict';
// Линейные графики на SVG без библиотек: тонкие линии, точки с кольцом цвета фона,
// подписи прямо у линий, перекрестие и подсказка при наведении/касании.
// Цвета серий — CSS-переменные (--s1…--s3, --s-red), подобранные и проверенные для каждой темы.

window.lineChart = function lineChart(el, opt) {
  const { series, labels, yMin, yMax, invert = false, yTicks, tip, endLabel, height = 220, ariaLabel = '' } = opt;
  const W = Math.max(280, el.clientWidth || 340), H = height;
  const pad = { l: 30, r: opt.rightPad ?? 86, t: 14, b: 26 };
  const n = labels.length;
  const x = (i) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v) => {
    const f = (v - yMin) / (yMax - yMin || 1);
    return invert ? pad.t + f * (H - pad.t - pad.b) : H - pad.b - f * (H - pad.t - pad.b);
  };
  const step = n > 16 ? 3 : n > 10 ? 2 : 1;

  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${ariaLabel}">`;
  // Сетка и оси — приглушённые
  for (const t of yTicks) svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) svg += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${l}</text>`; });
  svg += `<line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>`;

  // Линии и точки
  for (const s of series) {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    svg += `<polyline class="line" style="stroke:var(${s.color})" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
    for (const [px, py] of s.values.length <= 20 ? pts : [pts.at(-1)]) svg += `<circle class="dot" cx="${px}" cy="${py}" r="4" style="fill:var(${s.color})"/>`;
  }

  // Подписи у концов линий; если совпадают по высоте — разводим не меньше чем на 15px
  const ends = series.map((s) => ({ s, py: y(s.values.at(-1)) })).sort((a, b) => a.py - b.py);
  for (let i = 1; i < ends.length; i++) if (ends[i].py - ends[i - 1].py < 15) ends[i].py = ends[i - 1].py + 15;
  for (const e of ends) svg += `<text class="end-label" x="${x(n - 1) + 9}" y="${e.py + 4}">${endLabel(e.s)}</text>`;

  // Зоны наведения шире самих точек
  labels.forEach((_, i) => {
    const w = (W - pad.l - pad.r) / Math.max(1, n - 1);
    svg += `<rect class="hit" data-i="${i}" x="${x(i) - w / 2}" y="${pad.t}" width="${w}" height="${H - pad.t - pad.b}"/>`;
  });
  svg += '</svg>';
  el.innerHTML = `<div class="chart-wrap">${svg}<div class="chart-tip" hidden></div></div>`;

  const root = el.querySelector('svg'), tipEl = el.querySelector('.chart-tip'), cross = el.querySelector('.cross');
  const show = (i) => {
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    tipEl.innerHTML = tip(i);
    tipEl.hidden = false;
    const box = el.querySelector('.chart-wrap').getBoundingClientRect(), scale = box.width / W;
    const left = Math.min(Math.max(x(i) * scale - tipEl.offsetWidth / 2, 0), box.width - tipEl.offsetWidth);
    tipEl.style.left = left + 'px';
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tipEl.hidden = true; };
  root.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointerenter', () => show(Number(r.dataset.i)));
    r.addEventListener('pointerdown', () => show(Number(r.dataset.i)));
  });
  root.addEventListener('pointerleave', hide);
};
