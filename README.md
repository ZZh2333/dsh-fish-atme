# dsh-fish-atme

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）用的插件：**盯着 B 站「@我的」，只回你本人。**
> 每 N 分钟查一次 @ 列表，命中白名单里的人就让模型写一句回复，直接发在评论下面。
> 参数全部可改（设置页 / 配置文件 / 模型工具三条路），自带三道安全闸。

- 类型：DSH bundle（宿主半端 `index.js` + 浏览器半端 `client.js`）
- 语言：纯 JavaScript（ESM，无构建步骤）
- 许可证：MIT
- 版本：0.2.0

---

## 目录

- [它做什么](#它做什么)
- [依赖](#依赖)
- [给 AI 的安装清单](#给-ai-的安装清单)
- [安装（三种方式）](#安装三种方式)
- [首次配置](#首次配置)
- [配置参数](#配置参数)
- [模型工具（3 个）](#模型工具3-个)
- [设置页 HTTP 接口](#设置页-http-接口)
- [安全设计](#安全设计)
- [数据与隐私](#数据与隐私)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 它做什么

```
 每 5 分钟（可配）
      │
      ▼
 GET /x/msgfeed/at  ──►  过滤：是白名单里的人？这条 rpid 回过没？今天额度用完没？离上一条够 10 分钟没？
      │                                    │
      │ 没有要回的                          │ 有
      ▼                                    ▼
   写一行日志                    GET /x/web-interface/view（拿标题/UP）
                                             │
                                             ▼
                                  模型写一句回复（provider/model 可配）
                                             │
                            dryRun=true ─────┴─────► 只把草稿写进日志
                                             │
                                             ▼
                                POST /x/v2/reply/add（以你的账号发出去）
```

两部分：

| 半端 | 文件 | 干什么 |
|---|---|---|
| 宿主 | `index.js` | 定时器、B 站接口、模型调用、去重与额度、3 个模型工具、`/api/fish-atme` 接口 |
| 浏览器 | `client.js` | 在 **设置 →「B站 @我」** 里画一页表单（改参数、看额度、看日志、试草稿） |

---

## 依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH | `>= 0.2`（桌面版或 Web 版均可） | 插件跑在 DSH 的 Cordis 容器里 |
| Node.js | `>= 20`（推荐 22/24） | 用的是内置 `fetch`、`node:` 前缀、ESM 顶层 await |
| 宿主服务 | `tools`、`llm`、`webServer` | `export const inject` 里声明，缺一个插件不激活 |
| `@deepseek-ai/schemastery` | **可选** | 有它才有 `Config`（参数才出现在设置页）；拿不到时插件照常跑，只是设置页不显示参数 |
| 一个 LLM provider | 任意已装好的路由 | 默认 `ark-code-latest`；写回复时用 `provider` / `model` 两个参数选 |
| B 站账号凭证 | 必需 | 见[首次配置](#首次配置) |

> 插件**不**内置任何 API Key、cookie、UID。凭证读你本机的文件，模型走宿主已配置的 provider。

---

## 给 AI 的安装清单

> 这一段是写给"要替用户装这个插件"的 AI 的。按顺序做，每步都有校验。

1. **确认真的是 DSH 环境**：存在 `~/.dsh/profiles/<profile>/package.json`（Windows 是 `%USERPROFILE%\.dsh\profiles\...`）。
2. **把插件放到一个稳定目录**，例如 `~/.dsh/plugins/dsh-fish-atme`（不要放在会被清理的临时目录）。
3. **注册成 bundle**（任选其一）：
   - 有 DSH 的插件管理工具：`install_bundle` 目标填该目录的绝对路径；
   - 命令行：`dsh plugin --profile <profile> add link:<绝对路径>`；
   - 手工兜底：见[安装（三种方式）](#安装三种方式) 的方式 C。
4. **校验宿主半端已激活**：插件会在数据目录写日志
   `~/.dsh/fish-atme/fish-atme.log`，里面应出现
   `定时器已启动：每 5 分钟查一次 · 每天上限 3 条 · 间隔 ≥10 分钟 · …`。
   没有这行 ⇒ 看 DSH 的插件页该条目是否 `enabled`、是否 `active`，以及是否报 `failed to import`。
5. **校验工具已注册**：让模型侧列一次工具，应能看到 `bili_at_me`、`bili_at_me_draft`、`bili_at_me_status`。
6. **提示用户重启一次 DSH**：浏览器半端（设置页那一栏）只在 DSH **启动时**扫描 `dsh.client`，新装插件不重启看不到「B站 @我」。
7. **首次使用务必先开 `dryRun: true` 跑一轮**，确认语气无误后再关。
8. **不要**替用户填 `allowUids` 之外的身份信息，也**不要**把凭证写进仓库或配置。

---

## 安装（三种方式）

### 方式 A：插件管理界面（最简单）

1. 把本目录放到任意稳定路径，例如 `~/.dsh/plugins/dsh-fish-atme`。
2. DSH 里打开 **插件 → 右上「+ 添加插件」**，选择本地目录并指向它。
3. 插件页出现 `dsh-fish-atme`，开关为开、状态「运行中」。
4. **重启一次 DSH**，设置里才会多出「B站 @我」这一栏。

### 方式 B：命令行

```bash
# 本地目录（开发/私有部署最常用）
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-fish-atme
# 发布到 npm 之后也可以
dsh plugin --profile <profile> add dsh-fish-atme
```

`<profile>` 是你要装的档案名（桌面版通常是 `desktop`，可用 `dsh profile list` 看）。
如果你的 DSH 版本没有 `dsh plugin` 子命令，用方式 A 或方式 C。

### 方式 C：手工挂载（没有任何工具时的兜底）

1. 把包放进 profile 的依赖里（`~/.dsh/profiles/<profile>/package.json`）：

   ```json
   {
     "dependencies": { "dsh-fish-atme": "link:/absolute/path/to/dsh-fish-atme" },
     "dsh": { "profile": { "bundles": ["...", "dsh-fish-atme"] } }
   }
   ```

2. 在 profile 里装一次依赖（pnpm；注意 store 版本要和 DSH 内置的一致）：

   ```bash
   cd ~/.dsh/profiles/<profile> && pnpm install
   ```

3. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: fish-atme
         name: dsh-fish-atme
         config: {}
   ```

   > `id` 必须等于 `index.js` 里的 `export const name`（`fish-atme`），否则设置页认不出参数。

4. 重启 DSH。

### 装完自检

| 检查 | 期望 |
|---|---|
| 插件页 | `dsh-fish-atme` 存在、开着、运行中 |
| 日志文件 | `~/.dsh/fish-atme/fish-atme.log` 里有「定时器已启动」 |
| 工具 | 有 `bili_at_me` / `bili_at_me_draft` / `bili_at_me_status` |
| 设置页 | 重启后有「B站 @我」一栏 |
| 冒烟 | 调一次 `bili_at_me`（只读），能返回「@我的」列表或空列表 |

---

## 首次配置

### 1. B 站凭证

插件需要一个**已登录**的 B 站账号的 cookie。默认读：

```
<数据目录>/bili_credential.json      # 默认 ~/.dsh/fish-atme/bili_credential.json
```

文件格式（字段名大小写都认，只要有 `sessdata`）：

```json
{
  "sessdata": "从浏览器 cookie 里抄的 SESSDATA",
  "bili_jct": "bili_jct（发评论要用，缺了发不出去）",
  "dedeuserid": "你的 UID（用来判断"回谁"）",
  "buvid3": "可选"
}
```

> 也可以用参数 `credentialPath` 指向别处，例如与别的 B 站插件共用同一份凭证。

### 2. 数据目录

默认 `~/.dsh/fish-atme/`（可用 `home` 参数或环境变量 `FISH_ATME_HOME` 改），里面会有：

| 文件 | 内容 |
|---|---|
| `bili_credential.json` | 凭证（你自己放） |
| `fish-atme-config.json` | 设置页存下来的参数（只有改过的字段） |
| `fish-atme-state.json` | 去重表（按 rpid）+ 当天额度 + 上次发送时间 |
| `fish-atme.log` | 每次查询 / 每次发送 / 每次出错一行 |

### 3. 先开 dryRun 跑一轮

`dryRun: true` → 只把「本会回什么」写进日志，不发。确认语气没问题再关掉。

---

## 人格与记忆

回复的 system prompt 由两件事决定：**底稿**（人格从哪来）+ **记忆**（要不要带旧事）。

### 人格：底稿从哪来

| `personaSource` | 底稿 | 说明 |
|---|---|---|
| `agent-md`（默认） | `<DSH_HOME>/AGENT.md` | 按 mtime 重读，改文件下一跳就生效；文件不存在/为空 → 自动回落 `builtin` |
| `builtin` | 源码里的「小肥鱼」 | 简洁、先给结论、不客套 |

- 尾部 `> 由 dsh-memory-vector 自动维护……` 那段托管快照会被**切掉**：它是给人看的、会变，塞进 system 只烧 token。
- `personaMode`：`append` = 底稿 + `personaPrompt`；`replace` = `personaPrompt` **整份替换**底稿（`replace` 且 `personaPrompt` 为空 → 回落底稿，不会变成空 prompt）。
- 读 AGENT.md 是**只读**，插件不会写它、也不会改你的人格设定。

### 场景规则：跟人格解耦，永远压在最后

persona 只管「像谁在说」，**怎么说**是另一件事。所以 system 的最后永远贴着这几条
（`keepReplyRules: false` 才关）：

```
[这条回复的场景规则，优先于上面的一切风格描述]
- 在 B 站评论区回一条，一句话到两句话，60 字以内。
- 只输出回复正文：不要小标题、不要列表、不要加粗、不要引号、不要 @ 前缀。
- 不要提到设置项、插件、模型、记忆、判重、额度这些内部东西。
- 不要自称「主人」「本鱼」「人家」，也不要用「您」。
```

> **为什么单列一段**：`AGENT.md` 里除了人格还有一大堆「行事偏好」（插件安全审查、生图规则、
> 先给结论再给理由……）。这些在 B 站评论区是噪音，会把一句「同感哈哈」写成带小标题的分析报告。
> 2026-11-05 就踩过：`personaSource: agent-md` 把底稿整份换掉、场景规则跟着一起丢了，
> 于是评论变成了长篇报告。现在两者分开：人格归人格，场景规则永远在。

### 记忆：接 dsh-memory-vector

`memoryEnabled: true` 之后，每轮回复前拿「他的评论 + 视频标题」当查询词，打本机的：

```
POST <本机 origin>/api/memory-vector/search    { query, k, scope }
```

拿回 `hits[]`，按 `memoryMinScore` 过滤 → `memoryTopK` 限条数 → `memoryMaxChars` 限字数，
拼成几行塞进 user prompt，并明确写「可能有噪音，只用来接话，别复述」。

- 插件没装 / 接口 404 / 连接被拒 —— **一律当没有记忆**，回复照发；日志最多每小时记一行，不刷屏。
- 压缩摘要块（`<compacted-summary>`）、「【记忆·自动回想】」旁注、`你：`/`我：` 前缀都会被丢掉，不进 prompt。
- 检索**要花向量化 token**（查一次 embed 一次），所以默认关；条数别贪，3 条够用。
- **`memoryMinScore` 建议 0.4–0.5**：记忆库内容少（只有几场旧会话）时，0.3 会把一堆不相关的
  开发对话塞进 prompt，语气反而更怪。库越充实，阈值越好用。
- 地址默认从 `ctx.webServer.getOrigin()` 推，也可以用 `memoryEndpoint` 指到别处。

### 看视频：先看懂，再回话

只拿「标题 + 你的评论」回话，等于闭着眼睛接梗 —— 遇到知识型视频容易答成「一句正确的废话」。
所以回复前会**先问「刷B站」要字幕**：

```
ctx.tools.get('bili_subtitle').execute({ bvid })   →  { text }
```

拿到字幕 → 把 ASR 碎行接成一段 → 按 `videoContextMaxChars` 截 → 塞进 user prompt，并注明
「AI 字幕，可能有识别错误；用得上就接着聊，用不上别硬扯」。

- **依赖**：「刷B站」（`dsh-bili-scroll`）。没装/没启用 → 日志提一次，这条退回只看标题，不报错、不卡住。
- **看多深**（`videoContext`）：
  - `full`（默认）：字幕装得下就给**全文**；装不下（超 `videoContextMaxChars`，默认 8000 字）就拼
    「**开头 ＋ 你评论里提到的那些段 ＋ 结尾**」，中间用 `…` 标出跳过处 —— 长视频的答案通常在 60% 之后，
    一刀砍在开头等于白读。
  - `head`：只取开头（旧行为，最省）。
  - `off`：不看，只凭标题回。
- 「你提到的那些段」怎么找：中文没有分词器，就拿评论的**二字组合**去字幕里找，命中越密集的位置越像你问的那段，
  取最多 3 段。一个词都没命中（比如只写了「哈哈哈哈」）→ 改成**全片均匀抽样**，中后段也在。
- **为什么不自己签**：实测直连 `/x/player/v2` 与 `/x/player/wbi/v2`（不带 wbi 签名）**都返回 `subs: 0`** ——
  code 是 0，字幕是空，静默骗人；同一支视频走刷B站的 `bili_subtitle` 能拿到 258 段。所以这里复用它的链路，
  不重复实现签名。
- **超时**：`videoContextTimeoutMs`（默认 20s），超时就放弃这条的字幕，回复照发。
- 没有 BV 号的场合（比如在动态里 @ 你）直接跳过。

---

## 配置参数

全部字段都带 `volatile` 标记，改完**下一个查询周期就生效**，不用重启 DSH。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `true` | 总开关。关掉只是不自动回，三个工具还能手动用 |
| `intervalMinutes` | int | `5` | 多久查一次「@我的」。**别低于 3**（B 站对高频读接口有风控），也别高于 15（回得太迟） |
| `maxPerDay` | int | `3` | 一天最多自动回几条。`0` = 只看不回 |
| `minGapMinutes` | int | `10` | 两条之间至少隔几分钟。连着回很像机器人 |
| `maxChars` | int | `80` | 单条回复上限，超了截断（带 `…`）。B 站评论太长会被拒 |
| `allowUids` | string[] | `[]` | 只回这些 UID（逗号 / 空格分隔都行）。**留空 = 只回登录账号自己** |
| `includeOthers` | bool | `false` | 连陌生人的 @ 也回。**默认关，别轻易开**：公开场合说错话没人兜 |
| `dryRun` | bool | `false` | 只生成不发送，草稿写进日志 |
| `provider` | string | `ark-code-latest` | 写回复用哪个 provider 路由 |
| `model` | string | `ark-code-latest` | 模型 id |
| `personaSource` | `agent-md` \| `builtin` | `agent-md` | 底稿人格从哪来：读 `<DSH_HOME>/AGENT.md`，还是用内置「小肥鱼」底稿。**读不到文件自动回落内置**，不会因为没写 AGENT.md 就不回复 |
| `personaMode` | `append` \| `replace` | `append` | `personaPrompt` 怎么用：接在底稿后面，还是**整份替换**底稿（`replace` + 空串会回落底稿，不会变成空 prompt） |
| `personaPrompt` | string | `""` | 人格补充/替换（例：`更贱一点，每条带一个 emoji`） |
| `keepReplyRules` | bool | `true` | 始终保留评论区场景规则（60 字以内、只输出正文、不提内部术语）。关掉后人格说什么就是什么，用 AGENT.md 时容易回成长篇报告 |
| `agentMdPath` | string | `""` | AGENT.md 路径，留空 = `<DSH_HOME>/AGENT.md`（桌面版 `~/.dsh/AGENT.md`） |
| `memoryEnabled` | bool | `false` | 回复前是否去 `dsh-memory-vector` 捞相关旧事。**默认关**：检索要花向量化 token |
| `memoryTopK` | int | `3` | 最多带几条记忆进 prompt |
| `memoryMaxChars` | int | `600` | 记忆正文总字符预算，超了截断 |
| `memoryMinScore` | number | `0.3` | 相似度下限，低于它不采用 |
| `memoryAllowFtsOnly` | bool | `false` | 是否接受「纯关键词命中」（没有余弦相似度，多半是噪音）。默认不接受 |
| `memoryScope` | string | `global` | 检索范围：`global` / `workspace-first` / `workspace` |
| `memoryEndpoint` | string | `""` | 检索地址，留空 = `<本机 origin>/api/memory-vector/search` |
| `videoContext` | `full` \| `head` \| `off` | `full` | 看懂视频的方式：`full` 全片（超长按你的评论挑重点段）、`head` 只取开头、`off` 不看。老值 `subtitle` 等同 `head` |
| `videoContextMaxChars` | int | `8000` | 字幕最多占多少字符；`full` 模式超了会「开头＋关键词段＋结尾」，不是硬砍 |
| `videoContextTimeoutMs` | int | `20000` | 等字幕最多等多久，超时就放弃这条的字幕 |
| `credentialPath` | string | `""` | 凭证文件路径，留空 = `<home>/bili_credential.json` |
| `home` | string | `""` | 数据目录，留空 = `$DSH_HOME/fish-atme`（默认 `~/.dsh/fish-atme`） |

三种改法，写的是同一份配置（`fish-atme-config.json` + patch 初始值），谁后写谁生效：

1. **设置页**「B站 @我」（推荐）；
2. **直接改文件** `~/.dsh/fish-atme/fish-atme-config.json`，只写要改的字段，下一跳重读；
3. **让模型改**（工具 + 自然语言）。

---

## 模型工具（3 个）

| 工具 | 作用 | 会不会公开发言 |
|---|---|---|
| `bili_at_me` | 读「@我的」，返回发送者、评论原文、BV 号/标题、rpid、时间。参数：`limit`(1–30)、`debug` | 不会（只读） |
| `bili_at_me_draft` | 给某条 @ 生成一条回复草稿。参数：`rpid`（省略则挑最新一条）；也可以传 `bvid` + `text` 拿任意视频试语气 | 不会（只生成） |
| `bili_at_me_status` | 定时器开没开、今天回了几条、去重表多少条、日志/状态文件在哪 | 不会 |

> 想真的发出去，用定时器（自动），或者用你环境里的评论工具（手动）。

---

## 设置页 HTTP 接口

插件在宿主上注册了 `/api/fish-atme`（prefix），供 `client.js` 使用，也可以被别的前端复用。
鉴权两道：DSH 自己的信任栅栏（认 cookie/token）+ 本机同源检查（Host 必须是 `127.0.0.1`/`localhost`/`[::1]`）。

| 方法 | 路径 | 请求 | 返回 |
|---|---|---|---|
| `GET` | `/api/fish-atme/state` | — | `{ ok, config, status, logTail, files }` |
| `POST` | `/api/fish-atme/config` | `{ "config": { "maxPerDay": 5 } }` | 保存后的完整 `state`（定时器按新参数重启） |
| `POST` | `/api/fish-atme/draft` | — | `{ ok, video, hisText, draft, tidied, alreadyReplied, willSend }` |

失败一律 `{ ok: false, error }` + 对应状态码（401/403/404/500）。

---

## 安全设计

这个插件**会以你的账号公开发言**，所以默认值全部偏保守：

| 闸 | 行为 |
|---|---|
| 白名单 | 只回 `allowUids`；留空则只回登录账号自己（`dedeuserid`） |
| 每日额度 | `maxPerDay` 封顶，`0` = 完全不发 |
| 最小间隔 | 两条之间 `minGapMinutes`，防止刷屏 |
| 去重 | 按评论 `rpid` 记住回过谁，同一句只回一次 |
| dryRun | 打开后只写日志不发；换模型/改口吻时先这样验 |
| 失败即抛 | 接口 `code != 0` 当失败处理，不会假装发成功 |
| 单飞 | 同一时刻只跑一轮（`busy` 锁），不会并发回复 |
| 额度不预支 | 只有真的处理成功才 `count += 1` |
| 配置防呆 | `allowUids` 留空时设置页标黄：*「现在只会回你自己 @ 自己」*（这是 0.2.0 加的，踩过坑） |
| 保存不误伤 | 设置页只提交你**真的动过**的字段，不会把别处改过的配置盖回旧值 |
| 配置热读 | 每次进设置页接口都重读配置文件，手改 JSON 也不会看到过期值 |
| 人格只读 | 只读 AGENT.md，从不写；读不到就回落内置底稿，不会因为人格问题停摆 |
| 记忆可失 | 记忆检索失败一律当没有记忆，`dryRun`/发送链路不受影响 |
| 记忆不出机 | 记忆检索只打 `127.0.0.1`（`ctx.webServer.getOrigin()`），没有把记忆发到外面的路径 |

建议再叠一层：`intervalMinutes ≥ 5`、`maxPerDay ≤ 5`、先 `dryRun` 跑一天。

---

## 数据与隐私

- 本地只存：凭证（你放的）、去重表、额度、日志。**不上传任何东西**。
- 请求只发往 `api.bilibili.com`（读 @ 列表、查视频信息、发评论）、你自己的模型 provider，以及（仅当 `memoryEnabled`）**本机** `127.0.0.1` 上的记忆插件接口。
- 会**读** `<DSH_HOME>/AGENT.md`（人格底稿），只读不写。
- 仓库里**没有**任何 UID、昵称、cookie、API Key；`allowUids` 默认为空。
- 日志会记录「回了谁、回了什么」——如果日志要分享出去，记得先脱敏。

---

## 目录结构

```
dsh-fish-atme/
├── package.json          # dsh.bundle.patch + dsh.client 声明（bundle 与浏览器半端）
├── cordis.patch.yml      # 插件自带的挂载声明：insert id=fish-atme
├── index.js              # 宿主半端：定时器 / 接口 / 工具 / 配置
├── client.js             # 浏览器半端：设置页那一栏（自注册脚本，非 ESM）
├── lib/
│   └── schema.mjs        # 解析 @deepseek-ai/schemastery（拿不到就降级，不影响插件加载）
├── scripts/
│   ├── sanitize-check.mjs # 推送前脱敏体检（cookie / UID / 本机路径 / 明文密钥 / 运行时产物）
│   └── README.md          # 脱敏规则与上传流程
├── .githooks/
│   └── pre-commit         # 提交时自动跑体检（git config core.hooksPath .githooks 启用）
├── tests/
│   └── offline.mjs       # 离线测试：纯函数 / 人格拼接 / 记忆裁剪 / 请求形状 / 配置落盘 / 定时器装卸
├── README.md
└── LICENSE
```

---

## 开发与测试

```bash
node tests/offline.mjs      # 或 npm test
```

离线测试不碰网络：把 `fetch` 换掉验请求形状，把 `setInterval` 换掉验定时器装卸，用临时目录验配置落盘。

改完代码的生效方式，按改的是哪一半分：

| 改了什么 | 怎么生效 |
|---|---|
| 宿主半端 `index.js` / `lib/` | 插件管理里把该条目**关掉再打开**（不会自动热重载），之后刷新页面看设置页 |
| 浏览器半端 `client.js` | 同上关/开一次 + **刷新页面** |
| 第一次给插件加 `dsh.client` 声明 | 改完要**重启一次 DSH**（清单只在启动时读） |

> 这两条是实测出来的：改完 `client.js` 只刷新页面看不到新代码，得先把插件关/开一次。

---

## 常见问题

**设置里没有「B站 @我」这一栏**
浏览器半端在 DSH 启动时扫描 `dsh.client`，装完/加完 `client.js` 必须**重启一次 DSH**。宿主半端（定时器、工具）不受影响，一直在跑。

**参数改了好像没生效**
三种来源：patch 初始值 → `fish-atme-config.json` → 设置页。后写的覆盖前面的。定时器每一跳都会重读配置，最多等一个 `intervalMinutes`。改 `intervalMinutes` 本身想立刻生效，就在设置页点一次「保存并生效」（会重启定时器）。

**日志里一直「没有要回的」**
正常：说明查到了，但没有满足条件的（不是你本人 / 已经回过 / 额度用完 / 间隔没到）。日志会写清条数。

**发不出去，日志里有 `code=`**
- `-101` 账号未登录：`sessdata` 失效，重新抄一份；
- `-111` csrf 校验失败：`bili_jct` 缺失或过期；
- `12002` 评论区关闭：UP 关了评论区，跳过这条即可。

**插件不激活，报 `failed to import`**
多半是 `schemastery` 解析不到——本插件已做降级（`lib/schema.mjs` 会在 profile 的 `node_modules` 里找）；若仍失败，检查宿主是否提供了 `tools` / `llm` / `webServer` 三个服务。

**会不会把别人的号也回了**
不会。`includeOthers=false` 时只匹配白名单（默认就是登录账号自己）。真开了它，也只有 `maxPerDay` 条。

---

## 从 GitHub 装 / 发布

仓库：<https://github.com/ZZh2333/dsh-fish-atme>

```bash
# 装进 DSH
dsh plugin add https://github.com/ZZh2333/dsh-fish-atme.git

# 自己发版
git remote add origin git@github.com:ZZh2333/dsh-fish-atme.git
git push -u origin main
```

- 已经在用 npm 的话：`npm publish`（`package.json` 里的 `repository` / `homepage` / `bugs` 已指向这个仓库）。
- 提交前跑一遍 `node tests/offline.mjs`，并确认没有把 `bili_credential.json`、`fish-atme-*.json` 提交上去（`.gitignore` 已经挡了）。

---

## 更新日志

完整记录见 [CHANGELOG.md](CHANGELOG.md)。

### 0.2.0（2026-11-02）

- 修复：设置页保存会把 `allowUids` 等字段**用旧值盖回去**（白名单被清空 ⇒ 一条都不回）
- 修复：设置页接口读的是启动时的内存快照，手改配置文件后显示过期值
- 新增：白名单为空时设置页标黄警告
- 修复：`index.js` 改完不会自动热重载，README 里写清楚关/开一次的操作

### 0.1.0（2026-11-01）

- 首个版本：定时轮询「@我的」、三道安全闸（白名单 / 额度 / 间隔 + 去重）、
  人格化回复、3 个模型工具、13 个可改参数、设置页。

---

## 许可证

MIT，见 [LICENSE](./LICENSE)。
