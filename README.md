# 大内家事 · 家庭小目标与家国角色扮演

给一家人用的本地小目标打卡 + 御书房角色扮演：手机 App 记录每日差事、内阁年度计划与预算、六部差事，
家里的 Windows 电脑跑中枢做局域网同步、看板与 DeepSeek 复盘；数据只在家里，不靠第三方推送或云服务。

- 时间基准：**北京时间（Asia/Shanghai）**，按自然日一份目标清单。
- 数据隔离：每人一台手机各存各的，中枢按成员分开落盘；`data/` 里是家人的真实记录，**不要提交到仓库**。
- 只存不猜：CLI 不会替你生成目标、不会自动打卡，所有变更来自明确指令。

## 三部分怎么分工

| 部分 | 文件 | 干什么 | 文档 |
| --- | --- | --- | --- |
| 数据层 | `checkin.mjs` | 存目标/打卡、查询、分析取数、提醒候选筛选 | 本文件 |
| 家里中枢 | `hub/hub.mjs`（双击 `tools\start-hub.cmd`） | 局域网同步 + 看板（谁在线 / 手动或自动同步 / 本地备份 / AI 复盘）+ UDP 自动发现（同一 WiFi、电脑连手机热点、手机 WiFi+电脑网线都支持） | [app-build.md](./docs/app-build.md) |
| 手机 App | `dist/大内家事-debug.apk` | 两页：**朝廷**（内阁 / 御书房 / 奏疏）与**起居**（今日差事 / 行事历 / 钦天监）；另有中枢账房、头像、朕的私事 | [app-usage.md](./docs/app-usage.md) |
| 御书房 / 司礼监 | `court/` + `shared/` | 七部人格与领域隔离、奏疏缓存、批阅状态机、内阁预算、司礼监传旨（一句话拆成内阁/今日/六部）、账房计价 | [jia-shi-xiao-guo-plan.md](./docs/jia-shi-xiao-guo-plan.md) |
| 复盘分析 | `tools/analyze.mjs` + `hub/pack.mjs` | 单人"复盘素材包"（3~365 天，≥14 天自动给前后半程对比），供 CLI 或中枢调 DeepSeek 使用 | [analysis-playbook.md](./docs/analysis-playbook.md) |

提醒**不再依赖推送服务**：手机本地闹钟自己响，电脑没开、没网也照常；中枢只负责收数据与汇总。

## 一句话上手

1. 电脑双击 `tools\start-hub.cmd`（首次允许防火墙）→ 看板 `http://127.0.0.1:8787/`
2. 手机装 `dist\大内家事-debug.apk` → 起个称呼 → 最右「朕的私事 → 自动找中枢」
3. 回家连同一网络自动同步；想复盘就在「起居 → 钦天监推演」，或直接在看板点天数

## 从源码构建

```bat
cd app
npm install
npx cap sync android
cd ..
tools\build-apk.cmd
```

构建环境（JDK / Android SDK / 镜像 / 常见坑）见 [app-build.md](./docs/app-build.md)。APK 产物在
`app\android\app\build\outputs\apk\debug\app-debug.apk`，自行改名或复制到 `dist\`。

## 上传到 GitHub

仓库只收源码与文档：`data/`（家人真实记录）、`node_modules/`、Android 构建产物、`dist/*.apk` 都已在
`.gitignore` 里排除。目标仓库：<https://github.com/GGG0Boncl/danei-jiashi>。

首次上传：

1. 在 GitHub 新建一个**空仓库** `danei-jiashi`（不要勾 README / .gitignore / license）。
2. 双击 `tools\push-to-github.cmd`（默认推到 `https://github.com/GGG0Boncl/danei-jiashi.git`，
   要换地址就把仓库地址当参数传进去）。
3. 之后改了代码，重复第 2 步即可；脚本会 `git add`、commit、push 到 `main`。

脚本只在你的电脑上跑 `git push`，走的是你本机浏览器/凭据里已登录的 GitHub 账号；
如果 GitHub 要密码，请用 Personal Access Token 当密码。中枢与 App 不会把任何数据传出去。

## 复盘分析（dsh 接入）

```bat
node tools\analyze.mjs <成员ID> --days 7      REM 短期
node tools\analyze.mjs <成员ID> --days 30     REM 中长期（≥14 天会自动给前后半程对比）
node tools\analyze.mjs <成员ID> --days 14 --json > pack.json
```

素材包已经把"为什么"挑出来了：轻量日 vs 重量日的完成率差、反复卡住的目标（含近似说法合并）、
22 点后的迟到打卡、按星期的低谷、没提交的空洞、以及**打卡备注原话**。
写报告的要求固定为三段：①现状复盘 ②识别到的问题 ③温和可落地的小调整，**一次只写一个人**。
完整示例见 [analysis-demo.md](./docs/analysis-demo.md)（演示数据，别当真人结论）。

---

## 1. 目录与字段

```
family-checkin/
  checkin.mjs                 数据层 CLI（唯一入口）
  data/
    members.json              成员表
    records/<成员ID>/<YYYY-MM-DD>.json   每人每日目标与打卡
    outbox/<日期>-<0730|2130>/          无推送通道时的待发提醒
```

`members.json`（数组）

| 字段 | 说明 |
| --- | --- |
| `id` | 成员ID，中英文/数字/下划线/连字符，1–32 字 |
| `name` | 昵称，提醒与报告里显示 |
| `active` | 是否启用（`member off` 停用后不再被提醒，历史保留） |
| `shareToFamily` | 家庭互看开关，默认 `false` |
| `feishuChatId` | （可选）该成员的**个人**推送 chat_id，用于按人单发 |

每日记录 `<YYYY-MM-DD>.json`

| 字段 | 说明 |
| --- | --- |
| `memberId` / `memberName` / `date` | 归属与自然日 |
| `version` | 每改一次 +1，最新版本即当日有效清单 |
| `submittedAt` / `updatedAt` | 当天首次提交时间、最后一次修改时间 |
| `goals[]` | 目标列表，见下 |

`goals[]` 每条

| 字段 | 说明 |
| --- | --- |
| `id` | `g1`、`g2`…，当日唯一，删除不回收 |
| `text` | 目标内容 |
| `status` | `pending` 未打卡（初始态）/ `done` 完成 / `failed` 未完成 |
| `checkedAt` | 打卡时间（北京时间 ISO），`pending` 为 `null` |
| `note` | 打卡备注，可为空 |

> 「未打卡」和「未完成」是两件事：前者还没表态，后者是成员主动标记没做到。分析时分开统计，
> 21:30 提醒只针对 `pending`。

---

## 2. 常用命令

```bash
# 成员
node checkin.mjs member add alice --name "妈妈"
node checkin.mjs member set alice --chat oc_xxx        # 配个人推送通道
node checkin.mjs member off alice                      # 停用，历史保留
node checkin.mjs member list

# 提交当日目标（中文较多时用 --file 传 UTF-8 JSON 最稳）
node checkin.mjs submit alice --file goals.json
node checkin.mjs submit alice "背30个单词" "跑步3公里" "写周报"
node checkin.mjs submit alice --replace --file goals.json   # 整体替换

# 增删改（以最新版本为准）
node checkin.mjs edit alice --add "喝水8杯"
node checkin.mjs edit alice --remove 2
node checkin.mjs edit alice --rename "3||写完周报初稿"

# 打卡（序号 / g 编号 / 完整目标文本都可以定位）
node checkin.mjs check alice --goal 1 --done --note "早上效率高"
node checkin.mjs check alice --goal 3 --fail --note "加班太晚"
node checkin.mjs check alice --goal 3 --pending            # 撤回成未打卡
node checkin.mjs note alice --goal 2 --note "膝盖疼，改散步"

# 查询 / 报告 / 今日概览
node checkin.mjs query alice
node checkin.mjs query alice --date 2026-11-17
node checkin.mjs query alice --from 2026-11-01 --to 2026-11-18 --json
node checkin.mjs report alice --days 7
node checkin.mjs report alice --days 30 --json --with-records
node checkin.mjs status
```

`goals.json` 形如：

```json
[{ "text": "背30个单词" }, { "text": "跑步3公里" }]
```

其它辅助：`node checkin.mjs today`（北京今天日期）、`now`（当前北京时间）、`help`。

---

## 3. 两个定时提醒怎么接

调度不由本 CLI 计时，由**外部调度器**到点调用（cron / Windows 计划任务 / 宿主调度器都行）：

```bash
# 每日 07:30 —— 只挑「今天还没提交目标」的人
node checkin.mjs remind 0730 --json

# 每日 21:30 —— 只挑「今天提交过、但还有未打卡」的人
node checkin.mjs remind 2130 --json

# 加 --send 尝试按人单发（需要 members.json 里配了个人 chat_id）
node checkin.mjs remind 2130 --send
```

规则已固化在 `remindCandidates()` 里：

- **07:30**：当天没记录 / 记录为空 → 提醒；已提交 → 不提醒。
- **21:30**：当天没提交的人 → **完全不提醒**；提交过且存在 `pending` → 提醒并列出待打卡项。
- 按人逐条输出，一人一条，不生成群发文案。21:30 只是通知，打卡入口不关闭。

`--json` 输出形如 `{ kind, date, count, targets: [{ memberId, name, chatId, reason, text, pending }] }`，
由 Agent 在自己的回合里把每一位的 `text` 单独发给他/她。
`--send` 无法送达（没有 chat_id 或接口失败）时，提醒会落到 `data/outbox/` 并打印路径，不静默丢失。

---

## 4. 分析口径

`report` 只给**事实 + 简单完成率**，定性结论由 Agent 写；一次只取一个人的数据。

- 短期：`--days 3` / `--days 7`
- 中长期：`--days 30` / `--days 90`，或 `--from`/`--to` 圈一个季度
- 给出的信号：
  - 提交稳定性：`submittedDays / daysInRange`、`missingDates`、`longestStreak`、`currentStreakBackwards`
  - 完成情况：`completionRate`，并区分 `done` / `failed` / `pending`
  - 节奏问题：`goalsPerDay`、`heavyDays`（≥5 条的日子完成率）、`lightDays`（≤3 条的日子完成率）
  - 高频完不成：`repeatStuck`（重复出现 ≥2 次且完成率 <50% 的目标）
  - 时间规律：`weekday`（按星期几的完成率）、`lateNightChecks`（22:00 后打卡次数）

`--json` 给全量数字，`--with-records` 再附带区间内原始记录（含备注），便于写复盘时引用原话。

---

## 5. 环境与测试

- Node 22+（本机 v22.22.0 已验证）。
- `CHECKIN_DATA_DIR` 可把数据目录指向别处，方便演练 / 备份 / 迁移：

```bash
CHECKIN_DATA_DIR=D:/checkin-data node checkin.mjs member list
```

演练时**不要**往正式 `data/` 里写假成员和假打卡——报告会把它当真。
