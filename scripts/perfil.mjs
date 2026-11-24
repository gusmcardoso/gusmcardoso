// Perfil vivo do GitHub: gera a sala em pixel art (Porto Nacional, clima e hora reais, rack com os
// sites do Uivo), os números do ano, os cards dos projetos e a grade de atividade.
// Roda pela GitHub Action a cada 4 h. Sem dependências: Node 22+.
//
//   node scripts/perfil.mjs            (usa GITHUB_TOKEN se existir; sem ele, dados públicos)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const USER = 'gusmcardoso';
const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const TZ = 'America/Araguaina'; // fuso do Tocantins
const CITY = { name: 'Porto Nacional', lat: -10.7081, lon: -48.4172 };
const UIVO = 'https://140-238-184-58.sslip.io';
const TOKEN = process.env.GITHUB_TOKEN;
const NOW = process.env.PERFIL_AGORA ? new Date(process.env.PERFIL_AGORA) : new Date();

// paleta do portfólio: preto, verde militar e o laranja do {gm}
const P = {
  bg: '#0a0b08',
  panel: '#11130d',
  line: '#2a2f1f',
  green: '#a3b565',
  greenDark: '#5e6b35',
  greenDeep: '#3a4222',
  text: '#e7e9dc',
  muted: '#8a9079',
  dim: '#4d5240',
  orange: '#f26b1d',
  orangeSoft: '#f7a26b',
};

// ─── dados ────────────────────────────────────────────────────────────────────

async function getJson(url, opts = {}) {
  const headers = { 'user-agent': 'perfil-gusmcardoso', accept: 'application/vnd.github+json', ...(opts.headers ?? {}) };
  if (TOKEN && url.startsWith('https://api.github.com')) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
const safe = async (fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    console.warn('aviso:', err.message);
    return fallback;
  }
};

/** Dias do último ano com a quantidade de contribuições (GraphQL com token; HTML público sem). */
async function contributions() {
  if (TOKEN) {
    const q = `query { user(login: "${USER}") { contributionsCollection {
      totalCommitContributions totalPullRequestContributions restrictedContributionsCount
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }`;
    const r = await getJson('https://api.github.com/graphql', { method: 'POST', body: JSON.stringify({ query: q }) });
    const c = r.data.user.contributionsCollection;
    const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, n: d.contributionCount }));
    return { days, total: c.contributionCalendar.totalContributions };
  }
  const html = await (await fetch(`https://github.com/users/${USER}/contributions`, { signal: AbortSignal.timeout(20_000) })).text();
  const dates = new Map([...html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})" id="(contribution-day-component-[\d-]+)"/g)].map((m) => [m[2], m[1]]));
  const counts = new Map(
    [...html.matchAll(/for="(contribution-day-component-[\d-]+)"[^>]*>(No|\d+) contributions?/g)].map((m) => [m[1], m[2] === 'No' ? 0 : Number(m[2])]),
  );
  const days = [...dates.entries()].map(([id, date]) => ({ date, n: counts.get(id) ?? 0 })).sort((a, b) => a.date.localeCompare(b.date));
  return { days, total: days.reduce((a, d) => a + d.n, 0) };
}

function streaks(days) {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.n > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  // sequência atual: conta de hoje para trás (hoje sem contribuição ainda não quebra)
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].n > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { best, current };
}

const WEATHER = (code) =>
  code === 0
    ? ['céu limpo', 'clear']
    : code <= 2
      ? ['poucas nuvens', 'partly']
      : code === 3
        ? ['nublado', 'cloudy']
        : code <= 48
          ? ['neblina', 'fog']
          : code <= 67 || (code >= 80 && code <= 82)
            ? ['chuva', 'rain']
            : code >= 95
              ? ['tempestade', 'storm']
              : ['nublado', 'cloudy'];

async function loadData() {
  const [repos, contrib, weather, uivo, events, prs] = await Promise.all([
    safe(() => getJson(`https://api.github.com/users/${USER}/repos?per_page=100&type=owner&sort=pushed`), []),
    safe(contributions, { days: [], total: 0 }),
    safe(
      () =>
        getJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${CITY.lat}&longitude=${CITY.lon}&current=temperature_2m,weather_code,is_day&timezone=${encodeURIComponent(TZ)}`,
        ),
      null,
    ),
    safe(() => getJson(`${UIVO}/api/public/status`), null),
    safe(() => getJson(`https://api.github.com/users/${USER}/events/public?per_page=30`), []),
    safe(() => getJson(`https://api.github.com/search/issues?q=author:${USER}+type:pr`), { total_count: 0 }),
  ]);
  // PERFIL_CLIMA="código,dia(1|0),temp" força o clima (só para conferir as variações da cena)
  if (process.env.PERFIL_CLIMA && weather?.current) {
    const [code, day, temp] = process.env.PERFIL_CLIMA.split(',').map(Number);
    Object.assign(weather.current, { weather_code: code, is_day: day, temperature_2m: temp ?? weather.current.temperature_2m });
  }
  const own = repos.filter((r) => !r.fork && !r.private && r.name !== USER);
  const push = events.find((e) => e.type === 'PushEvent' && e.payload?.commits?.length);
  let lastCommit = push ? { repo: push.repo.name.split('/')[1], msg: push.payload.commits.at(-1).message.split('\n')[0] } : null;
  // o feed público de eventos não traz mais as mensagens: busca no repositório mais recente
  if (!lastCommit && own[0]) {
    const c = await safe(() => getJson(`https://api.github.com/repos/${USER}/${own[0].name}/commits?per_page=1`), []);
    if (c[0]) lastCommit = { repo: own[0].name, msg: c[0].commit.message.split('\n')[0] };
  }
  return {
    repos: own,
    stars: own.reduce((a, r) => a + r.stargazers_count, 0),
    prs: prs.total_count ?? 0,
    contrib,
    streak: streaks(contrib.days),
    weather: weather?.current
      ? { temp: Math.round(weather.current.temperature_2m), code: weather.current.weather_code, isDay: weather.current.is_day === 1 }
      : null,
    uivo: uivo?.sites ? { up: uivo.sites.filter((s) => s.status === 'up').length, sites: uivo.sites } : null,
    lastCommit,
  };
}

// ─── fonte em pixel (3×5) ────────────────────────────────────────────────────

const GLYPHS = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', ' ': '000000000000000', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000',
  '·': '000000010000000', '/': '001001010100100', '-': '000000111000000', '%': '101001010100101', '°': '010101010000000',
  '{': '011010110010011', '}': '110010011010110', '>': '100010001010100', $: '011110010011110', _: '000000000000111',
  '+': '000010111010000', '!': '010010010000010', '?': '110001010000010', '(': '010100100100010', ')': '010001001001010',
  '#': '101111101111101', '=': '000111000111000', '*': '000101010101000', "'": '010010000000000',
};
const strip = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

/** Texto em pixels: devolve os retângulos e a largura. */
function pixelText(text, x, y, scale, fill) {
  let cx = x;
  let rects = '';
  for (const ch of strip(text)) {
    const g = GLYPHS[ch] ?? GLYPHS['?'];
    for (let i = 0; i < 15; i++) {
      if (g[i] === '1') rects += `<rect x="${cx + (i % 3) * scale}" y="${y + Math.floor(i / 3) * scale}" width="${scale}" height="${scale}"/>`;
    }
    cx += 4 * scale;
  }
  return { svg: `<g fill="${fill}">${rects}</g>`, width: cx - x - scale };
}
const textWidth = (text, scale) => strip(text).length * 4 * scale - scale;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ─── a sala ────────────────────────────────────────────────────────────────

function localParts() {
  const f = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(NOW).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute), day: p.day, month: p.month };
}

function sala(d) {
  const S = 4; // tamanho do "pixel"
  const W = 220;
  const H = 86;
  const { hour, minute, day, month } = localParts();
  const isDay = d.weather ? d.weather.isDay : hour >= 6 && hour < 18;
  const phase = !isDay ? 'night' : hour < 7 ? 'dawn' : hour >= 17 ? 'dusk' : 'day';
  const [wWord, wKind] = d.weather ? WEATHER(d.weather.code) : ['', 'partly'];
  const out = [];
  // retângulo em "pixels"; anim (opcional) é um <animate> dentro dele
  const px = (x, y, w, h, c, anim = '') => {
    const base = `<rect x="${x * S}" y="${y * S}" width="${w * S}" height="${h * S}" fill="${c}"`;
    out.push(anim ? `${base}>${anim}</rect>` : `${base}/>`);
  };

  // parede e chão
  const wall = { day: '#1b1f14', dawn: '#1d1a16', dusk: '#1f1813', night: '#101309' }[phase];
  px(0, 0, W, H, wall);
  for (let x = 0; x < W; x += 6) px(x, 0, 1, 68, '#00000018'); // listras da parede
  px(0, 68, W, 18, '#15120c');
  for (let y = 70; y < H; y += 4) px(0, y, W, 1, '#0d0b07');
  for (let i = 0; i < 9; i++) px(((i * 37) % W) + 3, 70 + (i % 4) * 4, 1, 4, '#0d0b07');
  px(0, 67, W, 1, '#2b2416');

  // janela: céu, Rio Tocantins e a Catedral de Nossa Senhora das Mercês
  const wx = 40;
  const wy = 8;
  const ww = 76;
  const wh = 48;
  const sky = {
    day: ['#6fa8c9', '#a9d1e3'],
    dawn: ['#6c6f9e', '#e7a77d'],
    dusk: ['#3d3a6b', '#e2814f'],
    night: ['#070b1c', '#152042'],
  }[phase];
  const grey = wKind === 'cloudy' || wKind === 'rain' || wKind === 'storm' || wKind === 'fog';
  for (let i = 0; i < wh; i++) {
    const t = i / wh;
    const mix = (a, b) => {
      const pa = a.match(/\w\w/g).map((h) => Number.parseInt(h, 16));
      const pb = b.match(/\w\w/g).map((h) => Number.parseInt(h, 16));
      return `#${pa.map((v, k) => Math.round(v + (pb[k] - v) * t)).map((v) => (grey ? Math.round(v * 0.72 + 30) : v).toString(16).padStart(2, '0')).join('')}`;
    };
    px(wx, wy + i, ww, 1, mix(sky[0], sky[1]));
  }
  if (phase === 'night') {
    for (let i = 0; i < 18; i++) {
      const sx = wx + 2 + ((i * 29) % (ww - 4));
      const sy = wy + 2 + ((i * 13) % 22);
      px(sx, sy, 1, 1, '#e8eefc', i % 3 === 0 ? `<animate attributeName="opacity" values="1;.2;1" dur="${2 + (i % 4)}s" repeatCount="indefinite"/>` : '');
    }
    if (!grey) {
      px(wx + 58, wy + 6, 6, 6, '#f1ecd2');
      px(wx + 60, wy + 6, 4, 4, sky[0]);
    }
  } else if (!grey) {
    const sx = phase === 'dusk' ? wx + 60 : phase === 'dawn' ? wx + 8 : wx + 56;
    const sy = phase === 'day' ? wy + 5 : wy + 22;
    px(sx, sy, 7, 7, phase === 'day' ? '#fde58a' : '#f6a35b');
    px(sx + 1, sy - 1, 5, 1, phase === 'day' ? '#fde58a' : '#f6a35b');
    px(sx + 1, sy + 7, 5, 1, phase === 'day' ? '#fde58a' : '#f6a35b');
  }
  const cloud = grey ? '#8d929a' : phase === 'night' ? '#2b3350' : '#eef3f6';
  const clouds = wKind === 'clear' ? [] : wKind === 'partly' ? [[6, 6], [38, 11]] : [[2, 4], [24, 8], [46, 3], [60, 10]];
  for (const [cx, cy] of clouds) {
    px(wx + cx, wy + cy + 2, 14, 3, cloud);
    px(wx + cx + 3, wy + cy, 7, 2, cloud);
  }
  if (wKind === 'rain' || wKind === 'storm') {
    for (let i = 0; i < 22; i++) {
      const rx = wx + 2 + ((i * 17) % (ww - 3));
      const ry = wy + 14 + ((i * 7) % 22);
      out.push(
        `<rect x="${rx * S}" y="${ry * S}" width="${S / 2}" height="${S * 2}" fill="#b9d3e6" opacity=".7"><animate attributeName="y" values="${ry * S};${(ry + 6) * S}" dur="${0.8 + (i % 3) * 0.2}s" repeatCount="indefinite"/></rect>`,
      );
    }
  }
  // margem do rio, árvores e a catedral
  const bank = phase === 'night' ? '#1c2614' : '#3e5a2a';
  px(wx, wy + 34, ww, 4, bank);
  const tree = phase === 'night' ? '#121a0c' : '#2c4420';
  for (const tx of [4, 12, 52, 64, 70]) {
    px(wx + tx, wy + 29, 4, 5, tree);
    px(wx + tx + 1, wy + 27, 2, 2, tree);
  }
  const brick = phase === 'night' ? '#3b2418' : '#9b5636';
  const brickDark = phase === 'night' ? '#2a190f' : '#7a4129';
  const cx0 = wx + 26;
  px(cx0, wy + 22, 22, 12, brick); // nave
  px(cx0 + 8, wy + 10, 6, 24, brickDark); // torre central
  px(cx0 + 9, wy + 7, 4, 3, brickDark);
  px(cx0 + 10, wy + 3, 2, 4, '#d9d2b8'); // cruz
  px(cx0 + 9, wy + 4, 4, 1, '#d9d2b8');
  px(cx0 + 10, wy + 14, 2, 3, phase === 'night' ? '#f2c96b' : '#3a2316'); // janela da torre
  for (const ax of [2, 5, 16, 19]) px(cx0 + ax, wy + 26, 1, 3, phase === 'night' ? '#e9b75a' : '#4a2a1a');
  px(cx0 + 9, wy + 29, 4, 5, '#2a170e'); // porta
  // Rio Tocantins com reflexos
  const water = { day: '#3f7fa6', dawn: '#5b6f99', dusk: '#4a4f7d', night: '#0d1733' }[phase];
  px(wx, wy + 38, ww, 10, water);
  for (let i = 0; i < 8; i++)
    out.push(
      `<rect x="${(wx + 3 + i * 9) * S}" y="${(wy + 40 + (i % 3) * 2) * S}" width="${S * 4}" height="${S / 2}" fill="#ffffff" opacity=".25"><animate attributeName="opacity" values=".25;.05;.25" dur="${3 + (i % 3)}s" repeatCount="indefinite"/></rect>`,
    );
  // moldura, cruzeta e peitoril
  const wood = '#3a2a17';
  px(wx - 2, wy - 2, ww + 4, 2, wood);
  px(wx - 2, wy + wh, ww + 4, 2, wood);
  px(wx - 2, wy, 2, wh, wood);
  px(wx + ww, wy, 2, wh, wood);
  px(wx + ww / 2 - 1, wy, 1, wh, '#3a2a1799');
  px(wx - 4, wy + wh + 2, ww + 8, 2, '#4a3720');
  // vaso no peitoril (o agro)
  px(wx + 6, wy + wh - 1, 5, 3, '#7b4a2a');
  px(wx + 5, wy + wh - 9, 2, 5, '#4f7a2e');
  px(wx + 8, wy + wh - 11, 2, 7, '#5d8c36');
  px(wx + 10, wy + wh - 8, 2, 4, '#4f7a2e');

  // estante: a stack em livros
  const stack = [
    ['PHP', '#4f5d95'], ['Laravel', '#ff2d20'], ['TypeScript', '#3178c6'], ['JavaScript', '#f1e05a'],
    ['Node.js', '#3c873a'], ['Python', '#3572a5'], ['React', '#61dafb'], ['WordPress', '#21759b'],
    ['Docker', '#2496ed'], ['GitHub Actions', '#2088ff'], ['Nginx', '#009639'], ['Power BI', '#f2c811'],
  ];
  const bx = 6;
  px(bx, 16, 26, 51, '#2a1f12');
  px(bx + 1, 17, 24, 49, '#140f08');
  let i = 0;
  for (const shelf of [0, 1, 2]) {
    const sy = 17 + shelf * 16;
    let x = bx + 2;
    for (let k = 0; k < 4; k++, i++) {
      const [name, color] = stack[i];
      const h = 9 + ((i * 7) % 5);
      const w = 4 + (i % 2);
      out.push(`<g><title>${esc(name)}</title>`);
      px(x, sy + 14 - h, w, h, color);
      px(x, sy + 14 - h + 2, w, 1, '#00000040');
      out.push('</g>');
      x += w + 1;
    }
    px(bx + 1, sy + 14, 24, 2, '#3a2a17');
  }

  // quadro com o {gm}
  px(6, 2, 26, 12, '#3a2a17'); // quadro em cima da estante
  px(7, 3, 24, 10, '#0d0f09');
  out.push(pixelText('{', 9 * S, 5.5 * S, S, P.orange).svg.replace('<g ', '<g '));
  const gm = pixelText('GM', 13 * S, 5.5 * S, S, P.text);
  out.push(gm.svg);
  out.push(pixelText('}', 13 * S + gm.width + S, 5.5 * S, S, P.orange).svg);

  // relógio com a hora local
  const ox = 181;
  const oy = 3;
  px(ox, oy, 12, 12, '#d8cfb4');
  px(ox + 1, oy + 1, 10, 10, '#f3ecd5');
  const ang = (v, max) => (v / max) * Math.PI * 2 - Math.PI / 2;
  const hand = (len, a, color, width) => {
    const x2 = (ox + 6) * S + Math.cos(a) * len * S;
    const y2 = (oy + 6) * S + Math.sin(a) * len * S;
    out.push(`<line x1="${(ox + 6) * S}" y1="${(oy + 6) * S}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-linecap="square"/>`);
  };
  hand(3, ang((hour % 12) + minute / 60, 12), '#2a2216', 3);
  hand(4.4, ang(minute, 60), '#2a2216', 2);

  // rack do servidor: um LED por site no Uivo (verde no ar, vermelho fora)
  const rx = 198;
  px(rx, 14, 18, 53, '#1a1c16');
  px(rx + 1, 15, 16, 51, '#0b0c09');
  const sites = d.uivo?.sites ?? [];
  for (let u = 0; u < 6; u++) {
    const uy = 17 + u * 8;
    px(rx + 2, uy, 14, 6, '#202319');
    px(rx + 3, uy + 1, 8, 1, '#2d3124');
    px(rx + 3, uy + 3, 8, 1, '#2d3124');
    const site = sites[u];
    const color = !site ? '#2d3124' : site.status === 'up' ? '#44d17a' : site.status === 'down' ? '#ef4444' : '#a1a1aa';
    out.push(`<g>${site ? `<title>${esc(site.name)}: ${site.status === 'up' ? 'no ar' : site.status === 'down' ? 'fora do ar' : 'aguardando'}</title>` : ''}`);
    px(rx + 13, uy + 2, 2, 2, color, site ? `<animate attributeName="opacity" values="1;${site.status === 'up' ? '.55' : '.15'};1" dur="${1.4 + u * 0.37}s" repeatCount="indefinite"/>` : '');
    out.push('</g>');
  }

  // mesa, monitor com o terminal e cadeira
  px(118, 51, 76, 3, '#4a3720');
  px(121, 54, 3, 13, '#3a2a17');
  px(188, 54, 3, 13, '#3a2a17');
  px(124, 16, 54, 28, '#202319'); // monitor
  px(125, 17, 52, 25, '#070806');
  px(148, 44, 6, 7, '#202319');
  px(144, 50, 14, 1, '#202319');
  const up = d.uivo ? `${d.uivo.up}/${d.uivo.sites.length} sites no ar` : 'status indisponível';
  const commit = d.lastCommit ? d.lastCommit.msg : 'sem commits públicos recentes';
  const lines = [
    [P.green, '~ $ uivo status'],
    [P.text, up],
    [P.green, '~ $ git log -1 --oneline'],
    [P.text, commit.length > 28 ? `${commit.slice(0, 27)}…` : commit],
  ];
  lines.forEach(([color, t], k) => {
    out.push(`<text x="${127 * S}" y="${(21 + k * 4.6) * S}" fill="${color}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="10.5">${esc(t)}</text>`);
  });
  out.push(`<rect x="${127 * S}" y="${(20.6 + 4 * 4.6) * S - 9}" width="6" height="11" fill="${P.green}"><animate attributeName="opacity" values="1;1;0;0" dur="1.1s" repeatCount="indefinite"/></rect>`);
  // caneca com vapor
  px(180, 46, 5, 5, '#d8cfb4');
  px(185, 47, 1, 3, '#d8cfb4');
  px(181, 47, 3, 1, '#6b3f1f');
  for (let k = 0; k < 2; k++)
    out.push(
      `<rect x="${(181 + k * 2) * S}" y="${42 * S}" width="${S}" height="${S * 2}" fill="#d8cfb4" opacity=".5"><animate attributeName="y" values="${43 * S};${39 * S}" dur="${2 + k * 0.6}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".5;0" dur="${2 + k * 0.6}s" repeatCount="indefinite"/></rect>`,
    );
  // cadeira (de costas, na frente da mesa)
  px(152, 47, 16, 11, '#23261b');
  px(154, 49, 12, 7, '#2f3324');
  px(150, 58, 20, 2, '#2c2f22');
  px(159, 60, 2, 5, '#23261b');
  px(153, 65, 14, 2, '#23261b');

  // legenda: cidade, clima e quando foi atualizado
  px(0, 76, W, 10, '#00000066');
  const left = d.weather ? `${CITY.name} · ${d.weather.temp}°C · ${wWord}` : CITY.name;
  out.push(pixelText(left, 3 * S, 78.5 * S, 2, P.orangeSoft).svg);
  const right = `atualizado ${day}/${month} ${String(hour).padStart(2, '0')}h${String(minute).padStart(2, '0')}`;
  out.push(pixelText(right, W * S - 3 * S - textWidth(right, 2), 78.5 * S, 2, P.green).svg);

  const alt = `Sala em pixel art: estante com a stack, janela com a Catedral de Porto Nacional e o Rio Tocantins (${left}), rack com ${up}, mesa com o terminal e o quadro {gm}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${H * S}" viewBox="0 0 ${W * S} ${H * S}" shape-rendering="crispEdges" role="img" aria-label="${esc(alt)}"><title>${esc(alt)}</title>${out.join('')}</svg>`;
}

// ─── painéis ───────────────────────────────────────────────────────────────

const frame = (w, h, inner, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="${P.panel}" stroke="${P.line}"/>${inner}</svg>`;

function cabecalho() {
  const w = 880;
  const h = 120;
  let inner = '';
  inner += pixelText('{', 28, 30, 6, P.orange).svg;
  const gm = pixelText('GM', 28 + 24, 30, 6, P.text);
  inner += gm.svg + pixelText('}', 28 + 24 + gm.width + 6, 30, 6, P.orange).svg;
  inner += pixelText('Gustavo Martins', 160, 28, 4, P.text).svg;
  inner += pixelText('analista de sistemas · fullstack e devops', 160, 58, 2, P.green).svg;
  inner += pixelText('porto nacional / to · brasil', 160, 76, 2, P.muted).svg;
  inner += `<text x="${w - 28}" y="92" text-anchor="end" fill="${P.muted}" font-family="ui-monospace,Consolas,monospace" font-size="11.5">php · laravel · typescript · react · docker · actions</text>`;
  return frame(w, h, inner, 'Gustavo Martins: analista de sistemas, fullstack e DevOps, Porto Nacional/TO.');
}

function numeros(d) {
  const items = [
    [String(d.contrib.total), 'contribuições no ano'],
    [String(d.prs), 'pull requests'],
    [d.uivo ? `${d.uivo.up}/${d.uivo.sites.length}` : '—', 'sites no ar (uivo)'],
    [`${d.streak.best}d`, 'maior sequência'],
  ];
  const w = 880;
  const h = 112;
  const cw = (w - 3 * 12) / 4;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img" aria-label="Números do ano no GitHub"><title>Números do ano no GitHub</title>`;
  items.forEach(([value, label], i) => {
    const x = i * (cw + 12);
    svg += `<rect x="${x + 0.5}" y="0.5" width="${cw - 1}" height="${h - 1}" fill="${P.panel}" stroke="${P.line}"/>`;
    svg += pixelText(value, x + 20, 22, 7, i === 2 ? P.green : P.orange).svg;
    svg += pixelText(label, x + 20, 80, 2, P.muted).svg;
  });
  return `${svg}</svg>`;
}

function atividade(d) {
  const w = 880;
  const h = 190;
  const days = d.contrib.days.slice(-364);
  const max = Math.max(1, ...days.map((x) => x.n));
  const level = (n) => (n === 0 ? 0 : n >= max * 0.75 ? 4 : n >= max * 0.5 ? 3 : n >= max * 0.25 ? 2 : 1);
  const colors = ['#1a1d14', P.greenDeep, P.greenDark, P.green, P.orange];
  let inner = pixelText('> atividade', 24, 22, 2, P.orange).svg;
  const cell = 10;
  const gap = 3;
  const first = days[0] ? new Date(`${days[0].date}T12:00:00Z`).getUTCDay() : 0;
  days.forEach((x, k) => {
    const idx = k + first;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    inner += `<rect x="${24 + col * (cell + gap)}" y="${44 + row * (cell + gap)}" width="${cell}" height="${cell}" fill="${colors[level(x.n)]}"><title>${x.date}: ${x.n}</title></rect>`;
  });
  inner += `<text x="24" y="${44 + 7 * (cell + gap) + 18}" fill="${P.dim}" font-family="ui-monospace,Consolas,monospace" font-size="10">menos</text>`;
  colors.forEach((c, k) => {
    inner += `<rect x="${64 + k * 13}" y="${44 + 7 * (cell + gap) + 9}" width="${cell}" height="${cell}" fill="${c}"/>`;
  });
  inner += `<text x="${64 + 5 * 13 + 4}" y="${44 + 7 * (cell + gap) + 18}" fill="${P.dim}" font-family="ui-monospace,Consolas,monospace" font-size="10">mais</text>`;
  const sx = 24 + 53 * (cell + gap) + 26;
  const stat = (y, label, value) => pixelText(label, sx, y, 2, P.muted).svg + pixelText(value, sx, y + 16, 4, P.text).svg;
  inner += stat(44, 'sequência atual', `${d.streak.current} dias`);
  inner += stat(92, 'maior sequência', `${d.streak.best} dias`);
  inner += stat(140, 'no último ano', String(d.contrib.total));
  return frame(w, h, inner, 'Atividade no GitHub: grade de contribuições e sequências');
}

/** Ícone em pixel art de cada projeto (12×12). */
const ICONS = {
  uivo: [
    '............',
    '.##..##.....',
    '.##..##..#..',
    '.##..##...#.',
    '.##..##.#..#',
    '.##..##..#.#',
    '.##..##..#.#',
    '.##..##.#..#',
    '.######...#.',
    '..####...#..',
    '............',
    '............',
  ],
  portfolio: [
    '............',
    '.##......##.',
    '.#........#.',
    '.#..####..#.',
    '##.#....#.##',
    '.#.#....#.#.',
    '.#..#####.#.',
    '.#......#.#.',
    '.##..###..##',
    '............',
    '............',
    '............',
  ],
  _: [
    '............',
    '############',
    '#..........#',
    '#.#........#',
    '#..#.......#',
    '#...#......#',
    '#..#.......#',
    '#.#..####..#',
    '#..........#',
    '############',
    '............',
    '............',
  ],
};

const DESCRICOES = {
  uivo: 'Monitor de saúde de sites: uptime, SSL, domínio, segurança e relatório em PDF',
  portfolio: 'Meu site pessoal, com CI/CD, container e deploy automático',
};

function projeto(r) {
  const w = 430;
  const h = 124;
  const icon = ICONS[r.name] ?? ICONS._;
  let inner = `<rect x="20" y="22" width="80" height="80" fill="#0d0f09"/>`;
  icon.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === '#') inner += `<rect x="${28 + x * 5.5}" y="${30 + y * 5.5}" width="5.5" height="5.5" fill="${r.name === 'uivo' && x > 6 ? '#7dd3fc' : r.name === 'portfolio' && (x < 3 || x > 8) ? P.orange : P.green}"/>`;
    }),
  );
  inner += pixelText(r.name, 118, 26, 3, P.orange).svg;
  const desc = (r.description || DESCRICOES[r.name] || 'ver projeto').trim();
  // quebra em até 2 linhas que cabem no card (~42 caracteres cada)
  const cut = desc.lastIndexOf(' ', 42);
  const lines = desc.length > 42 && cut > 0 ? [desc.slice(0, cut), desc.slice(cut + 1)] : [desc];
  lines.forEach((l, k) => {
    inner += `<text x="118" y="${62 + k * 15}" fill="${P.text}" font-family="ui-monospace,Consolas,monospace" font-size="11.5">${esc(l.length > 44 ? `${l.slice(0, 43)}…` : l)}</text>`;
  });
  const when = new Date(r.pushed_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: TZ }).replace('.', '');
  inner += `<text x="118" y="102" fill="${P.muted}" font-family="ui-monospace,Consolas,monospace" font-size="11">${esc(r.language ?? '—')} · ★ ${r.stargazers_count} · ${esc(when)}</text>`;
  return frame(w, h, inner, `${r.name}: ${desc}`);
}

// ─── README ─────────────────────────────────────────────────────────────────

function updateReadme(repos) {
  const file = path.join(ROOT, 'README.md');
  const md = readFileSync(file, 'utf8');
  const cards = repos
    .slice(0, 6)
    .map((r) => `  <a href="${r.html_url}"><img src="assets/projeto-${r.name}.svg" alt="${esc(r.name)}: ${esc(r.description || DESCRICOES[r.name] || 'ver projeto')}" width="49%" /></a>`)
    .join('\n');
  const block = `<!-- PROJETOS:INICIO -->\n<p align="left">\n${cards}\n</p>\n<!-- PROJETOS:FIM -->`;
  const next = md.replace(/<!-- PROJETOS:INICIO -->[\s\S]*?<!-- PROJETOS:FIM -->/, block);
  if (next !== md) writeFileSync(file, next);
}

const d = await loadData();
mkdirSync(ASSETS, { recursive: true });
writeFileSync(path.join(ASSETS, 'sala.svg'), sala(d));
writeFileSync(path.join(ASSETS, 'cabecalho.svg'), cabecalho());
writeFileSync(path.join(ASSETS, 'numeros.svg'), numeros(d));
writeFileSync(path.join(ASSETS, 'atividade.svg'), atividade(d));
for (const r of d.repos.slice(0, 6)) writeFileSync(path.join(ASSETS, `projeto-${r.name}.svg`), projeto(r));
updateReadme(d.repos);
console.log(
  JSON.stringify({
    repos: d.repos.map((r) => r.name),
    contribuicoes: d.contrib.total,
    sequencia: d.streak,
    prs: d.prs,
    clima: d.weather,
    uivo: d.uivo && `${d.uivo.up}/${d.uivo.sites.length}`,
    commit: d.lastCommit,
  }),
);
