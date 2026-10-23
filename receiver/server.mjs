#!/usr/bin/env node
/**
 * HealthSync 电脑端接收服务
 *
 * 零第三方依赖 —— 只用 Node.js 内置模块。
 * 监听局域网，把 HarmonyOS 应用上传的健康数据归档成 CSV。
 *
 * 用法：
 *   node server.mjs                        # 默认 0.0.0.0:8080，目录 ../memory/health-data
 *   node server.mjs --port 8080            # 指定端口
 *   node server.mjs --dir D:\health-data   # 指定归档目录
 *   node server.mjs --token my-secret      # 简单鉴权（推荐，Android 端需带同一 token）
 *
 * 接口：
 *   POST /upload    接收健康数据 JSON 数组 → 写入 CSV
 *   GET  /health    健康检查
 *   GET  /stats     查看已归档统计
 */

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

// ---------- 参数解析 ----------
function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(argVal('--port', '8080'));
const HOST = argVal('--host', '0.0.0.0');
const TOKEN = argVal('--token', process.env.HEALTHSYNC_TOKEN || '');
const OUT_DIR = resolve(argVal('--dir', join(process.cwd(), '..', 'memory', 'health-data')));

const RAW_SUBDIR = 'raw';
const CSV_HEADER = 'date,dataType,startTime,endTime,value,source';

// ---------- 工具 ----------
function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function log(msg) {
  console.log(`[${nowStamp()}] ${msg}`);
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

// ---------- 归档 ----------
function ensureDirs() {
  mkdirSync(join(OUT_DIR, RAW_SUBDIR), { recursive: true });
}

function archive(records) {
  ensureDirs();
  const buckets = new Map(); // dayKey -> lines[]

  for (const r of records) {
    const { dataType, startTime, endTime, value } = r;
    if (!dataType || typeof startTime !== 'number') {
      log(`跳过格式不正确的记录: ${JSON.stringify(r).slice(0, 120)}`);
      continue;
    }
    const day = dayKey(startTime);
    if (!buckets.has(day)) buckets.set(day, []);
    const end = typeof endTime === 'number' ? endTime : startTime;
    buckets.get(day).push(`${day},${dataType},${startTime},${end},${value ?? ''},healthsync`);
  }

  const written = [];
  for (const [day, lines] of buckets) {
    const file = join(OUT_DIR, RAW_SUBDIR, `${day}.csv`);
    const isNew = !existsSync(file);
    appendFileSync(file, (isNew ? CSV_HEADER + '\n' : '') + lines.join('\n') + '\n', 'utf8');
    written.push({ file, records: lines.length, created: isNew });
  }
  return written;
}

function stats() {
  const dir = join(OUT_DIR, RAW_SUBDIR);
  if (!existsSync(dir)) return { files: 0, days: [], totalRecords: 0 };
  const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
  let total = 0;
  const days = [];
  for (const f of files) {
    const p = join(dir, f);
    const size = statSync(p).size;
    const lines = existsSync(p) ? require('node:fs').readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0;
    total += Math.max(0, lines - 1);
    days.push({ day: f.replace('.csv', ''), bytes: size, records: Math.max(0, lines - 1) });
  }
  days.sort((a, b) => b.day.localeCompare(a.day));
  return { files: files.length, totalRecords: total, days };
}

// ---------- HTTP ----------
function send(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token',
    });
    return res.end();
  }

  // 健康检查
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'healthsync-receiver', time: nowStamp() });
  }

  // 统计
  if (req.method === 'GET' && url.pathname === '/stats') {
    try {
      return send(res, 200, { ok: true, outDir: OUT_DIR, ...stats() });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message });
    }
  }

  // 上传
  if (req.method === 'POST' && url.pathname === '/upload') {
    if (TOKEN) {
      const provided = req.headers['x-auth-token'] || url.searchParams.get('token');
      if (provided !== TOKEN) {
        log('鉴权失败：缺少或错误的 X-Auth-Token');
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
    }
    try {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { ok: false, error: 'invalid JSON' });
      }
      // 兼容单个对象 / 数组 / {records:[...]} 三种形态
      const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.records) ? parsed.records : [parsed]);
      if (!records.length) {
        return send(res, 400, { ok: false, error: 'no records' });
      }
      const written = archive(records);
      log(`接收 ${records.length} 条记录 → ${written.length} 个文件`);
      for (const w of written) log(`  ${w.created ? '新建' : '追加'} ${w.file} (${w.records} 条)`);
      return send(res, 200, {
        ok: true,
        received: records.length,
        files: written.map((w) => ({ file: w.file, records: w.records })),
      });
    } catch (e) {
      log(`处理失败: ${e.message}`);
      return send(res, 500, { ok: false, error: e.message });
    }
  }

  return send(res, 404, { ok: false, error: 'not found', routes: ['POST /upload', 'GET /health', 'GET /stats'] });
});

server.listen(PORT, HOST, () => {
  log('='.repeat(58));
  log('HealthSync 接收服务已启动');
  log(`监听地址: http://${HOST}:${PORT}`);
  log(`归档目录: ${OUT_DIR}`);
  log(`鉴权: ${TOKEN ? '已启用 (X-Auth-Token)' : '未启用'}`);
  log('--- 手机端请用下面任一地址（同一局域网）---');
  for (const a of lanAddresses()) {
    log(`  http://${a.address}:${PORT}/upload   (${a.name})`);
  }
  log('='.repeat(58));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用。换端口：node server.mjs --port ${PORT + 1}`);
  } else {
    log(`服务错误: ${e.message}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });
