# App 与中枢 · 开发/构建说明

> 面向"以后要改它"的人（主要是自己）。家人使用只要看 [app-usage.md](./app-usage.md)。

## 1. 三块东西

| 模块 | 位置 | 跑在哪 |
| --- | --- | --- |
| 数据层 CLI + 分析取数 | `checkin.mjs` | Windows |
| 局域网中枢 | `hub/hub.mjs` | Windows（双击 `tools\start-hub.cmd`） |
| 手机 App | `app/`（Capacitor 套壳） | Android |

三边共用一套记录结构：`memberId / date / version / goals[{id,text,status,checkedAt,note,createdAt,updatedAt,deleted}]`。
合并规则只有一份：`hub/merge.mjs`，用 `node tools/sync-assets.mjs` 复制成 `app/www/merge.js`（**别直接改 www 里那份**）。

App 现在叫「大内家事」，分两页：**朝廷**（内阁 / 御书房 / 奏疏）与**起居**（今日差事 / 行事历 / 钦天监推演），
底栏最右是「朕的私事」。图标取自 `assets/brand/app-icon.png`，经 `tools/app-identity.mjs` 体检后打进各密度 mipmap。

## 2. 目录

```
family-checkin/
  checkin.mjs                数据层 CLI（可被 import，main 有守卫）
  shared/
    id.mjs                   成员ID规则唯一真源（emoji 合法；三端共用）
  hub/
    hub.mjs                  HTTP + UDP 发现/广播 + 看板
    merge.mjs                合并规则（唯一真源）
    net.mjs                  网卡筛选 / 子网广播 / 热点识别（纯函数）
    pack.mjs                 复盘素材包（CLI 与中枢共用）
    test/                    merge / net 单测 + 端到端同步测试
  app/
    www/                     界面（无框架，原生 ESM）
      index.html app.css
      app.js                 界面逻辑
      core.js                纯逻辑（状态机 / 提醒排期 / 日历 / 保留期）
      db.js                  IndexedDB
      sync.js                发现 + 同步 + 调中枢 AI 复盘
      notify.js              本地通知（AlarmManager）
      merge.js               由 hub/merge.mjs 复制
      member-id.js           由 shared/id.mjs 复制
      court-state.js         国事合并规则（由 shared/court-state.mjs 复制）
      dispatch-rules.js      司礼监传旨规矩（由 shared/dispatch-rules.mjs 复制）
      ledger.js              记账解析（由 court/ledger.mjs 复制）
      depts.js               七部名号/职能/例句（由 court/personas.mjs 生成）
      icon.png               网页图标（由 assets/brand 缩出）
    test/                    core 单测 + jsdom 界面冒烟
    android/                 Capacitor 原生工程（含 LanDiscoveryPlugin）
  tools/
    build-apk.cmd            构建 APK
    start-hub.cmd            启中枢（双击；纯 ASCII，中文由 hub.mjs 打印）
    fix-firewall.cmd         一次性放行 TCP 8787 + UDP 8788（自动提权）
    fetch.mjs                下载器（绕开 schannel）
    fetch-sdk-packages.mjs   手动装 Android SDK 包
    sync-assets.mjs          同步 merge.mjs → www/merge.js
    seed-demo.mjs            造演示数据（默认写临时目录）
    analyze.mjs              单人复盘素材包
    sdk-setup/               换电脑重装 SDK 时才用（install-sdk*.cmd/.ps1）
  dist/大内家事-debug.apk      可直接发手机安装（应用名：大内家事）
  docs/
```

## 3. 环境（本机已配好，换机器照抄）

| 变量 | 值 | 为什么 |
| --- | --- | --- |
| `JAVA_HOME` | `C:\Program Files\Java\jdk-17.0.11` | 本机自带 |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | `K:\dshworkspace\android-sdk` | C 盘只剩 5GB |
| `ANDROID_USER_HOME` | `K:\dshworkspace\.android-home` | 默认 `~/.android` 不可写 |
| `GRADLE_USER_HOME` | `K:\dshworkspace\.gradle-home` | 同上 |

**不要同时设 `ANDROID_SDK_HOME` 和 `ANDROID_USER_HOME`**，AGP 8.2 会报
"Several environment variables contain different paths to the Android Preferences folder"。

SDK 内容：`platform-tools`、`platforms;android-34/35`、`build-tools;34.0.0/35.0.0`、`licenses/`。

## 4. 构建与测试

```bat
REM 1) 改完 www/ 必须先同步进原生工程
cd app && npx cap copy android

REM 2) 构建（内部已设好所有路径变量）
tools\build-apk.cmd

REM 产物
app\android\app\build\outputs\apk\debug\app-debug.apk
```

测试（都在本机跑，不需要手机）：

```bat
node app\test\core.test.mjs           REM 状态机 + 提醒排期 + 日历 + 保留期 + 文本导出（16 例）
node app\test\ui.smoke.test.mjs       REM jsdom 界面：两页 / 点圈进度 / 内阁 / 六部行 / 传旨（26 例）
node app\test\dashboard.dom.test.mjs  REM jsdom + 真中枢：看板点卡片切人、点天数出复盘（8 例）
node app\test\court-local.test.mjs    REM 国事本机逻辑：合并 / 墓碑 / 限调 3 次 / 多笔账（6 例）
node hub\test\merge.test.mjs          REM 合并规则（12 例）
node hub\test\net.test.mjs            REM 网卡筛选 / 子网广播 / 热点识别（5 例）
node hub\test\sync-e2e.test.mjs       REM 端到端同步 + 保留期 + CORS + 缓存 + 成员详情（28 例）
node hub\test\court-e2e.test.mjs      REM 大内家事：权限/缓存/批阅/传旨/国事同步/账簿（21 例）
node test\analyze.test.mjs            REM 复盘取数链路（6 例）
node test\id.test.mjs                 REM 成员ID规则 + 副本一致性（6 例）
node test\format.test.mjs             REM 手机/电脑导出格式一致（2 例）
node test\court.test.mjs              REM 账本解析 + 批阅状态机 + 人格 + 缓存（10 例）
node test\gym.test.mjs                REM 训练场评分（5 例）
node test\pricing.test.mjs            REM 中枢账房：峰谷价 / 缓存 0 元 / 汇总金额（6 例）
node test\dispatch.test.mjs           REM 司礼监传旨：三类事（内阁带预算 / 今日 / 六部）与模型 JSON 过筛（8 例）
```

共 165 例。

> 注意：`node --test` 会为每个文件 spawn 子进程，本机沙箱下会报 `spawn EPERM`，
> 所以直接 `node <文件>`（node:test 在进程内跑）。

## 5. 网络：三种家用接法都要能同步

目标场景（用户明确要求）：① 手机和电脑同一个 WiFi；② 电脑连手机热点；③ 手机连 WiFi、电脑插网线（同一路由器）。

三件事保证它成立：

1. **防火墙一次性放行（关键）**：Windows 把手机热点判为「公用网络」，公用配置下**入站默认全拦**，
   手机 TCP 连 8787 会直接超时。所以 `tools\fix-firewall.cmd` 用管理员权限加两条规则，
   `profile=any`（域/专用/公用都放行）：
   - `FamilyCheckinHub-TCP` → TCP 8787（同步 + 看板）
   - `FamilyCheckinHub-UDP` → UDP 8788（自动发现）
   `start-hub.cmd` 启动时会检查规则是否存在，缺了就自动调它（会弹一次 UAC）。
2. **只报真实网卡地址**：`hub/net.mjs` 的 `pickLanInterfaces()` 过滤
   `vEthernet / WSL / Hyper-V / VMware / VirtualBox / Bluetooth / Tailscale …` 这些虚拟网卡
   （本机就有个 `172.24.144.1` 的 WSL 网卡，报出来只会误导手机往错误地址连）。
3. **双向发现**：
   - 手机 → 中枢：广播 `FAMILY-CHECKIN/DISCOVER`，中枢定向回复。
   - 中枢 → 手机：**每 5 秒** 朝 `255.255.255.255` 和**每张网卡的子网广播地址**各发一次
     `FAMILY-CHECKIN/HERE {json}`，多网卡（网线 + WiFi）时不会只从默认路由那张卡出去。
   手机端 `LanDiscoveryPlugin` 现在会**绑在 8788 上一边发问一边听广播**，
   所以就算手机发出的广播被路由器/热点挡住，只要中枢在广播、手机在听，也能找到（`via: announce`）。

实测（本机当时正连在手机热点上，`WLAN 3 = 192.168.43.106`）：
- 中枢 announce 6 秒内被抓到 4 条，源地址 `192.168.43.106`；
- `http://192.168.43.106:8787/api/health` 从局域网地址访问返回 200（不只是 localhost）；
- 启动器 dry-run 输出只列出一张真网卡，并标注「← 手机热点网段」。

## 6. 这次踩过的坑（省得再踩）

1. **`curl` / PowerShell 走 schannel 全部 TLS 失败** → 一律用 `node tools/fetch.mjs` 下载。
2. **`sdkmanager` 也连不上 dl.google.com**（Java TLS）→ 改成读 `repository2-1.xml` 手动下 zip，见 `fetch-sdk-packages.mjs`。
3. **Gradle 原生文件监视在本机抛 `Couldn't open current thread, error = 5`** → `gradle.properties` 里 `org.gradle.vfs.watch=false` + `org.gradle.daemon=false`。
4. **`services.gradle.org` 不可达** → wrapper 的 `distributionUrl` 改成腾讯镜像；AGP 依赖走阿里云 `maven.aliyun.com`。
5. **`Expand-Archive` 解 60MB 的 SDK 包要 30 分钟**，`.NET ZipFile::ExtractToDirectory` 只要 19 秒。
6. **Capacitor 6 的 WebView 只认 `.js`**，`.mjs` 会因 MIME 被拒 → www 下全用 `.js` + `<script type="module">`。
7. **LAN 同步必须允许明文 HTTP**：`AndroidManifest.xml` 里 `android:usesCleartextTraffic="true"`。
8. **时区**：手机/电脑/测试混着 UTC 与 +08:00 会让"晚者胜"和展示都错 → 中枢入库统一 `toBjIso()`。
9. **`.cmd` 里绝不能写中文**（真实踩到）：cmd.exe 按 OEM 代码页（本机 GBK）解析批处理，
   UTF-8 中文字节里可能出现 `0x5C`（就是反斜杠），会把行尾续成下一行，于是整份脚本崩成
   `'...\hub"' is not recognized` 之类的乱码命令。所以 `start-hub.cmd` / `build-apk.cmd` 一律纯 ASCII，
   中文提示交给 Node（`hub.mjs`）在 `chcp 65001` 之后打印。
10. **`.cmd` 的 `echo` 里不能有裸 `>`**（也真实踩到）：`echo app -> Settings` 里的 `>` 会被当成重定向，
    结果凭空生成一个名为 `Test` 的文件。要么写成 `^>`，要么干脆别用箭头。
11. **`timeout /t N` 在输出被重定向时会报 `Input redirection is not supported`** →
    改用 `ping -n N+1 127.0.0.1 >nul` 做等待。
12. **底部 tab 被内容顶出屏幕**：`body` 是 flex 列，但 `#app` 不是 → `main` 的 `flex:1` 不生效。
    修法：`#app { display:flex; flex-direction:column; height:100dvh; min-height:0 }` + `body{overflow:hidden}`，
    并且这条约束有测试守着（`ui.smoke` 里"布局"那例）。
13. **PowerShell 5.1 改文件会把 UTF-8 中文写成乱码**：`Get-Content -Raw` 在 GBK 代码页下解码 UTF-8，
    再 `WriteAllText(..., UTF8)` 写回，等于二次编码，文档直接变 "涓夊潡涓滆タ"。
    **中文文件一律用 edit/write 工具改**；确需脚本处理时显式 `Get-Content -Encoding UTF8`
    并用 `[IO.File]::ReadAllText/WriteAllText(..., UTF8)` 成对使用。
14. **手机 App 里 "自动找中枢成功，但测试连接/同步 Failed to fetch"**（真实踩到）：
    发现走原生 UDP，能成功；但 HTTP 是**跨源请求**——WebView 的页面来源是 `https://localhost`，
    中枢是 `http://192.168.x.x:8787`，中枢没回 `Access-Control-Allow-Origin`，浏览器直接把响应拦掉，
    前端只能看到 `TypeError: Failed to fetch`。修法：所有 JSON 响应带
    `Access-Control-Allow-Origin: *`，并对 `OPTIONS` 预检回 204 + `Allow-Methods/Allow-Headers`。
    （`POST` 带 `Content-Type: application/json` 一定会先发预检，所以 OPTIONS 必须处理。）
15. **AI 复盘的 key 从哪来**（已实现三级回退）：`DEEPSEEK_API_KEY` 环境变量 →
    `data/settings.json` 的 `deepseek.apiKey` → `~/.dsh/.credentials.yaml` 里的 `refs.DEEPSEEK_API_KEY`
    （这台机器上 dsh 自己就在用）。`HUB_DEEPSEEK=off` 可整体关掉（测试里就这么用）。
    模型默认 `deepseek-chat`，可用 `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` 覆盖。
16. **成员ID把 emoji 当成非法字符**（真实踩到，用户成员「瑞瑞🥚」同步失败）：
    旧规则是 `/^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,32}$/`，emoji、空格、其他文字全被拒，
    但 App 端只校验"非空 + 长度"，于是手机能存下 ID、中枢却 400「非法成员ID」。
    修法：规则收口到 **`shared/id.mjs`**（`memberIdProblem` / `normalizeMemberId`），
    三处共用（checkin.mjs、hub.mjs、App 的 `www/member-id.js` 由 `tools/sync-assets.mjs` 复制）；
    只拦真正危险的：`/ \ : * ? " < > |`、控制字符、结尾点/空格、Windows 保留名、>32 码点。
    hub 的所有路径都走 `memberDir()` 校验，`handleSync` 先校验再 `upsertMember`，
    坏 ID 不会污染 members.json、也不会建出坏目录。
17. **主数据校验要在"写之前"**：`handleSync` 原来是先 `upsertMember()` 再拼路径，
    校验失败时成员已经被登记进 members.json（假成功）。现在先校验、再落任何东西。
18. **`\w` 正则挡住中文 id**（真实踩到）：复盘文件 id 是 `时间戳-成员名`（如 `1794…-小满`），
    用 `/^[\w-]+$/` 校验会把中文名判为非法，`/api/analysis?id=` 直接 400。
    改成只挡目录穿越（`/`、`\`、`..`、超长），中文/emoji 一律放行。
19. **每 5 秒刷新会把正在看的结果刷掉**：复盘结果区必须独立于"成员面板"重新渲染
    （看板里 `#analysisOut` 单独存在，刷新只重绘 `#memberBody`，并用 JS 变量记住上次结果）。

## 7. 中枢接口一览（v3）

| 接口 | 作用 |
| --- | --- |
| `GET /` | 看板（卡片选人 → 只显示该成员；同步动态 / 备份 / AI 复盘都在成员面板里），每 5 秒自刷 |
| `GET /api/health` | 服务信息 + 保留期 + `analysis` 是否可用、模型、可选天数 |
| `POST /api/sync` | 手机同步；body 带 `mode: 'auto' \| 'manual'`，服务端登记设备 IP 与在线状态 |
| `GET /api/status` | 看板主数据：成员今日进度、`devices`、`syncs`、`analyses`（摘要） |
| `GET /api/member?memberId=` | 单个成员详情：今日目标逐条、该成员同步记录、备份体积、分析历史 |
| `GET /api/records?memberId&from&to` | 原始记录 |
| `GET /api/summary?date=` | 某天各成员进度 |
| `GET /api/backup` | 数据目录、各成员天数/体积/最新日期 |
| `GET /api/backup/download?memberId=&date=` | 导出 JSON（含状态与备注） |
| `GET /api/backup/text?memberId=` | 导出 TXT：`2026年11月18日：事项1；事项2。` 一天一行 |
| `POST /api/open-folder` | 在**电脑本机**弹出数据 / 复盘文件夹（远程调用返回 403） |
| `POST /api/analyze` | `{memberId, days, force?}` → 组素材包 → 命中缓存直接返回（`cached:true`）→ 否则调 DeepSeek 并存盘 |
| `GET /api/analyses?memberId&limit` | 历史复盘**摘要**列表（按"每个成员+天数最多 3 条"筛） |
| `GET /api/analysis?id=` | 取某份复盘全文（列表不带正文，省流量） |
| `GET /api/usage` | 中枢账房：今日/今月调用、tokens、**折合金额（按 DeepSeek 价目估算）**、最近明细（每条带 `cost`）、余额、价目表 |
| `GET/POST /api/avatar` | 头像：dataURL 存取（≤400KB，png/jpeg/webp） |
| `GET /api/annual` | 内阁（年度计划）列表，含金额预算 |
| `POST /api/annual` `/update` `/delete` | 增 / 改 / 删；只有帝后能改；改措辞 / 周期 / 预算才算一次调整，每桩每年 3 次 |
| `POST /api/court/dispatch` | 司礼监传旨：`{text}` → 拆成三类（annual 内阁带预算 / goal 今日差事 / task 六部差事），只出清单不落任务；同一段话有指纹缓存；断网/无模型时按 `shared/dispatch-rules.mjs` 关键词规矩拆 |
| `GET /api/court/state?memberId=` | 国事全量（内阁 / 七部差事 / 户部流水 / 删除墓碑）；App 开机先把本机那份显示出来 |
| `POST /api/court/state` | 把手机记的整份国事推上来：按 `updatedAt` 合并、墓碑挡旧稿、流水按 id 去重；家人推大事返回 `rejected` 并退回中枢那份 |
| `GET/POST/PATCH /api/court/*` | 七部召见、批阅、回奏、朝会、一句话记账、各部台账 |
| `GET /api/court/tasks?dept=` · `POST /api/court/tasks` | 该部御赐差事（帝后下旨） |
| `POST /api/court/task/update` · `/task/delete` | 改进度 / 撤旨 |
| `GET /api/court/overview` | 看板用：七部任务、职能说明、奏疏、内阁、用量 |

> 进度模型：每条 goal/task/annual 都带 `progress 0~100`（annual 另带 `budget` 预算金额），`status` 由进度派生（`done` = 100，`doing` = 1~99，`pending` = 0，`failed` 为显式标记）；
> 手机上不再常驻滑块，改成每条前面一个写百分比的圆圈，点圈才弹滑块。统计口径一律取平均进度，月历色块也按平均进度分档。
>
> 离线优先：App 的国事存在本机 IndexedDB（`courtState`），中枢只是另一份；所有改动先记本机，
> 连上中枢再整份 POST `/api/court/state` 合并（`shared/court-state.mjs` 两端共用一套合并规则）。
> 七部名号与职能由 `tools/sync-assets.mjs` 从 `court/personas.mjs` 生成到 `app/www/depts.js`，断网也说得清每部管什么。
>
> 账房金额：`court/pricing.mjs` 按 DeepSeek 价目折算（默认输入命中 ¥0.043/百万、未命中 ¥2.16/百万、输出 ¥8.64/百万，
> 峰时价；闲时自动对折）。可用 `HUB_PRICE_INPUT_HIT` / `HUB_PRICE_INPUT_MISS` / `HUB_PRICE_OUTPUT` 覆盖。
> 每笔流水落盘时带 `cost`；老流水只有 tokens 的按七三粗算并标 `costEstimated`；缓存命中与假模型记 0。
> 官方价目会变，界面一律标「估算」，余额仍以 DeepSeek 账户扣费为准。
>
> 司礼监：`shared/dispatch-rules.mjs` 是断网/无模型时的关键词分派规矩（礼部管活动吃喝、兵部管出行时间、户部管花费、
> 工部管物件、吏部管分工、刑部管家规），App 与中枢共用；中枢有模型时优先让模型拆，拆不出再回退到规矩。

`/api/status`、同步日志都会写 `mode` 字段，所以看板能区分"自动同步"和"我手动点的"。

### 复盘缓存（省 token 的关键）

- 指纹 = `sha1(memberId + from + to + 每天的 goals 明细)`，只跟"这段时间的打卡内容"有关。
- 命中（成员 + 天数 + 指纹都相同）→ 直接返回上次结果，标 `cached: true`，**不调用模型**。
- 数据有任何变化（改目标、改备注、补打卡）→ 指纹变化，自动重新生成。
- 想强行重算：请求里带 `force: true`（手机结果页的「重新生成」、看板缓存结果旁的按钮）。
- 存储：`data/analyses/<id>.json`，每个 (成员, 天数) 最多留 10 份，列表只展示最新 3 份。
- 测试用 `HUB_DEEPSEEK_FAKE=1` 走假模型（不打 API、不花钱），e2e 里就是这么验证缓存的。

## 8. 历史与保留（1 年上限）

- App：日历按月显示，`‹ ›` 翻页，最多回到「当前月往前 11 个月」；「我的 → 历史保留」可选 3 / 6 / 12 个月。
  改小后会在本地删掉超期记录（`core.pruneRecords`，有单测）。
- 中枢：同步时按同样上限清理旧文件（`HUB_RETENTION_MONTHS`，默认 12，最长一年），
  超期数据既不落盘也不回传；健康检查里会显示 `retention.cutoff`。
- 同步窗口 `SYNC_DAYS = 400`，并且同步结果会和本机已有记录再合并一次，
  避免"超过 60 天的本地记录同步完就看不见"。

## 9. 大内家事（court 模块）

```
court/
  personas.mjs   七部人格：身份/权责/禁则/可读数据/奏疏格式（改 prompt 就从这里）
  context.mjs    各部数据摘要（只给该领域的数据，做到"记忆隔离"）
  store.mjs      奏疏/批示/圣旨懿旨/记忆/台账/预算 + 批阅状态机
  agents.mjs     summon（指纹缓存）/ dispose / reply / meeting
  ledger.mjs     一句话记账解析与汇总
  gym.mjs        训练场评分（5 条标准 + 领域词）
tools/court-train.mjs   教练闭环：跑用例 → 打分 → 记 history.json
```

关键约定：

- **权限**：`data/court/roles.json` 记 `memberId → emperor|empress|member`；
  `summon` 与 `dispose` 都在服务端校验，家人一律 403（前端禁用只是提示）。
- **不擅自执行**：六部只写奏疏，不写打卡/预算/排班；方案生效 = 帝后 `approve` 那条。
- **驳回即记忆**：`reject` 必须带批注，批注写进 `data/court/memory/<部>.json`，下次上奏会带上，
  所以"被驳回过的坑"不会重复踩。
- **缓存**：`summon` 的指纹 = `sha1(deptId + 数据摘要 + 口谕)`；数据没变就返回旧奏疏（`cached:true`），不调模型。
- **朝会**：`meeting` 用各部摘要拼简报，不调模型（免费）。
- **训练**：`court/gym.mjs` 的评分是规则化的（不花钱）；`tools/court-train.mjs --dept <部> --rounds N`
  默认起一个假模型中枢跑分，`--url` 可指向真实中枢（那时才会花 token）。

中枢接口：`/api/court/{config,roles,role,summon,dispose,reply,memorials,memorial,meeting,ledger,budget,items,item}`。

## 10. 还没做的（有意留白）

- 家庭互看开关（中枢看板已能显示所有人，App 端还没有权限分层）
- 到家自动后台同步（现在依赖"打开 App 时同步"；原生 WorkManager 待加）
- 应用的正式签名（现在是 debug 签名，够自用，不适合分发）
- 六部数据录入的专门 UI（礼/兵/刑/工目前用通用"记一笔"接口，App 里还没做入口）
- 跨部抄送（文档里的"抄送相关部门"还没实现）
