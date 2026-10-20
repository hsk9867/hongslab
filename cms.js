// 홍스랩 관리자 모듈: 콘텐츠 덮어쓰기(HTMLRewriter) · 방문 추적 · 통계 · 로그인
// worker.js 가 /api/seo-check 를 제외한 모든 요청을 이 모듈의 handleCms 로 넘긴다.
// 저장소: D1 (binding DB). settings(key,value) 에 덮어쓴 문구와 포트폴리오/FAQ JSON, hits 에 방문 기록.

const SELF_HOSTS = new Set(['hongslab.kr', 'www.hongslab.kr', 'hongslab.hsk9867.workers.dev', 'localhost', '127.0.0.1']);
const COOKIE = 'hl_admin';
const SESSION_DAYS = 30;
const SETTINGS_TTL = 30 * 1000;
const KST_OFFSET = 9 * 3600;

let settingsCache = { at: 0, map: null };

// ---------- 공통 ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 관리자가 입력한 문구를 HTML 로: **강조** → 빨간 강조, __굵게__ → b, 줄바꿈 → <br>
function rich(v) {
  return esc(v)
    .replace(/\*\*(.+?)\*\*/g, '<span class="hl">$1</span>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/\r?\n/g, '<br>');
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
function kst(ts) {
  const d = new Date((ts + KST_OFFSET) * 1000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function sameOrigin(request, url) {
  const o = request.headers.get('origin');
  if (!o) return true; // sendBeacon / 같은 출처 GET 은 origin 이 없을 수 있음
  try { return new URL(o).host === url.host; } catch { return false; }
}

// ---------- 설정(덮어쓴 문구) ----------

export async function loadSettings(env, force) {
  if (!env.DB) return new Map();
  if (!force && settingsCache.map && Date.now() - settingsCache.at < SETTINGS_TTL) return settingsCache.map;
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
    const map = new Map(results.map((r) => [r.key, r.value]));
    settingsCache = { at: Date.now(), map };
    return map;
  } catch (e) {
    return settingsCache.map || new Map();
  }
}
function parseJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

// ---------- 인증 ----------

async function hmacKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + '|hongslab-admin|v1'));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function makeToken(secret) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(exp));
  return exp + '.' + b64url(sig);
}
async function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const i = token.indexOf('.');
  if (i < 0) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  try {
    const key = await hmacKey(secret);
    return await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), new TextEncoder().encode(exp));
  } catch { return false; }
}
export async function isAdmin(request, env) {
  const t = getCookie(request, COOKIE);
  if (!t) return false;
  return verifyToken(env.ADMIN_PASSWORD, t);
}
function cookieHeader(value, url, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

// ---------- HTML 변환 ----------

function faqGroupsHtml(groups) {
  let n = 0;
  return groups.map((g) => {
    const items = (g.items || []).filter((it) => it && it.q);
    const list = items.map((it) => {
      n++;
      return `<details${n === 1 ? ' open' : ''}><summary><span class="q">질문 ${String(n).padStart(2, '0')}</span>${esc(it.q)}<span class="pm"></span></summary><p class="a">${esc(it.a || '')}</p></details>`;
    }).join('\n            ');
    return `        <div class="group">\n          <h2>${esc(g.title || '')}</h2>\n          <div class="list">\n            ${list}\n          </div>\n        </div>\n`;
  }).join('');
}
function faqLdJson(groups) {
  const qs = [];
  for (const g of groups) for (const it of g.items || []) if (it && it.q) qs.push({ '@type': 'Question', name: it.q, acceptedAnswer: { '@type': 'Answer', text: it.a || '' } });
  const ld = { '@context': 'https://schema.org', '@graph': [{ '@type': 'FAQPage', '@id': 'https://hongslab.kr/faq#faq', url: 'https://hongslab.kr/faq', name: '홍스랩 자주 묻는 질문', mainEntity: qs }] };
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

export function transformHtml(res, s, { path, track }) {
  const rw = new HTMLRewriter();
  if (s.size) {
    rw.on('[data-cms]', {
      element(el) {
        const key = el.getAttribute('data-cms');
        const v = s.get(key);
        if (v == null) return;
        const attr = el.getAttribute('data-cms-attr');
        if (attr) el.setAttribute(attr, v);
        else el.setInnerContent(el.getAttribute('data-cms-fmt') === 'rich' ? rich(v) : esc(v), { html: true });
      },
    });
    const phone = (s.get('site.phone') || '').replace(/\D/g, '');
    if (phone) rw.on('a[href^="tel:"]', { element(el) { el.setAttribute('href', 'tel:' + phone); } });
    const email = (s.get('site.email') || '').trim();
    if (email && /^[^\s@]+@[^\s@]+$/.test(email)) rw.on('a[href^="mailto:"]', { element(el) { el.setAttribute('href', 'mailto:' + email); } });
    const kakao = (s.get('site.kakao') || '').trim();
    if (/^https?:\/\/\S+$/.test(kakao)) rw.on('a[href*="pf.kakao.com"]', { element(el) { el.setAttribute('href', kakao); } });
    if (path === '/faq') {
      const groups = parseJson(s.get('faq'), null);
      if (Array.isArray(groups) && groups.length) {
        const html = faqGroupsHtml(groups), ld = faqLdJson(groups);
        rw.on('#faqs .group', { element(el) { el.remove(); } });
        rw.on('#faqs .cta', { element(el) { el.before(html, { html: true }); } });
        rw.on('script[type="application/ld+json"]', { element(el) { el.setInnerContent(ld, { html: true }); } });
      }
    }
  }
  if (track) rw.on('head', { element(el) { el.append('<script src="/t.js" defer></script>', { html: true }); } });
  const out = rw.transform(res);
  const h = new Headers(out.headers);
  h.delete('etag');
  h.delete('content-length');
  h.set('cache-control', 'no-cache');
  return new Response(out.body, { status: out.status, headers: h });
}

export function portfolioJs(list) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.url === 'string' && /^https?:\/\//.test(p.url) && p.name)
    .map((p) => ` [${JSON.stringify(p.url)},${JSON.stringify(String(p.name))},${JSON.stringify(String(p.cat || ''))}]`);
  return `/* 홍스랩 제작사례 목록 — 관리자 페이지에서 편집한 내용 */\nconst PORTFOLIO=[\n${rows.join(',\n')}\n];\nconst shot=(url,w)=>\`https://s.wordpress.com/mshots/v1/\${encodeURIComponent(url)}?w=\${w}\`;\n`;
}

// ---------- 방문 추적 ----------

const BOT_RE = /bot|crawl|spider|slurp|yeti|daumoa|kakaotalk-scrap|facebookexternalhit|headless|lighthouse|pagespeed|preview|monitor|python|curl\/|wget|httpclient|go-http|java\/|okhttp|scrapy|phantom|puppeteer|playwright|gptbot|claudebot|perplexitybot|bytespider|petalbot|semrush|ahrefs|mj12|dataforseo|screaming/i;

function parseUA(ua) {
  const device = /iPad|Tablet|SM-T\d/i.test(ua) ? '태블릿' : /Mobi|Android|iPhone/i.test(ua) ? '모바일' : 'PC';
  const os = /Windows/i.test(ua) ? 'Windows' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Mac OS/i.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : '기타';
  const browser = /KAKAOTALK/i.test(ua) ? '카카오톡 인앱' : /Instagram/i.test(ua) ? '인스타그램 인앱' : /NAVER\(inapp/i.test(ua) ? '네이버 앱' : /FBAN|FBAV/.test(ua) ? '페이스북 인앱' : /Whale\//.test(ua) ? '웨일' : /SamsungBrowser/.test(ua) ? '삼성 인터넷' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '기타';
  return { device, os, browser };
}

const SOURCE_RULES = [
  [/(^|\.)search\.naver\.com$/, '네이버 검색'],
  [/(^|\.)blog\.naver\.com$/, '네이버 블로그'],
  [/(^|\.)cafe\.naver\.com$/, '네이버 카페'],
  [/(^|\.)(naver\.com|naver\.me)$/, '네이버'],
  [/gemini\.google\.com$/, 'Gemini'],
  [/(^|\.)google\./, '구글'],
  [/(^|\.)daum\.net$/, '다음'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)kakao\.com$/, '카카오톡'],
  [/instagram\.com$/, '인스타그램'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, '페이스북'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, '유튜브'],
  [/(chatgpt\.com|openai\.com)$/, 'ChatGPT'],
  [/perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'X(트위터)'],
  [/threads\.(net|com)$/, 'Threads'],
  [/kmong\.com$/, '크몽'],
  [/(^|\.)(zum\.com|nate\.com|yahoo\.|duckduckgo\.com)/, '기타 검색'],
];
const UTM_NAMES = { naver: '네이버', google: '구글', kakao: '카카오톡', kakaotalk: '카카오톡', instagram: '인스타그램', facebook: '페이스북', youtube: '유튜브', kmong: '크몽', blog: '블로그', sms: '문자', email: '이메일', mail: '이메일', qr: 'QR코드', namecard: '명함', card: '명함' };

function classifySource(refHost, utmSource, ua) {
  if (utmSource) return UTM_NAMES[utmSource.toLowerCase()] || utmSource.slice(0, 40);
  const h = (refHost || '').toLowerCase();
  if (!h) {
    if (/KAKAOTALK/i.test(ua)) return '카카오톡';
    if (/Instagram/i.test(ua)) return '인스타그램';
    if (/NAVER\(inapp/i.test(ua)) return '네이버 앱';
    return '직접 유입';
  }
  for (const [re, name] of SOURCE_RULES) if (re.test(h)) return name;
  return '기타 사이트';
}

async function handleTrack(request, env, ctx, url) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!env.DB) return new Response(null, { status: 204 });
  if (!sameOrigin(request, url)) return new Response(null, { status: 403 });
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BOT_RE.test(ua)) return new Response(null, { status: 204 });
  const ip = request.headers.get('cf-connecting-ip') || '0';
  if (env.TRACK_LIMIT) {
    const { success } = await env.TRACK_LIMIT.limit({ key: ip });
    if (!success) return new Response(null, { status: 204 });
  }
  let b;
  try {
    const text = await request.text();
    if (text.length > 4096) return new Response(null, { status: 204 });
    b = JSON.parse(text);
  } catch { return new Response(null, { status: 204 }); }
  if (!b || typeof b !== 'object') return new Response(null, { status: 204 });

  let path = typeof b.p === 'string' ? b.p.split('?')[0].split('#')[0] : '';
  if (!path.startsWith('/') || path.length > 200) return new Response(null, { status: 204 });
  if (path.startsWith('/admin')) return new Response(null, { status: 204 });
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const type = b.e ? 'event' : 'view';
  const name = b.e ? String(b.e).slice(0, 40) : null;

  let refHost = null, refUrl = null;
  if (typeof b.r === 'string' && b.r) {
    try {
      const r = new URL(b.r);
      if (!SELF_HOSTS.has(r.hostname.toLowerCase())) {
        refHost = r.hostname.toLowerCase().replace(/^www\./, '');
        refUrl = (r.origin + r.pathname + r.search).slice(0, 500);
      }
    } catch {}
  }
  let utmSource = null, medium = null, campaign = null;
  if (typeof b.q === 'string' && b.q) {
    const q = new URLSearchParams(b.q);
    utmSource = (q.get('utm_source') || '').slice(0, 60) || null;
    medium = (q.get('utm_medium') || '').slice(0, 60) || null;
    campaign = (q.get('utm_campaign') || '').slice(0, 80) || null;
  }
  const source = classifySource(refHost, utmSource, ua);
  const { device, os, browser } = parseUA(ua);
  const cf = request.cf || {};
  const country = cf.country || null;
  const city = cf.city ? String(cf.city).slice(0, 60) : null;
  const ts = Math.floor(Date.now() / 1000);
  const { day, hour } = kst(ts);
  const vid = (await sha256hex(day + '|' + ip + '|' + ua)).slice(0, 16);
  const screen = typeof b.s === 'string' ? b.s.slice(0, 20) : null;
  const lang = typeof b.l === 'string' ? b.l.slice(0, 10) : null;

  const stmt = env.DB.prepare(
    'INSERT INTO hits (ts, day, hour, type, name, path, ref_host, ref_url, source, medium, campaign, device, browser, os, country, city, vid, screen, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(ts, day, hour, type, name, path, refHost, refUrl, source, medium, campaign, device, browser, os, country, city, vid, screen, lang);
  ctx.waitUntil(stmt.run().catch(() => {}));
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

// ---------- 관리자 API ----------

function dayStr(d) { return d.toISOString().slice(0, 10); }
function validDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function shiftDay(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return dayStr(d); }

async function handleStats(env, url) {
  const todayKst = kst(Math.floor(Date.now() / 1000)).day;
  let from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!validDay(to)) to = todayKst;
  if (!validDay(from)) from = shiftDay(to, -6);
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 400) from = shiftDay(to, -399);
  const pFrom = shiftDay(from, -days), pTo = shiftDay(from, -1);
  const now = Math.floor(Date.now() / 1000);

  const D = env.DB;
  const q = (sql, ...args) => D.prepare(sql).bind(...args);
  const rows = await D.batch([
    q(`SELECT COUNT(*) pv, COUNT(DISTINCT vid) uv, COUNT(DISTINCT day || vid) visits FROM hits WHERE type='view' AND day BETWEEN ? AND ?`, from, to),
    q(`SELECT COUNT(*) pv, COUNT(DISTINCT vid) uv, COUNT(DISTINCT day || vid) visits FROM hits WHERE type='view' AND day BETWEEN ? AND ?`, pFrom, pTo),
    q(`SELECT COUNT(*) c, COUNT(DISTINCT vid) u FROM hits WHERE type='event' AND day BETWEEN ? AND ?`, from, to),
    q(`SELECT COUNT(*) c, COUNT(DISTINCT vid) u FROM hits WHERE type='event' AND day BETWEEN ? AND ?`, pFrom, pTo),
    q(`SELECT day, SUM(type='view') pv, COUNT(DISTINCT CASE WHEN type='view' THEN vid END) uv, SUM(type='event') ev FROM hits WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`, from, to),
    q(`SELECT hour, SUM(type='view') pv, COUNT(DISTINCT CASE WHEN type='view' THEN vid END) uv FROM hits WHERE day BETWEEN ? AND ? GROUP BY hour ORDER BY hour`, from, to),
    q(`SELECT source, COUNT(*) pv, COUNT(DISTINCT vid) uv FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY source ORDER BY uv DESC, pv DESC`, from, to),
    q(`SELECT ref_host, ref_url, COUNT(*) pv, COUNT(DISTINCT vid) uv FROM hits WHERE type='view' AND ref_host IS NOT NULL AND day BETWEEN ? AND ? GROUP BY ref_url ORDER BY uv DESC, pv DESC LIMIT 30`, from, to),
    q(`SELECT source, medium, campaign, COUNT(*) pv, COUNT(DISTINCT vid) uv FROM hits WHERE type='view' AND (medium IS NOT NULL OR campaign IS NOT NULL) AND day BETWEEN ? AND ? GROUP BY source, medium, campaign ORDER BY uv DESC LIMIT 30`, from, to),
    q(`SELECT path, COUNT(*) pv, COUNT(DISTINCT vid) uv FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY path ORDER BY pv DESC LIMIT 30`, from, to),
    q(`SELECT path, COUNT(*) c FROM (SELECT path, MIN(ts) m FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY day, vid) GROUP BY path ORDER BY c DESC LIMIT 20`, from, to),
    q(`SELECT 'device' dim, device k, COUNT(DISTINCT vid) uv, COUNT(*) pv FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY device
       UNION ALL SELECT 'browser', browser, COUNT(DISTINCT vid), COUNT(*) FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY browser
       UNION ALL SELECT 'os', os, COUNT(DISTINCT vid), COUNT(*) FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY os
       UNION ALL SELECT 'country', country, COUNT(DISTINCT vid), COUNT(*) FROM hits WHERE type='view' AND day BETWEEN ? AND ? GROUP BY country
       UNION ALL SELECT 'city', city, COUNT(DISTINCT vid), COUNT(*) FROM hits WHERE type='view' AND city IS NOT NULL AND day BETWEEN ? AND ? GROUP BY city
       ORDER BY dim, uv DESC`, from, to, from, to, from, to, from, to, from, to),
    q(`SELECT name, COUNT(*) c, COUNT(DISTINCT vid) u FROM hits WHERE type='event' AND day BETWEEN ? AND ? GROUP BY name ORDER BY c DESC`, from, to),
    q(`SELECT COUNT(DISTINCT vid) n FROM hits WHERE ts > ?`, now - 1800),
    q(`SELECT ts, type, name, path, source, ref_host, device, browser, country, city FROM hits ORDER BY ts DESC LIMIT 40`),
  ]);
  const r = rows.map((x) => x.results || []);
  const dims = {};
  for (const row of r[11]) (dims[row.dim] = dims[row.dim] || []).push({ k: row.k || '알 수 없음', uv: row.uv, pv: row.pv });
  return json({
    range: { from, to, days, prevFrom: pFrom, prevTo: pTo, today: todayKst },
    totals: { ...r[0][0], events: r[2][0].c, eventUsers: r[2][0].u },
    prev: { ...r[1][0], events: r[3][0].c, eventUsers: r[3][0].u },
    daily: r[4], hourly: r[5], sources: r[6], referrers: r[7], campaigns: r[8], pages: r[9], landing: r[10],
    dims, events: r[12], live: r[13][0].n, recent: r[14],
  });
}

async function handleExport(env, url) {
  let from = url.searchParams.get('from'), to = url.searchParams.get('to');
  const today = kst(Math.floor(Date.now() / 1000)).day;
  if (!validDay(to)) to = today;
  if (!validDay(from)) from = shiftDay(to, -29);
  const { results } = await env.DB.prepare(
    'SELECT ts, day, hour, type, name, path, ref_host, ref_url, source, medium, campaign, device, browser, os, country, city, vid, screen, lang FROM hits WHERE day BETWEEN ? AND ? ORDER BY ts LIMIT 50000'
  ).bind(from, to).all();
  const cols = ['ts', 'day', 'hour', 'type', 'name', 'path', 'ref_host', 'ref_url', 'source', 'medium', 'campaign', 'device', 'browser', 'os', 'country', 'city', 'vid', 'screen', 'lang'];
  const cell = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(',')];
  for (const row of results) lines.push(cols.map((c) => cell(row[c])).join(','));
  return new Response('﻿' + lines.join('\r\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="hongslab-visits-${from}_${to}.csv"`, 'cache-control': 'no-store' },
  });
}

const KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;
const MAX_VALUE = 60000;

async function handleAdminApi(request, env, ctx, url) {
  const p = url.pathname.slice('/api/admin/'.length);
  const method = request.method;
  if (p === 'login' && method === 'POST') {
    if (!sameOrigin(request, url)) return json({ error: '잘못된 요청입니다.' }, 403);
    if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD 시크릿이 아직 설정되지 않았습니다. Cloudflare 대시보드에서 등록해 주세요.' }, 503);
    if (env.LOGIN_LIMIT) {
      const { success } = await env.LOGIN_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || 'x' });
      if (!success) return json({ error: '시도 횟수가 많습니다. 1분 뒤 다시 시도해 주세요.' }, 429);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
    const pw = typeof body.password === 'string' ? body.password : '';
    const ok = pw && (await sha256hex('pw|' + pw)) === (await sha256hex('pw|' + env.ADMIN_PASSWORD));
    if (!ok) return json({ error: '비밀번호가 맞지 않습니다.' }, 401);
    const token = await makeToken(env.ADMIN_PASSWORD);
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(token, url, SESSION_DAYS * 86400) });
  }
  if (p === 'logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', url, 0) });
  }
  if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401);
  if (method !== 'GET' && !sameOrigin(request, url)) return json({ error: 'forbidden' }, 403);

  if (p === 'me') return json({ ok: true, db: !!env.DB, host: url.host });
  if (!env.DB) return json({ error: 'D1 데이터베이스(DB)가 연결되지 않았습니다.' }, 503);

  if (p === 'content' && method === 'GET') {
    const s = await loadSettings(env, true);
    const out = {};
    for (const [k, v] of s) out[k] = v;
    return json({ settings: out });
  }
  if (p === 'content' && (method === 'PUT' || method === 'POST')) {
    let body;
    try { body = await request.json(); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
    const set = body && body.set && typeof body.set === 'object' ? body.set : {};
    const del = Array.isArray(body && body.del) ? body.del : [];
    const now = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (const [k, v] of Object.entries(set)) {
      if (!KEY_RE.test(k)) return json({ error: '잘못된 항목 이름: ' + k }, 400);
      if (typeof v !== 'string') return json({ error: '값은 문자열이어야 합니다: ' + k }, 400);
      if (v.length > MAX_VALUE) return json({ error: '값이 너무 깁니다: ' + k }, 400);
      if (k === 'portfolio' || k === 'faq') {
        const parsed = parseJson(v, null);
        if (!Array.isArray(parsed)) return json({ error: k + ' 형식이 올바르지 않습니다.' }, 400);
      }
      stmts.push(env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').bind(k, v, now));
    }
    for (const k of del) {
      if (!KEY_RE.test(k)) return json({ error: '잘못된 항목 이름: ' + k }, 400);
      stmts.push(env.DB.prepare('DELETE FROM settings WHERE key=?').bind(k));
    }
    if (stmts.length) await env.DB.batch(stmts);
    settingsCache = { at: 0, map: null };
    return json({ ok: true, set: Object.keys(set).length, del: del.length });
  }
  if (p === 'stats' && method === 'GET') return handleStats(env, url);
  if (p === 'export' && method === 'GET') return handleExport(env, url);
  return json({ error: 'not found' }, 404);
}

// ---------- 진입점 ----------

export async function handleCms(request, env, ctx, url) {
  const p = url.pathname;
  if (p === '/api/t') return handleTrack(request, env, ctx, url);
  if (p.startsWith('/api/admin/')) {
    try { return await handleAdminApi(request, env, ctx, url); }
    catch (e) { return json({ error: '서버 오류: ' + String(e && e.message || e) }, 500); }
  }
  if (p === '/admin.html') return Response.redirect(url.origin + '/admin', 301);
  if (p === '/admin' || p === '/admin/') {
    const res = await env.ASSETS.fetch(new Request(url.origin + '/admin', request));
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-store');
    h.set('x-robots-tag', 'noindex, nofollow');
    return new Response(res.body, { status: res.status, headers: h });
  }

  const admin = request.headers.get('cookie') ? await isAdmin(request, env) : false;
  const raw = admin && request.headers.get('x-cms-raw') === '1';

  if (p === '/portfolio.js' && !raw) {
    const s = await loadSettings(env);
    const list = parseJson(s.get('portfolio'), null);
    if (Array.isArray(list) && list.length) {
      return new Response(portfolioJs(list), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
    }
  }
  if (p === '/llms.txt' && !raw) {
    const s = await loadSettings(env);
    const v = s.get('llms');
    if (v) return new Response(v, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  let req = request;
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html') || raw) {
    const h = new Headers(request.headers);
    h.delete('if-none-match');
    h.delete('if-modified-since');
    req = new Request(request, { headers: h });
  }
  const res = await env.ASSETS.fetch(req);
  const ct = res.headers.get('content-type') || '';
  if (res.status === 200 && ct.includes('text/html')) {
    const s = raw ? new Map() : await loadSettings(env);
    return transformHtml(res, s, { path: p === '/' ? '/' : p.replace(/\/$/, ''), track: !admin });
  }
  return res;
}
