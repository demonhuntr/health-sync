# HealthSync 电脑端接收服务

零第三方依赖版本 —— 只用 Node.js 内置 `http` / `fs` 模块。

## 快速开始

```bash
# 1. 启动服务（默认 0.0.0.0:8080，归档到 ../memory/health-data）
node server.mjs

# 2. 另开一个终端，测试
curl http://127.0.0.1:8080/health
curl -X POST http://127.0.0.1:8080/upload \
  -H "Content-Type: application/json" \
  -d '[{"dataType":"heartRate","startTime":1793000000000,"endTime":1793000060000,"value":72}]'

# 3. 看归档结果
curl http://127.0.0.1:8080/stats
node archive.mjs
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | 8080 | 监听端口 |
| `--host` | 0.0.0.0 | 监听地址（**只应在局域网内**）|
| `--dir` | `../memory/health-data` | 归档目录 |
| `--token` | 无（也可用环境变量 `HEALTHSYNC_TOKEN`）| 简单鉴权，Android 端需带 `X-Auth-Token` 头 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/upload` | 接收健康数据。接受三种形态：单个对象 / 对象数组 / `{"records":[...]}` |
| GET | `/health` | 健康检查 |
| GET | `/stats` | 已归档统计（文件数、记录数、每日明细）|

**上传记录格式**：
```json
{
  "dataType": "heartRate",
  "startTime": 1793000000000,
  "endTime": 1793000060000,
  "value": 72
}
```

## 归档产物

```
memory/health-data/
├── raw/
│   └── 2026-10-23.csv          # 原始记录
│       # date,dataType,startTime,endTime,value,source
├── daily-sleep-2026-10.csv     # 按天睡眠汇总
│       # date,sleepStart,sleepEnd,sleepMinutes,deepMinutes,lightMinutes,remMinutes,awakeMinutes,inBedMinutes,deepPct
└── daily-activity-2026-10.csv  # 按天活动汇总
        # date,steps,calories,distance,restHeartRate,activeMinutes,recordCount
```

## 安全说明

- **零第三方依赖** —— 没有 npm install，没有供应链 CVE 风险
- **只监听局域网** —— 不要把端口映射到公网
- **建议加 token**：`node server.mjs --token your-secret`，Android 端在 POST 时带 `X-Auth-Token` 头
- 数据为**明文 CSV**，请自行保护归档目录

## 睡眠数据说明

华为 Health Service Kit 的睡眠数据在不同 API 版本中 `dataType` 命名不一致，`archive.mjs` 用宽松匹配处理（`deep` / `light` / `rem` / `awake` 关键字）。若你的实际返回命名不同，检查 `raw/*.csv` 的第二列，改 `classifySleep()` 即可。

## 环境要求

- Node.js ≥ 18（用了内置 `node:` 前缀导入）
- 无需 npm install

---

*对应申请材料：https://github.com/demonhuntr/health-sync*
