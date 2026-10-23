#!/usr/bin/env node
/**
 * HealthSync 归档汇总脚本
 *
 * 把 raw/YYYY-MM-DD.csv 汇总成按天的睡眠/活动指标 CSV，
 * 供 Sleep Loop 决策脚本和趋势分析使用。
 *
 * 用法：
 *   node archive.mjs                     # 汇总全部
 *   node archive.mjs --month 2026-10     # 只汇总某月
 *   node archive.mjs --days 7            # 只汇总最近 7 天有数据的
 *
 * 产出：
 *   daily-sleep-YYYY-MM.csv       date, sleepStart, sleepEnd, sleepMinutes, deepMinutes, lightMinutes, remMinutes, awakeMinutes, inBedMinutes, deepPct
 *   daily-activity-YYYY-MM.csv    date, steps, calories, distance, restHeartRate, activeMinutes, recordCount
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const OUT_DIR = resolve(argVal('--dir', join(process.cwd(), '..', 'memory', 'health-data')));
const RAW_DIR = join(OUT_DIR, 'raw');
const MONTH = argVal('--month', '');
const DAYS = Number(argVal('--days', '0'));

if (!existsSync(RAW_DIR)) {
  console.error(`[healthsync] 找不到原始数据目录: ${RAW_DIR}`);
  process.exit(1);
}

const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.csv')).sort();
let targets = files;
if (MONTH) targets = files.filter((f) => f.startsWith(MONTH));
if (DAYS > 0) targets = files.slice(-DAYS);

console.log(`[healthsync] 待汇总 ${targets.length} 个文件`);

// ---------- 解析原始记录 ----------
function parseRaw(file) {
  const p = join(RAW_DIR, file);
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    rows.push({
      date: c[idx.date],
      dataType: c[idx.dataType],
      startTime: Number(c[idx.startTime]),
      endTime: Number(c[idx.endTime]),
      value: c[idx.value],
    });
  }
  return rows;
}

// 睡眠阶段映射：不同 API 的 dataType 命名可能不同，这里做宽松匹配
const SLEEP_TYPES = {
  deep: ['sleep', 'sleepstage', 'sleep_stage', 'deep_sleep', 'deepsleep', 'sleepdeep'],
  light: ['sleeplight', 'light_sleep', 'lightsleep', 'sleeplightstage'],
  rem: ['sleeprem', 'rem_sleep', 'remsleep', 'sleepremstage'],
  awake: ['sleepawake', 'awake', 'wake', 'sleepwake'],
};

function classifySleep(dataType) {
  const t = String(dataType || '').toLowerCase().replace(/[\s-]/g, '');
  if (t.includes('deep')) return 'deep';
  if (t.includes('rem')) return 'rem';
  if (t.includes('awake') || t.includes('wake')) return 'awake';
  if (t.includes('light')) return 'light';
  if (t.includes('sleep') || t.includes('stage')) return 'light'; // 默认归 light
  return null;
}

// ---------- 汇总 ----------
const sleepMap = new Map(); // date -> {stages:{}, start, end}
const actMap = new Map();  // date -> {steps,calories,distance,restHr,activeMin,count}

function sleepBucket(date) {
  if (!sleepMap.has(date)) {
    sleepMap.set(date, { stages: { deep: 0, light: 0, rem: 0, awake: 0 }, start: null, end: null, has: false });
  }
  return sleepMap.get(date);
}

function actBucket(date) {
  if (!actMap.has(date)) {
    actMap.set(date, { steps: 0, calories: 0, distance: 0, restHr: null, activeMin: 0, count: 0 });
  }
  return actMap.get(date);
}

for (const f of targets) {
  const rows = parseRaw(f);
  for (const r of rows) {
    if (!r.date || Number.isNaN(r.startTime)) continue;
    const durMin = Math.max(0, Math.round((r.endTime - r.startTime) / 60000));
    const val = Number(r.value);
    const type = String(r.dataType || '').toLowerCase();

    // 睡眠
    const stage = classifySleep(r.dataType);
    if (stage) {
      const b = sleepBucket(r.date);
      b.has = true;
      b.stages[stage] += Number.isFinite(val) && val > 1000 ? val / 60000 : durMin;
      // 睡眠起止时间：取所有睡眠类记录的最小 start 和最大 end
      if (b.start === null || r.startTime < b.start) b.start = r.startTime;
      if (b.end === null || r.endTime > b.end) b.end = r.endTime;
      continue;
    }

    // 活动 / 心率
    const b = actBucket(r.date);
    b.count += 1;
    if (type.includes('step')) b.steps += Number.isFinite(val) ? val : 0;
    else if (type.includes('calorie')) b.calories += Number.isFinite(val) ? val : 0;
    else if (type.includes('distance')) b.distance += Number.isFinite(val) ? val : 0;
    else if (type.includes('rest') || type.includes('heartrateRest')) b.restHr = Number.isFinite(val) ? val : b.restHr;
    else if (type.includes('active')) b.activeMin += durMin;
  }
}

function hhmm(ms) {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 输出 ----------
const sleepRows = [];
const actRows = [];
const allDates = [...new Set([...sleepMap.keys(), ...actMap.keys()])].sort();

for (const date of allDates) {
  const s = sleepMap.get(date);
  if (s && s.has) {
    const deep = Math.round(s.stages.deep);
    const light = Math.round(s.stages.light);
    const rem = Math.round(s.stages.rem);
    const awake = Math.round(s.stages.awake);
    const total = deep + light + rem + awake;
    const sleepMin = deep + light + rem;
    sleepRows.push([
      date,
      hhmm(s.start),
      hhmm(s.end),
      sleepMin,
      deep,
      light,
      rem,
      awake,
      total,
      sleepMin > 0 ? (deep / sleepMin * 100).toFixed(1) : '',
    ].join(','));
  }

  const a = actMap.get(date);
  if (a && a.count) {
    actRows.push([
      date,
      Math.round(a.steps),
      Math.round(a.calories),
      a.distance.toFixed(2),
      a.restHr ?? '',
      Math.round(a.activeMin),
      a.count,
    ].join(','));
  }
}

mkdirSync(OUT_DIR, { recursive: true });

// 按月分文件
const sleepByMonth = new Map();
for (const row of sleepRows) {
  const m = row.slice(0, 7);
  if (!sleepByMonth.has(m)) sleepByMonth.set(m, []);
  sleepByMonth.get(m).push(row);
}
const actByMonth = new Map();
for (const row of actRows) {
  const m = row.slice(0, 7);
  if (!actByMonth.has(m)) actByMonth.set(m, []);
  actByMonth.get(m).push(row);
}

for (const [m, rows] of sleepByMonth) {
  const f = join(OUT_DIR, `daily-sleep-${m}.csv`);
  writeFileSync(f, 'date,sleepStart,sleepEnd,sleepMinutes,deepMinutes,lightMinutes,remMinutes,awakeMinutes,inBedMinutes,deepPct\n' + rows.join('\n') + '\n', 'utf8');
  console.log(`[healthsync] 写入 ${f} (${rows.length} 天)`);
}
for (const [m, rows] of actByMonth) {
  const f = join(OUT_DIR, `daily-activity-${m}.csv`);
  writeFileSync(f, 'date,steps,calories,distance,restHeartRate,activeMinutes,recordCount\n' + rows.join('\n') + '\n', 'utf8');
  console.log(`[healthsync] 写入 ${f} (${rows.length} 天)`);
}

// ---------- 控制台摘要 ----------
console.log('\n===== 最近 7 天睡眠摘要 =====');
const recent = sleepRows.slice(-7);
if (!recent.length) {
  console.log('（暂无睡眠数据）');
} else {
  console.log('日期        入睡   醒来   睡眠   深睡   深睡%');
  for (const r of recent) {
    const c = r.split(',');
    console.log(`${c[0]}  ${c[1]}  ${c[2]}  ${String(c[3]).padStart(4)}m  ${String(c[4]).padStart(4)}m  ${String(c[9] || '-').padStart(5)}%`);
  }
  const avgSleep = recent.reduce((a, r) => a + Number(r.split(',')[3]), 0) / recent.length;
  const avgDeep = recent.reduce((a, r) => a + Number(r.split(',')[4]), 0) / recent.length;
  const avgPct = recent.filter((r) => r.split(',')[9]).reduce((a, r) => a + Number(r.split(',')[9]), 0) / Math.max(1, recent.filter((r) => r.split(',')[9]).length);
  console.log(`\n平均睡眠: ${avgSleep.toFixed(0)} 分钟 (${(avgSleep / 60).toFixed(2)} 小时)`);
  console.log(`平均深睡: ${avgDeep.toFixed(0)} 分钟 (${(avgDeep / 60).toFixed(2)} 小时)`);
  console.log(`平均深睡占比: ${avgPct.toFixed(1)}%`);
  console.log(`目标: 睡眠 >= 420 分钟, 深睡 105-120 分钟 (CDC)`);
  console.log(`状态: 睡眠 ${avgSleep >= 420 ? '✅ 达标' : '⚠️ 不足'} | 深睡 ${avgDeep >= 105 && avgDeep <= 120 ? '✅ 达标' : avgDeep > 120 ? '偏高' : '⚠️ 不足'}`);
}

console.log('\n===== 最近 7 天活动摘要 =====');
const recentAct = actRows.slice(-7);
if (!recentAct.length) {
  console.log('（暂无活动数据）');
} else {
  console.log('日期        步数     热量   静息心率  活动分钟');
  for (const r of recentAct) {
    const c = r.split(',');
    console.log(`${c[0]}  ${String(c[1]).padStart(6)}  ${String(c[2]).padStart(6)}  ${String(c[4] || '-').padStart(6)}  ${String(c[5]).padStart(6)}`);
  }
  const avgSteps = recentAct.reduce((a, r) => a + Number(r.split(',')[1]), 0) / recentAct.length;
  console.log(`\n平均步数: ${Math.round(avgSteps)}`);
}

console.log('\n[healthsync] 汇总完成');
