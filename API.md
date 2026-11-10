# hikctl REST API 契约（冻结版 v1）

服务监听 `http://127.0.0.1:<port>`（默认 8787），仅本机可访问。
所有请求/响应均为 `application/json`（除标注为二进制/流式者）。
错误统一：HTTP 4xx/5xx + `{ "error": { "code": "...", "message": "..." } }`。

## 0. 通用

- `id` = 设备唯一标识，字符串，等于 `"<ip>:<port>"`（如 `"192.168.1.64:80"`）。
- 时间均为毫秒时间戳（number）。
- 密码只在写入时出现，读取接口永不返回密码。

---

## 1. 服务

### `GET /api/health`
```json
{ "ok": true, "version": "1.0.0", "uptimeMs": 12345, "port": 8787 }
```

---

## 2. 设备

### `GET /api/devices`
```json
[
  {
    "id": "192.168.1.64:80",
    "ip": "192.168.1.64",
    "port": 80,
    "https": false,
    "username": "admin",
    "label": "东门-球机",
    "group": "默认分组",
    "addedAt": 1730000000000,
    "status": {
      "online": true,
      "checkedAt": 1730000000000,
      "latencyMs": 23,
      "deviceName": "CAM-01",
      "model": "DS-2DE7A425IW-AEB",
      "serialNumber": "DS-2DE7A425IW-AEB20200101AAWR123456789",
      "firmwareVersion": "V5.7.3 build 210628",
      "firmwareReleasedDate": "2021-06-28",
      "deviceType": "IPCamera",
      "macAddress": "aa:bb:cc:dd:ee:ff",
      "channelCount": 1,
      "activated": true,
      "error": null
    }
  }
]
```

### `POST /api/devices`
请求：`{ "ip": "192.168.1.64", "port": 80, "https": false, "username": "admin", "password": "xxx", "label": "", "group": "" }`
响应：`{ "device": { ...同 GET /api/devices 单项... }, "probe": { ...status... } }`
错误：`400 PROBE_FAILED` 时仍会把设备写入，`probe.online=false`。

### `DELETE /api/devices/:id` → `{ "ok": true }`

### `PATCH /api/devices/:id`
请求：`{ "label"?: string, "group"?: string, "username"?: string, "password"?: string, "port"?: number, "https"?: boolean }`
响应：`{ "device": {...} }`

### `POST /api/devices/:id/probe` → `{ "status": {...} }`
### `POST /api/devices/probe-all` → `{ "taskId": "..." }`（异步，进度走 SSE）

### `POST /api/devices/import`
请求：`{ "text": "192.168.1.64,admin,pass123\n192.168.1.65,admin,pass456", "defaultUsername": "admin" }`
响应：`{ "added": 2, "skipped": 0, "failed": [{"line":"...","reason":"..."}], "taskId": "..." }`

---

## 3. 发现

### `POST /api/discover/sadp`
请求：`{ "timeoutMs": 3000 }`（默认 3000）
响应：
```json
{
  "found": [
    {
      "ip": "192.168.1.64",
      "mac": "aa:bb:cc:dd:ee:01",
      "serialNumber": "HK-Y2S4M-GL/L20230101AAWRL000001",
      "model": "HK-Y2S4M-GL/L",
      "firmwareVersion": "V5.8.110build 260713",
      "deviceType": "IPCamera",
      "deviceTypeCode": "168482",
      "httpPort": 80,
      "sdkPort": 8000,
      "activated": true,
      "dhcpEnabled": true,
      "gateway": "0.0.0.0",
      "subnetMask": "255.255.252.0",
      "dnsServer": "",
      "softwareVersion": "V5.8.110build 260713",
      "dspVersion": "V7.3 build 260326",
      "bootTime": "2000-01-02 08:00:10",
      "digitalChannelNum": "1",
      "encrypt": true,
      "resetAbility": false,
      "salt": "52a3accc…",
      "alreadyAdded": false,
      "via": "sadp:37020",
      "replyFrom": "192.168.1.64:37020"
    }
  ],
  "elapsedMs": 4015,
  "diagnostics": { "sockets": [], "errors": [] }
}
```
> 真机应答元素是 `<ProbeMatch>`（不是 `ProbeResponse`）；型号在 `DeviceDescription`，
> SDK 端口在 `CommandPort`，DHCP 字段名是 `DHCP`，`DeviceType` 是**数字硬件代码**（另存于 `deviceTypeCode`）。
>
> 萤石云相关字段（无需登录即可拿到）：
> - `supportEzvizUnbind` (boolean) — 是否支持解绑
> - `ezvizBindStatus` (string) — `"0"`=未绑定，`"1"`=已绑定；设备未上报时为空串
> - `hcPlatformEnable` / `supportHcPlatform` (boolean) — 海康云平台相关
> - `activated` (boolean) — **是否已激活**（未激活的设备在这一列显示红色「未激活」）

## 3.4 萤石云状态（随设备探测一起返回）

`GET /api/devices`、`GET /api/devices/:id/probe`、`POST /api/devices` 的 `status` 对象里新增：
```json
{
  "ezviz": {
    "supported": true,            // 接口是否可用（本机型无 isSupportEZVIZ 标志，能返回 <EZVIZ> 即视为支持）
    "enabled": false,             // 萤石云服务是否已开启
    "bound": false,               // 是否已绑定到萤石云（由 registerStatus || bindStatus 推导，UI 请优先用这个）
    "registerStatus": "false",    // ★ 真机的绑定标志字段
    "bindStatus": "",             // 其它固件的绑定字段（本机型为空串，**不要单独依赖它判断**）
    "verificationCode": "",       // 绑定验证码
    "verificationCodeLength": { "min": 6, "max": 12 },
    "serverAddress": "litedev.ys7.com",
    "convergenceCloudEnabled": false,
    "upIsapiStatus": "close",
    "streamEncrypteEnabled": true,   // 视频加密能力
    "supportUpIsapi": true,
    "supportDownIsapi": true,
    "supportUnbind": null,        // true/false，**设备未声明时为 null**（UI 显示「—」而不是「否」）；
                                  // 部分固件只在 SADP 的 supportEzvizUnbind 里报告
    "error": null                 // 取不到时的原因（不影响设备在线判定）
  }
}
```
数据来源：`GET /ISAPI/System/Network/EZVIZ` + `GET /ISAPI/System/Network/EZVIZ/capabilities`。

> ⚠ 判定"是否已绑定"**必须用 `bound`**：
> 本机型返回 `registerStatus:"false"` 且 `bindStatus:""`，
> 只看 `bindStatus` 会误判为"未知"。

**UI 渲染建议**：
| 条件 | 显示 |
|---|---|
| `supported === false` | `不支持`（灰） |
| `enabled === false` | `未开启`（灰） |
| `enabled === true && bound === false` | `已开启 · 未绑定`（蓝） |
| `enabled === true && bound === true` | `已开启 · 已绑定`（琥珀/红，提示已被人绑定） |
| `ezviz == null` 或设备离线 | `—` |

> ⚠ 本机型的绑定字段是 **`registerStatus`**，不是 `bindStatus`；两者都解析，优先 `registerStatus`。

巡检报表也新增列：`萤石云支持` / `萤石云开启` / `萤石云绑定` / `萤石云绑定值` / `绑定验证码`。

### `POST /api/discover/scan`
请求：`{ "from": "192.168.1.1", "to": "192.168.1.254", "username": "admin", "password": "xxx", "concurrency": 64, "timeoutMs": 800, "ports": [80, 443] }`
响应：`{ "taskId": "..." }`（异步）
SSE 事件：`{"type":"scan.result","data":{...}}`

`scan.result` 的 data：
```json
{
  "ip": "192.168.1.64", "port": 80, "https": false, "found": true,
  "activated": true,          // true=已激活；false=未激活；null=TCP 通但既非未激活也无法登录
  "needsActivation": false,   // true 时前端应展示「激活」按钮
  "supportVersion": 3,        // 未激活设备才有
  "tcpMs": 12, "latencyMs": 18, "authMode": "session",
  "model": "HK-Y2S4M-GL/L", "serialNumber": "...", "deviceName": "...",
  "firmwareVersion": "...", "deviceType": "IPCamera", "macAddress": "...",
  "error": null,
  "progress": { "scanned": 10, "total": 254, "found": 1, "elapsedMs": 1200 }
}
```
> **未激活的设备也能被扫出来**：它们会拒绝所有 ISAPI 调用（403 notActivated），
> 但 `/SDK/activateStatus` 无需鉴权，所以扫描器先查它。
> 这类结果 `activated=false`、`needsActivation=true`，但 `model`/`serialNumber` 为空。
> 需要型号/序列号请用 SADP（SADP 无需登录即可给出完整信息）。

完成：`{"type":"task.done","data":{"taskId":"...","summary":{"scanned":254,"found":3,"elapsedMs":9000}}}`

---

## 3.5 设备激活（用于未激活的新设备，此时设备还不在设备库里）

### `GET /api/activate/status?ip=192.168.1.64&port=80`
```json
{ "reachable": true, "activated": false, "inactive": true, "supportVersion": 3, "httpStatus": 200 }
```

### `GET /api/activate/config`
激活相关的默认配置。前端**必须**用它预填密码，不要硬编码。
```json
{
  "defaultPassword": "1q2w3e4r",
  "minLength": 8,
  "maxLength": 16,
  "minClasses": 2,
  "defaultConcurrency": 8
}
```
> 海康实际策略：8–16 位，且包含大写/小写/数字/符号中的**至少 2 类**。

### `POST /api/activate/challenge`
请求：`{ "ip": "192.168.1.64", "port": 80 }`（**不改变设备状态**，可安全用于验证兼容性）
响应：
```json
{
  "ok": true,
  "keyFormat": "hex-modulus",
  "challengeBytes": 16,
  "challengeHex": "0d874dbd…",
  "decryptVia": "base64->hex->bytes",
  "attempts": [ { "format": "hex-modulus", "httpStatus": 200, "ok": true } ]
}
```

### `POST /api/activate`
请求：`{ "ip": "192.168.1.64", "port": 80, "password": "1q2w3e4r", "userName": "admin", "label": "", "autoAdd": true }`
`password` 省略时使用 `defaultPassword`。
响应：
```json
{
  "ok": true, "activated": true, "supportVersion": 3,
  "keyFormat": "hex-modulus", "challengeBytes": 16,
  "message": "激活成功，管理员账号 admin，密码已设置",
  "device": { "...设备对象，autoAdd=true 时返回..." }
}
```
错误：`400` + `{ "error": { "message": "密码长度至少 8 位" } }`

### `POST /api/activate/batch`  ★ 批量激活
请求：
```json
{
  "targets": [ { "ip": "192.168.1.64", "port": 80 }, { "ip": "192.168.1.65", "port": 80 } ],
  "password": "1q2w3e4r",
  "concurrency": 8,
  "autoAdd": true,
  "label": ""
}
```
- `password` 省略时使用 `defaultPassword`
- `targets` 里的 `port` 省略时默认 80
- `autoAdd`（默认 true）：激活成功的设备自动加入设备库并探测一次

响应：`{ "taskId": "t_xxxxxxxx" }`

SSE 事件（与其它任务一致）：
```
{"type":"task.start","data":{"taskId":"t_1","action":"activate","total":3}}
{"type":"task.progress","data":{"taskId":"t_1","id":"192.168.1.64:80","state":"ok","message":"激活成功，已加入设备库","ms":526}}
{"type":"task.progress","data":{"taskId":"t_1","id":"192.168.1.65:80","state":"failed","message":"激活失败：HTTP 400 ...","ms":310}}
{"type":"task.done","data":{"taskId":"t_1","summary":{"total":3,"ok":2,"failed":1,"elapsedMs":1580}}}
```
- `id` 是 **`ip:port`**（不是裸 IP），任务内所有动作都用这个 key 对齐
- SSE 的 `task.progress` **不含 `detail` 字段**；`detail` 只在 `GET /api/tasks/:id` 的 `results[]` 里返回
- `state`: `ok` | `failed` | `skipped`（已激活的设备会被跳过并记为 `ok`，message 为「设备已激活」）

> ⚠ 激活会**设置设备管理员密码**。已激活的设备不会重复激活。

## 3.6 设备重启会话检查
设备重启会使服务中断数十秒。判断是否真的重启，应监控 TCP 端口而不是轮询 ISAPI：

```powershell
# tools/diag-reboot2.mjs 的做法：400ms 粒度探测 TCP :80
node tools/diag-reboot2.mjs <ip> <port> <user> <pass> 90
```

## 4. 原始 ISAPI 透传（高级/调试）

### `GET /api/devices/:id/isapi?path=/ISAPI/System/deviceInfo`
响应：`{ "status": 200, "contentType": "application/xml", "body": "<DeviceInfo>...</DeviceInfo>", "ms": 21 }`

### `PUT /api/devices/:id/isapi`
请求：`{ "path": "/ISAPI/System/time", "body": "<Time>...</Time>", "contentType": "application/xml" }`
响应：同 GET。

---

## 5. 单设备操作

### `POST /api/devices/:id/reboot` → `{ "ok": true, "message": "设备正在重启" }`

### `POST /api/devices/:id/reset`
请求：`{ "mode": "basic" | "full", "password": "当前登录密码" }`
- `basic` = 简单恢复（保留 IP/用户名/密码/激活状态/网络参数）
- `full`  = 完全恢复（含 IP，恢复后默认 192.168.1.64）
响应：`{ "ok": true, "mode": "full", "message": "..." }`

### `PUT /api/devices/:id/network`
请求：`{ "interfaceId": 1, "ip": "192.168.1.100", "mask": "255.255.255.0", "gateway": "192.168.1.1", "dns": "8.8.8.8", "dhcp": false }`
响应：`{ "ok": true, "rebootRequired": true, "newId": "192.168.1.100:80", "message": "..." }`

### `PUT /api/devices/:id/time`
请求（三选一）：
- `{ "mode": "pc" }` — 用服务器当前时间对时
- `{ "mode": "manual", "dateTime": "2025-01-01T12:00:00" }`
- `{ "mode": "ntp", "server": "pool.ntp.org", "port": 123, "intervalMinutes": 60 }`
响应：`{ "ok": true, "applied": "..." }`

### `PUT /api/devices/:id/password`
请求：`{ "userName": "admin", "oldPassword": "xxx", "newPassword": "yyy" }`
响应：`{ "ok": true }`

---

## 6. 批量操作

### `POST /api/batch`
请求：
```json
{
  "deviceIds": ["192.168.1.64:80", "..."],
  "action": "probe" | "reboot" | "reset" | "setTime" | "setNetwork" | "setPassword",
  "params": { },
  "concurrency": 16
}
```
`params` 随 action：
- `reset`: `{ "mode": "basic"|"full" }`
- `setTime`: 同 `PUT /api/devices/:id/time`
- `setNetwork`: 同 `PUT /api/devices/:id/network`
- `setPassword`: `{ "userName":"admin", "newPassword":"yyy" }`（每台设备用自己的已存密码）

响应：`{ "taskId": "..." }`

SSE 事件：
```
{"type":"task.start","data":{"taskId":"t1","action":"reboot","total":10}}
{"type":"task.progress","data":{"taskId":"t1","id":"192.168.1.64:80","state":"ok","message":"...","ms":120}}
{"type":"task.progress","data":{"taskId":"t1","id":"192.168.1.65:80","state":"failed","message":"401 鉴权失败","ms":90}}
{"type":"task.done","data":{"taskId":"t1","summary":{"total":10,"ok":9,"failed":1,"elapsedMs":2200}}}
```
`state`: `pending` | `running` | `ok` | `failed` | `skipped`

### `GET /api/tasks` → `[{ "taskId":"t1","action":"reboot","state":"running","total":10,"done":4,"startedAt":0 }]`
### `GET /api/tasks/:id` → 同上单项 + `results: [{id,state,message,ms}]`

---

## 7. 实时预览

### `GET /api/devices/:id/snapshot?channel=101`
响应：`image/jpeg` 二进制。

### `GET /api/devices/:id/preview.mjpg?channel=101`
响应：`multipart/x-mixed-replace; boundary=...`，可直接用于 `<img src>`。
服务端自动选择：优先设备 MJPEG（`httpPreview`），否则降级为服务端抓图轮询（可带 `?fps=5`）。
响应头带 `X-Preview-Mode: device-mjpeg | snapshot-poll`。

### `GET /api/devices/:id/stream`
响应：`{ "rtsp": "rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/101", "wsH264": "/api/devices/:id/h264?channel=101", "mjpeg": "/api/devices/:id/preview.mjpg?channel=101", "modes": ["mjpeg","snapshot"] }`
> `wt` 为 Node 内置 WebSocket；前端 `WebSocket("/api/devices/:id/h264")` 收到二进制 H.264 Annex-B 帧，用 `VideoDecoder`(WebCodecs) 解码上屏。

---

## 8. 升级

### `POST /api/devices/:id/upgrade`
请求：`{ "filePath": "D:\\fw\\IPC_R0.dav" }`（服务器本地路径，v1 不做 multipart）
响应：`{ "taskId": "..." }`，进度走 SSE：
```
{"type":"upgrade.progress","data":{"taskId":"u1","id":"...","percent":42,"status":"upgrading"}}
```

### `POST /api/batch-upgrade`
请求：`{ "deviceIds": [], "filePath": "...", "concurrency": 4 }` → `{ "taskId": "..." }`

---

## 9. 报表

### `POST /api/report`
请求：`{ "deviceIds": [], "format": "csv" | "xlsx", "include": ["probe","network","time","users","storage"] }`
响应：`{ "file": "reports/巡检_20250101_120000.xlsx", "url": "/reports/巡检_20250101_120000.xlsx", "rows": 12 }`
`GET /reports/<file>` 返回文件下载。

---

## 10. SSE

### `GET /api/events` （`text/event-stream`）
所有异步任务进度统一在此推送。前端 `new EventSource("/api/events")`。
每条消息形如：
```
data: {"type":"task.progress","data":{...}}
```
`type` 取值：`task.start` `task.progress` `task.done` `scan.result` `sadp.result` `upgrade.progress` `device.status`
（`sadp.result` 在 SADP 搜索过程中每发现一台设备推送一次，字段同 `POST /api/discover/sadp` 的 `found[]` 单项）

---

## 10.5 设备后台（离线配置包，等价于 HiToolsDelivery 的「内置浏览器」）

本机会额外监听一个端口（默认 **9099**），托管海康的离线 Web 配置包，并把包内发出的
设备请求反向代理回真实设备。因此**没有内置网页的摄像头也能打开 WEB 后台**。

### `GET /api/console/state`
```json
{
  "running": true,
  "port": 9099,
  "base": "http://127.0.0.1:9099/",
  "packageRoot": "C:\\Program Files\\HiToolsDelivery\\...\\WebConfigCtrl",
  "hasPackages": true
}
```
`running:false` 时带 `error`（例如启动时用了 `--no-console`，或机器上找不到离线配置包）。

### `GET /api/console/url?device=<ip:port>`
```json
{ "url": "http://127.0.0.1:9099/open?device=192.168.1.64%3A80", "base": "http://127.0.0.1:9099/" }
```
设备不在库中 → `404`。

### 后台服务自身的路由（不在主服务端口上）

| 路由 | 说明 |
|---|---|
| `GET /` 或 `/console` | 落地页：列出可打开的设备 + 已发现的离线配置包 |
| `GET /open?device=<ip:port>` | 引导页：下发 `ProxyHostInfo` / `SDKMode` 等 Cookie，加载 `ConfigKitSDK.js` 并调用 `ConfigKit.Init()` |
| `GET /WebConfigCtrl/*` | 离线配置包静态资源（`ConfigKitSDK.js`、`Packages/<sign>/webs_<ver>_isapi/...`） |
| `GET /DISPATCH_ip_<host>/<path>` | **反向代理**到 `http://<host>/<path>`，使用 hikctl 已保存的凭据自动鉴权 |
| `GET /ISAPI/*`、`/SDK/*`、`/FDLib`、`/help/`、`/LOCALS/`、`/SoftwareLicense.txt`、`/iot/` | 同上，目标设备取自 `ProxyHostInfo` Cookie |
| `GET /__state` | 诊断用 JSON（包目录、包数量、设备列表、端口） |

**与 HiToolsDelivery 的差异（都是改进）**：
- 不需要 nginx / Redis / 海康 SDK，代理就在主进程里
- 反向代理**自带鉴权**（session 或 Digest），浏览器不会弹认证框，HTTPS 设备也在本地终结
- 设备离线/不在库时返回可读错误页，而不是白屏

**启动参数**：
```
--console-port <端口>   后台服务端口（默认 9099，被占用自动 +1）
--packages <目录>       指定离线配置包目录（默认自动查找 HiToolsDelivery 的包）
--no-console            不启动后台服务
```

## 11. 静态资源

- `GET /` → `web/index.html`
- `GET /app.js` `GET /style.css` 等 → `web/` 目录下的静态文件
- 前端**不得**引入任何外部 CDN/框架；纯原生 ES2022 + CSS。
- 体积预算：`web/` 目录 **< 220 KB**（当前约 172 KB）。