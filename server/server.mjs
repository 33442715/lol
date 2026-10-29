/**
 * GLOBAL BP online room server.
 *
 * Zero external dependencies:
 * - static files from ./site
 * - REST for room creation / joining / commands
 * - Server-Sent Events for realtime snapshots
 * - the same src/core.js state machine used by the browser
 *
 * Run: node server/server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../src/core.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = 64 * 1024;
const ROOM_TTL = 12 * 60 * 60 * 1000;
const MAX_SPECTATORS = 50;

let championIds;
try {
  championIds = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'champion-ids.json'), 'utf8')));
} catch (error) {
  console.error('Missing server/champion-ids.json. Run: python tools/build.py');
  process.exit(1);
}

const rooms = new Map();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'none'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function now() {
  return Date.now();
}

function cleanName(value, fallback, max = 20) {
  const name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!name) return fallback;
  return name.slice(0, max);
}

function cleanTeam(value, fallback) {
  return cleanName(value, fallback, 16);
}

function normalizeCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function isTeam(value) {
  return value === 'A' || value === 'B';
}

function otherTeam(team) {
  return team === 'A' ? 'B' : 'A';
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
    if (!rooms.has(code)) return code;
  }
  throw new ApiError(503, 'CODE_EXHAUSTED', '无法生成房间号，请稍后重试');
}

function makeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    hostName: room.hostName,
    config: { ...room.config },
    seats: {
      A: room.seats.A ? { name: room.seats.A.name } : null,
      B: room.seats.B ? { name: room.seats.B.name } : null
    },
    spectatorCount: Array.from(room.tokens.values()).filter((token) => !token.teamId).length,
    draft: room.draft,
    revision: room.revision,
    createdAt: room.createdAt,
    serverNow: now()
  };
}

function roomSnapshot(room) {
  return {
    room: publicRoom(room),
    serverNow: now()
  };
}

function getRoom(code) {
  const room = rooms.get(normalizeCode(code));
  if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', '房间不存在或已关闭');
  return room;
}

function getActor(room, token) {
  if (!token || typeof token !== 'string') throw new ApiError(401, 'NO_TOKEN', '缺少房间凭证');
  const actor = room.tokens.get(token);
  if (!actor) throw new ApiError(401, 'BAD_TOKEN', '房间凭证已失效，请重新加入');
  return actor;
}

function assertHost(actor) {
  if (!actor.isHost) throw new ApiError(403, 'NOT_HOST', '只有房主可以执行此操作');
}

function assertLobby(room) {
  if (room.status !== 'lobby') throw new ApiError(409, 'ALREADY_STARTED', '房间已经开始 BP');
}

function requireDraft(room) {
  if (!room.draft) throw new ApiError(409, 'NOT_LIVE', '房间尚未开始 BP');
  return room.draft;
}

function addToken(room, data) {
  const token = makeToken();
  room.tokens.set(token, {
    name: data.name,
    isHost: !!data.isHost,
    teamId: data.teamId || null,
    joinedAt: now()
  });
  return token;
}

function createRoom(body) {
  const teamA = cleanTeam(body.teamA, '队伍 A');
  const teamB = cleanTeam(body.teamB, '队伍 B');
  if (teamA === teamB) throw new ApiError(400, 'SAME_TEAM', '两支队伍名称不能相同');

  const format = Number(body.format) === 5 ? 5 : 3;
  const mode = body.mode === 'soft' ? 'soft' : 'hard';
  const timerEnabled = body.timerEnabled !== false;
  const turnSeconds = Math.min(90, Math.max(10, Math.round(Number(body.turnSeconds) || 30)));
  const hostName = cleanName(body.hostName, '房主');
  const hostSeat = body.hostSeat === 'B' ? 'B' : body.hostSeat === 'spectator' ? null : 'A';

  const room = {
    code: makeCode(),
    status: 'lobby',
    hostName,
    config: { teamA, teamB, format, mode, timerEnabled, turnSeconds, firstBlue: 'A', firstPick: 'A' },
    seats: { A: null, B: null },
    tokens: new Map(),
    connections: new Set(),
    draft: null,
    revision: 1,
    createdAt: now(),
    updatedAt: now()
  };
  if (hostSeat) room.seats[hostSeat] = { name: hostName };
  const token = addToken(room, { name: hostName, isHost: true, teamId: hostSeat });
  rooms.set(room.code, room);
  return {
    token,
    me: { name: hostName, isHost: true, teamId: hostSeat },
    room: publicRoom(room)
  };
}

function joinRoom(room, body) {
  const name = cleanName(body.name, '观众');
  const seat = body.seat === 'B' ? 'B' : body.seat === 'A' ? 'A' : 'spectator';

  if (seat !== 'spectator') {
    if (room.status !== 'lobby') {
      throw new ApiError(409, 'ROOM_STARTED', 'BP 已经开始，当前只能观战');
    }
    if (room.seats[seat]) throw new ApiError(409, 'SEAT_TAKEN', '该队伍队长席位已被占用');
  }
  if (seat === 'spectator' && Array.from(room.tokens.values()).filter((token) => !token.teamId).length >= MAX_SPECTATORS) {
    throw new ApiError(409, 'ROOM_FULL', '观战席位已满');
  }

  if (seat !== 'spectator') room.seats[seat] = { name };
  const token = addToken(room, { name, isHost: false, teamId: seat === 'spectator' ? null : seat });
  room.revision += 1;
  room.updatedAt = now();
  return {
    token,
    me: { name, isHost: false, teamId: seat === 'spectator' ? null : seat },
    room: publicRoom(room)
  };
}

function broadcast(room) {
  const payload = JSON.stringify(roomSnapshot(room));
  for (const connection of Array.from(room.connections)) {
    if (!writeSse(connection.res, payload)) room.connections.delete(connection);
  }
}

function writeSse(response, payload) {
  try {
    response.write('data: ' + payload + '\n\n');
    return true;
  } catch {
    return false;
  }
}

function closeRoom(room, message) {
  const payload = JSON.stringify({ closed: true, code: room.code, message: message || '房间已关闭' });
  for (const connection of Array.from(room.connections)) {
    try {
      connection.res.write('data: ' + payload + '\n\n');
      connection.res.end();
    } catch {
      /* noop */
    }
  }
  room.connections.clear();
  room.tokens.clear();
  rooms.delete(room.code);
}

function requireChampionId(value) {
  if (typeof value !== 'string' || !championIds.has(value)) {
    throw new ApiError(400, 'BAD_CHAMPION', '无效的英雄');
  }
  return value;
}

function applyChampion(room, actor, payload) {
  if (room.status !== 'live') throw new ApiError(409, 'NOT_LIVE', '房间尚未开始 BP');
  const turn = Core.getTurn(room.draft);
  if (!turn) throw new ApiError(409, 'NOT_DRAFTING', '当前不在 BP 阶段');
  if (!actor.teamId) throw new ApiError(403, 'SPECTATOR', '观战者不能操作 BP');
  if (actor.teamId !== turn.teamId) throw new ApiError(403, 'NOT_YOUR_TURN', '还没有轮到你操作');
  const champId = requireChampionId(payload.champId);
  Core.applyAction(room.draft, champId, now());
}

function command(room, actor, type, payload) {
  payload = payload && typeof payload === 'object' ? payload : {};

  switch (type) {
    case 'start': {
      assertHost(actor);
      assertLobby(room);
      if (!room.seats.A || !room.seats.B) {
        throw new ApiError(409, 'NEED_CAPTAINS', '需要两支队伍的队长都加入后才能开始');
      }
      room.draft = Core.createSeries({
        teamA: room.config.teamA,
        teamB: room.config.teamB,
        format: room.config.format,
        mode: room.config.mode,
        timerEnabled: room.config.timerEnabled,
        turnSeconds: room.config.turnSeconds,
        firstBlue: room.config.firstBlue,
        firstPick: room.config.firstPick
      }, now());
      room.status = 'live';
      break;
    }
    case 'champion':
      applyChampion(room, actor, payload);
      break;
    case 'undo':
      assertHost(actor);
      Core.undoAction(requireDraft(room), now());
      break;
    case 'pause':
      assertHost(actor);
      Core.pauseTimer(requireDraft(room), now());
      break;
    case 'resume':
      assertHost(actor);
      Core.resumeTimer(requireDraft(room), now());
      break;
    case 'swap-sides':
      assertHost(actor);
      Core.swapCurrentSides(requireDraft(room), now());
      break;
    case 'swap-order':
      assertHost(actor);
      Core.swapDraftOrder(requireDraft(room), now());
      break;
    case 'reset-game':
      assertHost(actor);
      Core.resetCurrentGame(requireDraft(room), now());
      break;
    case 'complete-game': {
      assertHost(actor);
      if (!isTeam(payload.winnerTeamId)) throw new ApiError(400, 'BAD_WINNER', '请选择本局胜者');
      Core.completeGame(requireDraft(room), payload.winnerTeamId, now());
      break;
    }
    case 'next-game': {
      assertHost(actor);
      const blueTeam = isTeam(payload.blueTeam) ? payload.blueTeam : null;
      const firstTeam = isTeam(payload.firstTeam) ? payload.firstTeam : null;
      if (!blueTeam || !firstTeam) throw new ApiError(400, 'BAD_SELECTION', '请选择地图蓝方与 BP 先选');
      Core.startNextGame(requireDraft(room), { blueTeam, firstTeam }, now());
      break;
    }
    case 'rematch': {
      assertHost(actor);
      if (!room.draft || room.draft.series.phase !== 'finished') {
        throw new ApiError(409, 'NOT_FINISHED', '系列赛尚未结束');
      }
      room.status = 'lobby';
      room.draft = null;
      break;
    }
    case 'release-seat': {
      assertHost(actor);
      assertLobby(room);
      const team = payload.team;
      if (!isTeam(team)) throw new ApiError(400, 'BAD_TEAM', '无效的队伍');
      if (actor.teamId === team) throw new ApiError(409, 'OWN_SEAT', '不能释放自己的队长席位');
      room.seats[team] = null;
      for (const [token, data] of Array.from(room.tokens.entries())) {
        if (data.teamId === team) room.tokens.delete(token);
      }
      break;
    }
    case 'leave': {
      if (actor.isHost) {
        closeRoom(room, '房主关闭了房间');
        return true;
      }
      room.tokens.delete(Array.from(room.tokens.entries()).find(([, data]) => data === actor)?.[0]);
      if (room.status === 'lobby' && actor.teamId && room.seats[actor.teamId]?.name === actor.name) {
        room.seats[actor.teamId] = null;
      }
      break;
    }
    case 'close':
      assertHost(actor);
      closeRoom(room, '房主关闭了房间');
      return true;
    default:
      throw new ApiError(400, 'UNKNOWN_COMMAND', '未知操作');
  }

  room.revision += 1;
  room.updatedAt = now();
  broadcast(room);
  return false;
}

async function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'BAD_JSON', '请求格式错误'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, rooms: rooms.size, now: now() });
    return true;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'rooms') return false;

  try {
    if (parts.length === 2 && request.method === 'POST') {
      const body = await readJson(request);
      const result = createRoom(body);
      sendJson(response, 201, { ok: true, serverNow: now(), ...result });
      return true;
    }

    if (parts.length === 3 && request.method === 'GET') {
      const room = getRoom(parts[2]);
      sendJson(response, 200, { ok: true, ...roomSnapshot(room) });
      return true;
    }

    if (parts.length === 4 && parts[3] === 'join' && request.method === 'POST') {
      const room = getRoom(parts[2]);
      const body = await readJson(request);
      const result = joinRoom(room, body);
      broadcast(room);
      sendJson(response, 200, { ok: true, serverNow: now(), ...result });
      return true;
    }

    if (parts.length === 4 && parts[3] === 'snapshot' && request.method === 'GET') {
      const room = getRoom(parts[2]);
      getActor(room, url.searchParams.get('token') || '');
      sendJson(response, 200, { ok: true, ...roomSnapshot(room) });
      return true;
    }

    if (parts.length === 4 && parts[3] === 'events' && request.method === 'GET') {
      const room = getRoom(parts[2]);
      const token = url.searchParams.get('token') || '';
      getActor(room, token);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write('retry: 2000\n\n');
      const connection = { res: response, token };
      room.connections.add(connection);
      writeSse(response, JSON.stringify(roomSnapshot(room)));
      const heartbeat = setInterval(() => {
        try {
          response.write(': keepalive\n\n');
        } catch {
          clearInterval(heartbeat);
          room.connections.delete(connection);
        }
      }, 15000);
      heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        room.connections.delete(connection);
      };
      request.on('close', cleanup);
      response.on('close', cleanup);
      return true;
    }

    if (parts.length === 4 && parts[3] === 'command' && request.method === 'POST') {
      const room = getRoom(parts[2]);
      const body = await readJson(request);
      const actor = getActor(room, body.token);
      const closed = command(room, actor, String(body.type || ''), body.payload || {});
      if (closed) {
        sendJson(response, 200, { ok: true, closed: true });
      } else {
        sendJson(response, 200, { ok: true, ...roomSnapshot(room) });
      }
      return true;
    }

    sendJson(response, 404, { ok: false, error: '接口不存在', code: 'NOT_FOUND' });
    return true;
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(response, error.status, { ok: false, error: error.message, code: error.code });
      return true;
    }
    if (error && error.name === 'DraftError') {
      sendJson(response, 409, { ok: false, error: error.message, code: error.code });
      return true;
    }
    console.error('API error', error);
    sendJson(response, 500, { ok: false, error: '服务器内部错误', code: 'INTERNAL' });
    return true;
  }
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    response.end('Method Not Allowed\n');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, SECURITY_HEADERS);
    response.end('Bad Request\n');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(SITE, '.' + pathname);
  if (!filePath.startsWith(SITE + path.sep) && filePath !== path.join(SITE, 'index.html')) {
    response.writeHead(403, SECURITY_HEADERS);
    response.end('Forbidden\n');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME[extension] || 'application/octet-stream';
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600'
    };
    if (extension === '.html') headers['Content-Security-Policy'] = CSP;
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(await fsp.readFile(filePath));
  } catch {
    response.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found\n');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(request, response, url);
    if (!handled) sendJson(response, 404, { ok: false, error: '接口不存在', code: 'NOT_FOUND' });
    return;
  }

  await serveStatic(request, response, url);
});

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

setInterval(() => {
  const cutoff = now() - ROOM_TTL;
  for (const [code, room] of rooms.entries()) {
    if (room.updatedAt < cutoff) {
      closeRoom(room, '房间长时间无人操作，已自动关闭');
      console.log('expired room', code);
    }
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  console.log('GLOBAL BP online server');
  console.log(`  Local:  http://localhost:${PORT}`);
  for (const address of addresses) console.log(`  LAN:    http://${address}:${PORT}`);
  console.log(`  Static: ${SITE}`);
  console.log(`  Rooms:  in-memory (restart clears rooms)`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
