// 홍스랩 Worker: /api/seo-check 는 여기서, 나머지(관리자·방문 통계·콘텐츠 덮어쓰기·정적 자산)는 cms.js 가 처리한다.
import { handleCms } from './cms.js';

const UA = 'Mozilla/5.0 (compatible; HongslabSEOChecker/1.0; +https://hongslab.kr/seo-checker)';
const MAX_HTML = 3 * 1024 * 1024;
const CACHE_TTL = 600;
// 자기 자신(hongslab.kr)을 외부 fetch 로 부르면 522 가 나므로 정적 자산 바인딩으로 직접 읽는다
const SELF_HOSTS = new Set(['hongslab.kr', 'www.hongslab.kr', 'hongslab.hsk9867.workers.dev']);
let assets = null;
function doFetch(url, init) {
  const host = new URL(url).hostname.toLowerCase();
  if (assets && SELF_HOSTS.has(host)) return assets.fetch(new Request(url, init));
  return fetch(url, init);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/seo-check') return handleCheck(request, env, ctx);
    // 관리자·방문 통계·콘텐츠 덮어쓰기·정적 자산 전달 — cms.js
    return handleCms(request, env, ctx, url);
  },
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

async function handleCheck(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET만 지원합니다.' }, 405);
  assets = env.ASSETS;
  const input = (new URL(request.url).searchParams.get('url') || '').trim();
  const target = normalizeTarget(input);
  if (!target) return json({ error: '올바른 사이트 주소를 입력해 주세요. 예: hongslab.kr' }, 400);

  // 같은 주소는 10분간 캐시된 결과를 돌려준다 (요청 제한에도 걸리지 않음)
  const cache = caches.default;
  const cacheKey = new Request('https://hongslab.kr/api/seo-check?u=' + encodeURIComponent(target.href));
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (env.SEO_LIMIT) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.SEO_LIMIT.limit({ key: ip });
    if (!success) return json({ error: '잠시 후 다시 시도해 주세요. (1분에 5회까지 점검할 수 있습니다)' }, 429);
  }

  let result;
  try {
    result = await analyze(target);
  } catch (e) {
    return json({ error: '사이트에 접속하지 못했습니다. 주소를 확인하거나 잠시 후 다시 시도해 주세요.', detail: String(e && e.message || e) }, 502);
  }
  const res = json(result, 200, { 'cache-control': `public, max-age=${CACHE_TTL}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function normalizeTarget(input) {
  if (!input || input.length > 2000) return null;
  let s = input;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (u.port && !['80', '443'].includes(u.port)) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost') return null;
  // IP 주소 직접 입력은 막는다 (내부망 접근 방지)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return null;
  u.hash = '';
  return u;
}

async function get(url, { method = 'GET', timeout = 10000 } = {}) {
  const started = Date.now();
  const res = await doFetch(url, {
    method,
    redirect: 'follow',
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8', 'accept-language': 'ko-KR,ko;q=0.9' },
    signal: AbortSignal.timeout(timeout),
  });
  return { res, ms: Date.now() - started };
}

async function readText(res, limit = MAX_HTML) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= limit) { reader.cancel(); break; }
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.byteLength, size - off)), off); off += c.byteLength; if (off >= size) break; }
  return new TextDecoder('utf-8').decode(buf);
}

async function fetchSide(url) {
  try {
    const { res } = await get(url, { timeout: 6000 });
    const type = res.headers.get('content-type') || '';
    const text = res.ok ? await readText(res, 512 * 1024) : '';
    return { ok: res.ok, status: res.status, type, text, url: res.url };
  } catch {
    return { ok: false, status: 0, type: '', text: '', url };
  }
}

// ---------- HTML 파싱 도우미 ----------

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<\s*[a-zA-Z0-9-]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(body))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function tags(html, name) {
  const re = new RegExp('<' + name + '\\b[^>]*>', 'gi');
  return (html.match(re) || []).map(attrs);
}

function inner(html, name) {
  const re = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(cleanText(m[1]));
  return out;
}

function cleanText(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function meta(metas, key) {
  key = key.toLowerCase();
  const m = metas.find(t => (t.name || t.property || '').toLowerCase() === key);
  return m ? (m.content || '').trim() : '';
}

function len(s) { return [...(s || '')].length; }

function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === 'disallow' || k === 'allow')) cur.rules.push({ k, v });
    }
  }
  const sitemaps = [...txt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(m => m[1]);
  return { groups, sitemaps };
}

// 해당 봇이 사이트 루트(/) 접근을 막혔는지
function robotsBlocksRoot(robots, agent) {
  if (!robots) return false;
  const a = agent.toLowerCase();
  let g = robots.groups.filter(g => g.agents.some(x => x !== '*' && a.includes(x)));
  if (!g.length) g = robots.groups.filter(g => g.agents.includes('*'));
  const rules = g.flatMap(x => x.rules);
  const blocked = rules.some(r => r.k === 'disallow' && (r.v === '/' || r.v === '/*'));
  const allowedRoot = rules.some(r => r.k === 'allow' && (r.v === '/' || r.v === '/*' || r.v === '/$' || r.v === ''));
  return blocked && !allowedRoot;
}

function collectSchema(html) {
  const blocks = [];
  let invalid = 0;
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { invalid++; }
  }
  const nodes = [];
  const walk = n => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n['@type']) nodes.push(n);
      if (n['@graph']) walk(n['@graph']);
      for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
    }
  };
  walk(blocks);
  const types = new Set();
  for (const n of nodes) [].concat(n['@type']).forEach(t => types.add(String(t)));
  const hasMicrodata = /\bitemtype\s*=\s*["']https?:\/\/schema\.org\//i.test(html);
  return { count: blocks.length, invalid, nodes, types, hasMicrodata };
}

const BUSINESS_TYPES = /^(Organization|Corporation|LocalBusiness|ProfessionalService|Store|Restaurant|FoodEstablishment|MedicalBusiness|MedicalClinic|Dentist|Physician|HealthAndBeautyBusiness|SportsActivityLocation|ExerciseGym|HomeAndConstructionBusiness|LegalService|FinancialService|InsuranceAgency|RealEstateAgent|AutomotiveBusiness|EducationalOrganization|LodgingBusiness|EntertainmentBusiness|Person|NGO|GovernmentOrganization|.*Business|.*Store|.*Service)$/;

// ---------- 분석 ----------

async function analyze(target) {
  const { res, ms } = await get(target.href);
  // 530/52x 는 Cloudflare 가 대상 사이트에 연결하지 못했을 때 돌려주는 상태 — 분석할 HTML 이 아님
  if (res.status >= 500) throw new Error(`대상 사이트 응답 HTTP ${res.status}`);
  const finalUrl = new URL(res.url || target.href);
  const ctype = res.headers.get('content-type') || '';
  const html = await readText(res);
  const bytes = new TextEncoder().encode(html).byteLength;
  const origin = finalUrl.origin;

  const [robotsRes, llmsRes] = await Promise.all([fetchSide(origin + '/robots.txt'), fetchSide(origin + '/llms.txt')]);
  const robotsOk = robotsRes.ok && !/<html/i.test(robotsRes.text.slice(0, 500));
  const robots = robotsOk ? parseRobots(robotsRes.text) : null;
  const sitemapUrl = (robots && robots.sitemaps[0]) || origin + '/sitemap.xml';
  const sitemapRes = await fetchSide(sitemapUrl);
  const sitemapOk = sitemapRes.ok && /<(urlset|sitemapindex)\b/i.test(sitemapRes.text);
  const llmsOk = llmsRes.ok && !/<html/i.test(llmsRes.text.slice(0, 500)) && llmsRes.text.trim().length > 20;

  const head = (html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i) || [, html])[1];
  const metas = tags(head, 'meta');
  const links = tags(head, 'link');
  const htmlTag = tags(html, 'html')[0] || {};
  const title = (inner(head, 'title')[0] || '').trim();
  const desc = meta(metas, 'description');
  const robotsMeta = (meta(metas, 'robots') + ',' + meta(metas, 'googlebot')).toLowerCase();
  const xRobots = (res.headers.get('x-robots-tag') || '').toLowerCase();
  const viewport = meta(metas, 'viewport');
  const canonical = (links.find(l => (l.rel || '').toLowerCase().split(/\s+/).includes('canonical')) || {}).href || '';
  const icon = links.find(l => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.rel || ''));
  const og = k => meta(metas, 'og:' + k);
  const tw = k => meta(metas, 'twitter:' + k);
  const charset = metas.some(m => m.charset) || /charset=/i.test(ctype) || metas.some(m => /charset=/i.test(m.content || ''));

  const body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
  const bodyNoScript = body.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const text = cleanText(bodyNoScript);
  const textLen = len(text);
  const koLen = (text.match(/[가-힣]/g) || []).length;
  const h1 = inner(bodyNoScript, 'h1');
  const h2 = inner(bodyNoScript, 'h2');
  const h3 = inner(bodyNoScript, 'h3');
  const imgs = tags(bodyNoScript, 'img');
  const imgNoAlt = imgs.filter(i => !('alt' in i));
  const anchors = tags(bodyNoScript, 'a');
  const hashLinks = anchors.filter(a => /^#./.test(a.href || '')).length;
  const internal = anchors.filter(a => {
    const h = a.href || '';
    if (!h || h.startsWith('#') || /^(mailto|tel|javascript):/i.test(h)) return false;
    try { return new URL(h, finalUrl).host === finalUrl.host; } catch { return false; }
  });
  const hasTel = /href\s*=\s*["']tel:/i.test(body) || /0\d{1,2}[-.\s)]\d{3,4}[-.\s]\d{4}/.test(text);
  const hasAddress = /<address\b/i.test(body) || /(특별시|광역시|자치시|[가-힣]+(도|시|군|구)\s+[가-힣0-9]+(로|길|동|읍|면))/.test(text);
  const schema = collectSchema(html);
  const bizNode = schema.nodes.find(n => [].concat(n['@type']).some(t => BUSINESS_TYPES.test(String(t))));
  const questionHeads = [...h2, ...h3, ...inner(bodyNoScript, 'summary'), ...inner(bodyNoScript, 'dt')]
    .filter(t => /\?|？|(나요|까요|인가요|있나요|되나요|무엇|어떻게|왜|얼마)\s*$/.test(t));
  const hasList = /<(ul|ol)\b/i.test(bodyNoScript) && /<li\b/i.test(bodyNoScript);
  const hasTable = /<table\b/i.test(bodyNoScript) || /<dl\b/i.test(bodyNoScript);
  const semantic = ['main', 'header', 'nav', 'section', 'article', 'footer'].filter(t => new RegExp('<' + t + '\\b', 'i').test(html));
  const hasDate = schema.nodes.some(n => n.datePublished || n.dateModified) || meta(metas, 'article:modified_time') || /<time\b/i.test(body) || (sitemapOk && /<lastmod>/i.test(sitemapRes.text));
  const sameAs = schema.nodes.flatMap(n => [].concat(n.sameAs || [])).filter(Boolean);
  const hasAuthor = schema.nodes.some(n => n.author || n.founder || n.publisher) || meta(metas, 'author');
  const numbers = (text.match(/\d[\d,.]*\s*(원|%|년|개|명|건|곳|시간|분|일|만|억|평|㎡|km|kg)/g) || []).length;
  const iframes = tags(bodyNoScript, 'iframe').length;
  const frameset = /<frameset\b/i.test(html);
  const jsShell = textLen < 150 && /<script\b/i.test(html) && /id\s*=\s*["'](root|app|__next|__nuxt)["']/i.test(html);
  const metaRefresh = metas.some(m => (m['http-equiv'] || '').toLowerCase() === 'refresh');
  const https = finalUrl.protocol === 'https:';
  const noindex = /noindex/.test(robotsMeta) || /noindex/.test(xRobots);
  const noai = /noai|noimageai/.test(robotsMeta);

  const checks = [];
  const add = (axis, label, status, detail, weight = 1) => checks.push({ axis, label, status, detail, weight });
  const range = (n, lo, hi) => (n >= lo && n <= hi ? 'pass' : n > 0 ? 'warn' : 'fail');

  // 공통 기반은 축마다 가중치가 다르게 반영된다
  const robotsLine = robots ? 'robots.txt 확인됨' : 'robots.txt 없음';

  // ===== 네이버 SEO =====
  add('naver', '페이지 정상 응답', res.ok ? 'pass' : 'fail', `HTTP ${res.status}`, 3);
  add('naver', '제목(title) 길이', range(len(title), 10, 40) === 'pass' ? 'pass' : title ? 'warn' : 'fail',
    title ? `${len(title)}자 · "${title.slice(0, 60)}" (네이버 권장 10~40자)` : 'title 태그가 없습니다', 2);
  add('naver', '설명(description) 길이', range(len(desc), 40, 100) === 'pass' ? 'pass' : desc ? 'warn' : 'fail',
    desc ? `${len(desc)}자 (권장 40~100자)` : 'meta description이 없습니다', 2);
  add('naver', '네이버 서치어드바이저 등록', meta(metas, 'naver-site-verification') ? 'pass' : 'warn',
    meta(metas, 'naver-site-verification') ? '소유확인 메타태그 확인됨' : '메타태그가 보이지 않습니다 (HTML 파일 방식이면 무시해도 됩니다)', 2);
  add('naver', 'og:title', og('title') ? 'pass' : 'fail', og('title') || '없음 — 네이버 검색 결과·블로그 공유 제목에 쓰입니다');
  add('naver', 'og:description', og('description') ? 'pass' : 'fail', og('description') ? `${len(og('description'))}자` : '없음');
  add('naver', 'og:image (대표 이미지)', og('image') ? 'pass' : 'fail', og('image') || '없음 — 검색·카카오톡 미리보기 이미지가 비어 보입니다', 2);
  add('naver', 'og:url', og('url') ? 'pass' : 'warn', og('url') || '없음');
  add('naver', '네이버 검색로봇(Yeti) 허용', robotsBlocksRoot(robots, 'Yeti') ? 'fail' : 'pass', robotsBlocksRoot(robots, 'Yeti') ? 'robots.txt가 Yeti를 막고 있습니다' : robotsLine, 3);
  add('naver', 'robots.txt', robots ? 'pass' : 'warn', robots ? `${origin}/robots.txt` : '없음 — 서치어드바이저에서 수집 요청 시 권장', 1);
  add('naver', '사이트맵(sitemap.xml)', sitemapOk ? 'pass' : 'fail', sitemapOk ? sitemapRes.url : '찾지 못했습니다 — 서치어드바이저에 제출할 사이트맵이 필요합니다', 2);
  add('naver', '한국어 언어 설정', /^ko/i.test(htmlTag.lang || '') ? 'pass' : htmlTag.lang ? 'warn' : 'fail', htmlTag.lang ? `lang="${htmlTag.lang}"` : '<html lang="ko"> 가 없습니다');
  add('naver', '모바일 화면 설정', /width\s*=\s*device-width/i.test(viewport) ? 'pass' : 'fail', viewport || 'viewport 메타태그가 없습니다', 2);
  add('naver', 'HTML 안의 한글 본문 양', koLen >= 300 ? 'pass' : koLen >= 80 ? 'warn' : 'fail', `한글 ${koLen.toLocaleString()}자 (300자 이상 권장, 이미지 속 글자는 읽지 못합니다)`, 2);
  add('naver', '프레임·iframe 의존 없음', frameset ? 'fail' : iframes > 3 ? 'warn' : 'pass', frameset ? 'frameset 구조는 수집이 어렵습니다' : `iframe ${iframes}개`);
  add('naver', '이미지 대체텍스트(alt)', !imgs.length ? 'pass' : imgNoAlt.length === 0 ? 'pass' : imgNoAlt.length / imgs.length <= 0.2 ? 'warn' : 'fail',
    imgs.length ? `이미지 ${imgs.length}개 중 alt 없음 ${imgNoAlt.length}개` : '본문 이미지 없음');
  add('naver', '대표 주소(canonical)', canonical ? 'pass' : 'warn', canonical || '없음 — 같은 페이지가 여러 주소로 수집될 수 있습니다');

  // ===== 구글 SEO =====
  add('google', 'HTTPS 보안 접속', https ? 'pass' : 'fail', https ? finalUrl.href : 'http 주소입니다 — 구글은 HTTPS를 순위 신호로 씁니다', 3);
  add('google', '색인 허용 (noindex 없음)', noindex ? 'fail' : 'pass', noindex ? `noindex 지정됨 (${robotsMeta.includes('noindex') ? 'meta robots' : 'X-Robots-Tag'})` : '색인 차단 신호 없음', 3);
  add('google', 'Googlebot 허용', robotsBlocksRoot(robots, 'Googlebot') ? 'fail' : 'pass', robotsBlocksRoot(robots, 'Googlebot') ? 'robots.txt가 Googlebot을 막고 있습니다' : robotsLine, 3);
  add('google', '제목(title) 길이', len(title) >= 10 && len(title) <= 60 ? 'pass' : title ? 'warn' : 'fail', title ? `${len(title)}자 (권장 10~60자)` : 'title 없음', 2);
  add('google', '설명(description) 길이', len(desc) >= 50 && len(desc) <= 160 ? 'pass' : desc ? 'warn' : 'fail', desc ? `${len(desc)}자 (권장 50~160자)` : '없음', 2);
  add('google', 'H1 제목 1개', h1.length === 1 ? 'pass' : h1.length > 1 ? 'warn' : 'fail', h1.length ? `${h1.length}개 · "${h1[0].slice(0, 50)}"` : 'H1이 없습니다', 2);
  add('google', '소제목(H2) 구조', h2.length >= 2 ? 'pass' : h2.length ? 'warn' : 'fail', `H2 ${h2.length}개 · H3 ${h3.length}개`);
  add('google', 'canonical 절대주소', /^https?:\/\//i.test(canonical) ? 'pass' : canonical ? 'warn' : 'fail', canonical || '없음');
  add('google', '사이트맵', sitemapOk ? 'pass' : 'fail', sitemapOk ? sitemapRes.url : '없음', 2);
  add('google', 'robots.txt에 사이트맵 명시', robots && robots.sitemaps.length ? 'pass' : 'warn', robots && robots.sitemaps.length ? robots.sitemaps[0] : 'Sitemap: 줄이 없습니다');
  add('google', '구글 서치콘솔 소유확인', meta(metas, 'google-site-verification') ? 'pass' : 'warn', meta(metas, 'google-site-verification') ? '메타태그 확인됨' : '메타태그 없음 (DNS·파일 방식이면 무시)');
  add('google', '모바일 화면 설정', /width\s*=\s*device-width/i.test(viewport) ? 'pass' : 'fail', viewport || '없음', 3);
  add('google', '문자 인코딩 지정', charset ? 'pass' : 'warn', charset ? '지정됨' : 'meta charset 없음');
  add('google', '파비콘', icon ? 'pass' : 'warn', icon ? icon.href : '없음 — 모바일 검색 결과에 사이트 아이콘이 표시됩니다');
  add('google', '서버 응답 속도', ms <= 800 ? 'pass' : ms <= 2000 ? 'warn' : 'fail', `${ms.toLocaleString()}ms (HTML 수신까지)`, 2);
  add('google', 'HTML 용량', bytes <= 500 * 1024 ? 'pass' : bytes <= 2 * 1024 * 1024 ? 'warn' : 'fail', `${(bytes / 1024).toFixed(0)}KB`);
  add('google', '내부 링크', internal.length >= 3 ? 'pass' : internal.length || hashLinks >= 3 ? 'warn' : 'fail',
    internal.length ? `같은 사이트 링크 ${internal.length}개` : hashLinks ? `페이지 내 이동(#) 링크만 ${hashLinks}개 — 한 페이지 사이트는 괜찮지만 하위 페이지가 있다면 연결하세요` : '같은 사이트 링크 0개');
  add('google', '이미지 alt', !imgs.length || imgNoAlt.length === 0 ? 'pass' : imgNoAlt.length / imgs.length <= 0.2 ? 'warn' : 'fail', imgs.length ? `${imgs.length}개 중 ${imgNoAlt.length}개 누락` : '이미지 없음');
  add('google', '트위터(X) 카드', tw('card') ? 'pass' : 'warn', tw('card') || '없음');
  add('google', '자동 이동(meta refresh) 없음', metaRefresh ? 'warn' : 'pass', metaRefresh ? 'meta refresh는 301 리디렉트로 바꾸는 것이 좋습니다' : '없음');
  add('google', '자바스크립트 없이도 내용 보임', jsShell ? 'fail' : 'pass', jsShell ? '본문이 스크립트로만 그려집니다 — 서버 렌더링 권장' : `HTML 본문 ${textLen.toLocaleString()}자`, 2);

  // ===== AEO (답변 엔진) =====
  add('aeo', '구조화 데이터(JSON-LD)', schema.count ? 'pass' : schema.hasMicrodata ? 'warn' : 'fail',
    schema.count ? `${schema.count}개 블록 · ${[...schema.types].slice(0, 8).join(', ')}` : schema.hasMicrodata ? 'Microdata만 있습니다 — JSON-LD 권장' : '없음 — 검색엔진이 업체 정보를 정확히 읽기 어렵습니다', 3);
  add('aeo', 'JSON-LD 문법 오류 없음', schema.invalid ? 'fail' : 'pass', schema.invalid ? `${schema.invalid}개 블록 파싱 실패` : schema.count ? '정상' : '해당 없음');
  add('aeo', '업체·기관 정보 스키마', bizNode ? 'pass' : 'fail', bizNode ? `${[].concat(bizNode['@type']).join(', ')} · ${bizNode.name || ''}` : 'Organization / LocalBusiness 스키마가 없습니다', 3);
  add('aeo', '스키마에 연락처', bizNode && (bizNode.telephone || bizNode.email || bizNode.contactPoint) ? 'pass' : 'warn', bizNode && bizNode.telephone ? bizNode.telephone : '전화·이메일 정보 없음');
  add('aeo', '스키마에 주소·지역', bizNode && (bizNode.address || bizNode.areaServed) ? 'pass' : 'warn', bizNode && bizNode.address ? '주소 있음' : bizNode && bizNode.areaServed ? '서비스 지역 있음' : '없음');
  add('aeo', '자주 묻는 질문(FAQPage) 스키마', schema.types.has('FAQPage') ? 'pass' : 'fail', schema.types.has('FAQPage') ? 'FAQPage 확인됨' : '없음 — AI·음성 검색이 바로 인용하기 좋은 형식입니다', 3);
  add('aeo', '질문형 소제목', questionHeads.length >= 3 ? 'pass' : questionHeads.length ? 'warn' : 'fail', questionHeads.length ? `${questionHeads.length}개 · "${questionHeads[0].slice(0, 40)}"` : '"~인가요?" 같은 질문형 제목이 없습니다', 2);
  add('aeo', '목록 형식 콘텐츠', hasList ? 'pass' : 'warn', hasList ? 'ul/ol 목록 사용' : '목록 없음');
  add('aeo', '표·정의 목록', hasTable ? 'pass' : 'warn', hasTable ? 'table/dl 사용' : '요금·비교 정보를 표로 정리하면 답변에 인용되기 쉽습니다');
  add('aeo', '전화번호 노출', hasTel ? 'pass' : 'fail', hasTel ? '본문에 연락처 있음' : '본문에서 전화번호를 찾지 못했습니다', 2);
  add('aeo', '주소·위치 정보', hasAddress ? 'pass' : 'warn', hasAddress ? '주소 표기 확인' : '본문에 주소가 보이지 않습니다');
  add('aeo', '영업시간 정보', schema.nodes.some(n => n.openingHours || n.openingHoursSpecification) || /영업\s*시간|운영\s*시간|상담\s*시간|\d{1,2}:\d{2}\s*[~-]\s*\d{1,2}:\d{2}/.test(text) ? 'pass' : 'warn', '운영시간이 있으면 "지금 영업하나요?" 질문에 답할 수 있습니다');
  add('aeo', '빵부스러기(Breadcrumb)', schema.types.has('BreadcrumbList') ? 'pass' : finalUrl.pathname === '/' ? 'pass' : 'warn', schema.types.has('BreadcrumbList') ? '있음' : finalUrl.pathname === '/' ? '메인 페이지라 해당 없음' : '하위 페이지는 BreadcrumbList 권장');
  add('aeo', '시맨틱 HTML 구조', semantic.length >= 4 ? 'pass' : semantic.length >= 2 ? 'warn' : 'fail', semantic.length ? semantic.map(s => '<' + s + '>').join(' ') : 'div만으로 구성되어 있습니다');

  // ===== GEO (생성형 AI 엔진) =====
  const aiBots = [['GPTBot', 'ChatGPT'], ['OAI-SearchBot', 'ChatGPT 검색'], ['ClaudeBot', 'Claude'], ['PerplexityBot', 'Perplexity'], ['Google-Extended', 'Gemini']];
  const blockedBots = aiBots.filter(([b]) => robotsBlocksRoot(robots, b));
  add('geo', 'AI 크롤러 허용', blockedBots.length === 0 ? 'pass' : blockedBots.length < aiBots.length ? 'warn' : 'fail',
    blockedBots.length ? `차단됨: ${blockedBots.map(b => b[1]).join(', ')}` : 'GPTBot·ClaudeBot·PerplexityBot·Google-Extended 모두 허용', 3);
  add('geo', 'llms.txt', llmsOk ? 'pass' : 'fail', llmsOk ? `${origin}/llms.txt (${len(llmsRes.text).toLocaleString()}자)` : '없음 — AI에게 사이트를 요약해 알려주는 파일입니다', 3);
  add('geo', 'AI 학습·인용 거부 태그 없음', noai ? 'fail' : 'pass', noai ? 'noai 지정됨' : '없음');
  add('geo', '서버에서 그린 본문 (AI가 읽을 수 있음)', textLen >= 800 ? 'pass' : textLen >= 200 ? 'warn' : 'fail', `HTML 본문 ${textLen.toLocaleString()}자 — 대부분의 AI 크롤러는 자바스크립트를 실행하지 않습니다`, 3);
  add('geo', '브랜드명 일관성', og('site_name') || (bizNode && bizNode.name) ? 'pass' : 'warn', og('site_name') || (bizNode && bizNode.name) || 'og:site_name·스키마 name 없음', 2);
  add('geo', '외부 프로필 연결(sameAs)', sameAs.length >= 2 ? 'pass' : sameAs.length ? 'warn' : 'fail', sameAs.length ? `${sameAs.length}개 · ${sameAs.slice(0, 3).join(', ')}` : '네이버 플레이스·인스타그램 등 공식 채널을 스키마로 연결하세요', 2);
  add('geo', '운영 주체·작성자 정보', hasAuthor ? 'pass' : 'warn', hasAuthor ? '스키마/메타에 대표·작성자 있음' : '대표자·작성자 정보가 없습니다 (신뢰도 신호)');
  add('geo', '최신성(날짜 정보)', hasDate ? 'pass' : 'warn', hasDate ? '수정일·게시일 정보 있음' : 'dateModified·<time>·sitemap lastmod 없음');
  add('geo', '구체적인 수치 정보', numbers >= 5 ? 'pass' : numbers ? 'warn' : 'fail', `가격·기간·실적 같은 수치 ${numbers}개 — AI는 구체적인 숫자를 인용하기 좋아합니다`, 2);
  add('geo', '설명 문장 충실도', len(desc) >= 40 && len(og('description')) >= 20 ? 'pass' : desc ? 'warn' : 'fail', '검색·AI 요약의 첫 문장으로 쓰입니다');
  add('geo', '질문-답변 콘텐츠', schema.types.has('FAQPage') || questionHeads.length >= 3 ? 'pass' : questionHeads.length ? 'warn' : 'fail', 'FAQ 형식은 ChatGPT·Perplexity 답변에 그대로 인용되기 쉽습니다', 2);

  const score = axis => {
    const list = checks.filter(c => c.axis === axis);
    const total = list.reduce((s, c) => s + c.weight, 0);
    const got = list.reduce((s, c) => s + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
    return Math.round((got / total) * 100);
  };
  const scores = { naver: score('naver'), google: score('google'), aeo: score('aeo'), geo: score('geo') };
  scores.total = Math.round((scores.naver + scores.google + scores.aeo + scores.geo) / 4);

  return {
    url: finalUrl.href,
    requested: target.href,
    status: res.status,
    title,
    checkedAt: new Date().toISOString(),
    responseMs: ms,
    scores,
    counts: {
      total: checks.length,
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    },
    checks: checks.map(({ weight, ...c }) => ({ ...c, important: weight >= 3 })),
  };
}
