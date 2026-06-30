// ===== 삐삐 / Pager — Cloudflare Worker =====
// - 모든 데이터는 단일 "board" 키 1개에 저장 → 전송 1회 = KV 쓰기 1회
//   (KV 무료 쓰기 한도 1,000/일 과 DAILY_LIMIT 을 일치시켜 "/1,000"을 정직하게 유지)
// - /api/feed 응답을 엣지 캐시(Cache API)로 6초 보관 → 폴링이 KV 읽기를 거의 안 깎음
// - 정적 파일(index.html)은 ASSETS 로 서빙

const SERVER_COUNT = 10;     // 서버(주파수) 개수 — index.html 의 값과 맞춰서 변경
const FEED_LIMIT   = 40;     // 주파수당 보관 호출 수
const DAILY_LIMIT  = 1000;   // 하루 메시지 한도 (KV 무료 쓰기 한도와 동일)
const MAX_NAME     = 12;
const MAX_MSG      = 50;
const CACHE_TTL    = 6;      // 피드 엣지 캐시 (초)
const CACHE_URL    = "/__board";  // 캐시 전용 내부 키

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feed") return getFeed(request, url, env, ctx);
    if (url.pathname === "/api/page") return postPage(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};

/* ---------- helpers ---------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function clampServer(v) {
  const n = parseInt(v, 10);
  return (n >= 1 && n <= SERVER_COUNT) ? n : 1;
}
function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
// 일일 한도/카운터는 UTC 날짜 기준 (KV 무료 쓰기 한도가 UTC 0시에 리셋되는 것과 정렬)
function utcDay() { return new Date().toISOString().slice(0, 10); }

function freshBoard() {
  const s = {};
  for (let i = 1; i <= SERVER_COUNT; i++) s[i] = [];
  return { day: utcDay(), dayCount: 0, total: 0, s };
}
function normalize(board) {
  if (!board || typeof board !== "object") board = freshBoard();
  if (!board.s) board.s = {};
  for (let i = 1; i <= SERVER_COUNT; i++) if (!Array.isArray(board.s[i])) board.s[i] = [];
  if (board.day !== utcDay()) { board.day = utcDay(); board.dayCount = 0; } // 날짜 바뀌면 일일 카운터만 리셋
  if (typeof board.dayCount !== "number") board.dayCount = 0;
  if (typeof board.total !== "number") board.total = 0;
  return board;
}

/* ---------- GET /api/feed (엣지 캐시) ---------- */
async function getFeed(request, url, env, ctx) {
  const server = clampServer(url.searchParams.get("s"));
  const cache = caches.default;
  const cacheKey = new Request(new URL(CACHE_URL, request.url).toString());

  let board;
  const cached = await cache.match(cacheKey);
  if (cached) {
    board = await cached.json();
  } else {
    const raw = await env.PAGER_KV.get("board");      // 캐시 미스일 때만 KV 읽기
    board = normalize(raw ? JSON.parse(raw) : null);
    const toCache = new Response(JSON.stringify(board), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + CACHE_TTL }
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }

  return json({
    server,
    messages: board.s[server] || [],
    dayCount: board.dayCount,
    limit: DAILY_LIMIT,
    total: board.total
  });
}

/* ---------- POST /api/page (쓰기 1회) ---------- */
async function postPage(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "method" }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_json" }, 400); }

  const server = clampServer(body.server);
  const name = clean(body.name, MAX_NAME) || "익명";
  const text = clean(body.text, MAX_MSG);
  if (!text) return json({ error: "empty" }, 400);

  // 전송 시에는 캐시 말고 KV에서 최신값 읽기 (카운터/메시지 정확도)
  const raw = await env.PAGER_KV.get("board");
  const board = normalize(raw ? JSON.parse(raw) : null);

  // 일일 한도 도달 → KV 쓰기 한도를 넘기기 전에 차단
  if (board.dayCount >= DAILY_LIMIT) {
    return json({ error: "quota", dayCount: board.dayCount, limit: DAILY_LIMIT }, 429);
  }

  const item = { n: name, t: text, ts: Date.now() };
  const arr = board.s[server];
  arr.unshift(item);
  if (arr.length > FEED_LIMIT) arr.length = FEED_LIMIT;
  board.dayCount += 1;
  board.total += 1;

  await env.PAGER_KV.put("board", JSON.stringify(board));   // ← 유일한 KV 쓰기

  // 캐시 무효화 → 보낸 사람이 바로 피드에서 확인
  const cacheKey = new Request(new URL(CACHE_URL, request.url).toString());
  ctx.waitUntil(caches.default.delete(cacheKey));

  return json({ ok: true, server, item, dayCount: board.dayCount, limit: DAILY_LIMIT, total: board.total });
}
