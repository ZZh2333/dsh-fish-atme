# 更新日志

本文件记录 `dsh-fish-atme` 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.4.3] - 2026-11-05

### 修复

- **`定时器异常：config is not defined`（0.3.5 引入）**
  给 `buildSystemPrompt` 加 `keepReplyRules` 时，我用统一替换把 5 个调用点都写成了 `config.keepReplyRules`，
  但定时器那处在 `createWatcher(ctx, getConfig)` 里 —— 那个作用域只有 `cfg`，没有 `config`：

  - 日志里每 5 分钟一行「定时器异常：config is not defined」；
  - **真有人 @ 时一条都不会回**（异常点在生成回复之前，所以不会误发，也没污染去重表和额度）；
  - 而「查了一次：N 条 @，没有要回的」照常打 —— 那些 return 在异常点之前，日志看着像在正常工作。

  改成 `cfg.keepReplyRules`。顺带说明：`0.4.0` 里新增的取字幕调用写在同一个函数里，用的本来就是 `cfg`，
  所以只有这一处漏了。

### 新增（测试）

- `createWatcher` 现在导出，并把 `tick` 露在返回值上；测试用一份假 B 站响应把**整条 tick** 跑通
  （取 @ → 查视频 → 没装刷B站时降级 → 生成 → dryRun 落日志），断言不抛错、日志里有 `[dryRun]`、
  且**不出现「定时器异常」**。以后往定时器里塞错变量会被这条测试拦住。

---

## [0.4.0] - 2026-11-05

这一版解决「闭着眼睛接梗」：**回复前先看懂视频，再说话。**

### 新增

- **回复前调「刷B站」取字幕**（`videoContext`，默认 `subtitle`）
  `ctx.tools.get('bili_subtitle').execute({ bvid })` → 字幕全文 → ASR 碎行接成一段 →
  按 `videoContextMaxChars`（默认 800 字）截断 → 塞进 user prompt，并注明「AI 字幕，可能有错，
  用得上就接着聊，用不上别硬扯」。超时 `videoContextTimeoutMs`（默认 20s）就放弃这条的字幕。

  为什么复用它的链路而不是自己写：实测直连 `/x/player/v2` 和 `/x/player/wbi/v2`（不带 wbi 签名）
  **都返回 `code: 0` 但 `subs: []`** —— 静默骗人；同一支视频走 `bili_subtitle` 能拿到 258 段。

- **`bili_at_me_draft` 支持 `bvid` + `text`**：不按「@我的」走，直接拿任意视频 + 一句假评论试语气。
  调人格 / 调长度时不用等真的有人 @ 你。

### 设计

- 取字幕失败**一律降级**：没装刷B站、工具报错、超时、没有 BV 号（动态）、没有字幕 ——
  都只让「这条只看标题」，回复照发；日志每小时最多一行。
- 设置页多一栏「看视频」：总开关、字幕字数上限、等待上限，并直接标出 `bili_subtitle` 是否可用。

### 测试

- 新增：字幕返回形状（`{text}` / JSON 串 / 裸串 / content 块 / 包 `raw`）、ASR 碎行接句与截断、
  工具缺失 / 抛错 / 超时 / 开关关闭 / 无 BV 号六种降级路径。

---

## [0.3.5] - 2026-11-05

### 修复

- **`personaSource: agent-md` 会把评论场景规则一起换掉（0.3.0 引入的回归）**
  旧实现里 `agentText` 非空就直接 `base = agentText`，内置底稿整份不参与 ——
  于是「一句话到两句、60 字以内、只输出正文、不提内部术语」这些约束**全没了**，
  只剩 `tidyReply` 事后硬截 80 字。加上 `AGENT.md` 里本来就有一堆跟评论无关的偏好
  （插件安全审查、生图规则、先给结论再给理由），结果一条 B 站评论回成了带小标题的分析报告。
  主人在 QQ 会话里当场问「为什么 B 站插件的回复和你这个相差这么多」。

  现在拆成两层：**人格**（底稿 / personaPrompt）管「像谁在说」，
  **场景规则**（新增 `REPLY_RULES`）管「在评论区怎么说话」—— 后者永远贴在 system 最后，
  并写明优先级高于上面的风格描述。新增开关 `keepReplyRules`（默认 `true`）。

### 变更

- 设置页「人格」多一行开关：是否始终保留评论区场景规则。
- README 增「场景规则：跟人格解耦」一节，写明为什么这么拆。

---

## [0.3.4] - 2026-11-05

### 新增

- **`memoryAllowFtsOnly`（默认 `false`）**
  `dsh-memory-vector` 只在向量通路给 `similarity`，纯关键词命中没有余弦 → 阈值管不到它们。
  实测后果：`minScore` 调到 0.45 之后，两段**跟 B 站评论毫无关系**的开发对话照样被塞进 prompt
  （它们是关键词碰上的）。现在默认**只接受有向量相似度的命中**，要放行关键词命中得显式开这个开关。

### 文档

- README 的记忆一节补上阈值建议（0.4–0.5）与「库太空时记忆反而是噪音」的说明。

---

## [0.3.3] - 2026-11-05

### 修复

- **模型吐出空正文时被当成成功**
  实测见过两次：这一跳只回了 `finish`（`kind: 'stop'`）、一个 `text-delta` 都没有。
  旧代码只在「有 failure 且空」时抛错，于是空字符串一路走到底 —— 草稿是空的，
  定时器则会把一条空评论当成功发出去、还把 rpid 记进去重表（这条就再也不会重试）。
  现在**空正文一律抛错**，交给调用方记日志 / 下一条重试。

- `bili_at_me_draft` 的输出补上人格来源与所用记忆（0.3.2）之外，正文为空时会明确报「没返回正文」。

---

## [0.3.2] - 2026-11-05

### 变更

- `bili_at_me_draft` 的输出多两行：**人格来源**（AGENT.md / 内置底稿、多少字）与
  **这次带了几条记忆**，并把带进 prompt 的记忆原文列出来 —— 调语气时不用再猜
  「它到底拿什么在说话」。

---

## [0.3.1] - 2026-11-05

### 修复

- **带 UTF-8 BOM 的配置文件读不了，整份设置被静默丢掉**
  Windows 记事本、PowerShell 5.1 的 `Set-Content -Encoding utf8` 都会写出 BOM，
  `JSON.parse` 见到 `\uFEFF` 直接抛 `SyntaxError`，`readOverrides()` 又把这个异常吞了 ——
  表现是「设置页/文件里明明写着 `maxPerDay: 20`，定时器按默认 3 条跑」。
  现在读之前先剥 BOM，并加了回归测试。

---

## [0.3.0] - 2026-11-05

这一版解决「回得像插件，不像我」：**人格可以取 AGENT.md，记忆可以接 dsh-memory-vector。**

### 新增

- **`personaSource`：底稿人格从哪来**
  `agent-md`（默认）读 `<DSH_HOME>/AGENT.md`，`builtin` 用源码里的「小肥鱼」。
  按 mtime 缓存重读，改文件下一跳生效；文件不存在 / 为空 → 自动回落 `builtin`，
  不会因为「没人格」就停摆。
- **`personaMode`：`personaPrompt` 的用法**
  `append` 追加在底稿后（旧行为），`replace` **整份替换**底稿。
  `replace` + 空串会回落底稿 —— 宁可多说一句，也不给模型一个空 system。
- **记忆：接 `dsh-memory-vector`**
  回复前拿「他的评论 + 视频标题」查 `POST /api/memory-vector/search`，
  按 `memoryMinScore` 过滤、`memoryTopK` 限条、`memoryMaxChars` 限字，拼进 user prompt。
  相关参数：`memoryEnabled`（默认关）/ `memoryTopK` / `memoryMaxChars` /
  `memoryMinScore` / `memoryScope` / `memoryEndpoint`。
- **设置页两栏**：「人格」（底稿来源、AGENT.md 路径、append/replace、正文提示、读到多少字）
  「记忆」（开关、条数、字数、相似度、范围、检索地址、接口是否可达）；草稿预览多显示「人格来源 / 记忆条数 / 带了哪几条」。

### 修复

- **不再把 `AGENT.md` 尾部的 memory-vector 托管快照塞进 system**
  那段每 21 天变一次、纯给人看的，进 prompt 只烧 token。
- **记忆里的噪音会先洗掉**：`<compacted-summary>` 压缩摘要、「【记忆·自动回想】」旁注、
  `你：` / `我：` 回放前缀。
- **记忆检索失败不抛**：插件没装、接口 404、连接被拒 —— 一律当没有记忆，
  回复照发，日志最多每小时一行（否则每 5 分钟一行会把真正的问题淹掉）。

### 变更

- `generateReply(llm, system, info, signal)`：第二参改成**外面拼好的整份 system**，
  人格拼接从它内部搬到 `buildSystemPrompt()`，方便单独测。
- `bili_at_me_draft` 与 `POST /api/fish-atme/draft` 多返回
  `personaSource` / `personaChars` / `memoryCount` / `memories`（+ `memoryError`）。
- `bili_at_me_status` 多返回人格来源与记忆开关状态。

### 测试

- 新增：人格三态（builtin / agent-md / 读不到回落）、append 与 replace、
  托管块剔除、AGENT.md 读取缓存、记忆裁剪（阈值 / 压缩摘要 / 旁注 / 前缀 / 字符预算）、
  记忆接口请求形状、检索失败降级、记忆关着不发请求。

---

## [未发布]

### 新增

- **`scripts/sanitize-check.mjs`：推送前脱敏体检**
  扫一遍要提交的文件，拦 cookie / csrf / UID / 本机绝对路径 / 邮箱 / 明文密钥 /
  运行时产物。只读，不联网，不改文件。命中任意一条退出码 1。
  用法：`node scripts/sanitize-check.mjs`（默认查暂存区）、`--all`（查全部受控文件）。

- **`.githooks/pre-commit`：提交时自动体检**
  启用：`git config core.hooksPath .githooks`。规则改了只动 `scripts/sanitize-check.mjs` 一处。

### 变更

- `package.json` 补 `scripts`：`npm test`（跑 `tests/offline.mjs`）、`npm run sanitize`。
  之前 README 写了「或 npm test」，但 package.json 里没有这个脚本，跑起来是空的。

---

## [0.2.0] - 2026-11-02

这一版全是「设置页」的坑。触发场景很日常：**白名单明明填了，定时器却一条都不回。**

### 修复

- **设置页保存会把白名单清空**（最严重）
  设置页保存时提交的是**整份 config**，而页面拿的是打开那一刻的 state 副本。
  如果配置在别处被改过（手改 JSON、换机器同步、另一个窗口），点一下「保存并生效」，
  旧值就会把新值盖回去 —— 表现是 `allowUids` 变成 `[]`，而空数组的语义是
  「只回登录账号自己」，于是别人的 @ 一条都不回，日志还一直写「没有要回的」。
  现在改成：**只提交这一次真的改动过的字段**，并且保存前先重新拉一次最新状态再合并。

- **设置页接口读的是启动时的内存快照**
  手动编辑配置文件之后，`GET /state` 返回的仍是插件加载那会儿的配置，
  页面显示过期值 —— 进一步放大了上一条（看到的是旧值，保存回去的也是旧值）。
  现在每次进 `/api/**` 都先 `reloadConfig()` 重读文件。

- **文档里的生效方式写错了**
  实测：改完 `index.js` 并不会自动热重载，得在插件管理里把条目**关掉再打开**；
  改完 `client.js` 除了关/开，还要**刷新页面**。只有「第一次给插件加 `dsh.client` 声明」
  才需要重启整个应用。README 已按实测改写。

### 新增

- **白名单为空时的警告**：设置页在 `allowUids` 为空时标黄提示
  *「现在只会回「你自己 @ 自己」，别人的 @ 一条都不会回。要回谁就把他 UID 填进来。」*
  —— 这条语义太容易踩空，宁可吵一点。

### 文档

- README 补充「更新日志」章节与本节对应关系
- README 的安全设计表格新增三行：配置防呆、保存不误伤、配置热读
- 新增本文件 `CHANGELOG.md`

### 升级注意

- 无需迁移数据；配置、去重表、日志格式都没变。
- 升级后请在设置页确认一次「白名单 UID」不是空的。
- 如果你的配置长期没动过，建议先开 `dryRun` 跑一跳，看日志里回给谁、回了什么，再关掉。

---

## [0.1.0] - 2026-11-01

首个版本。

### 新增

- 定时轮询 B 站「@我的」（`/x/msgfeed/at`），命中白名单就让模型写一句回复并发在评论下面
- 三道安全闸：白名单（`allowUids`）、每日额度（`maxPerDay`）、最小间隔（`minGapMinutes`），加 `rpid` 去重
- `dryRun` 模式：只写日志不发评论
- 三个模型工具：`bili_at_me`（读 @ 列表）、`bili_at_me_draft`（生成草稿，不发）、`bili_reply`（发评论，默认被安全闸拦住）
- 13 个可改参数：设置页 / 配置文件 / 模型工具三条路都能改
- 设置页「B站 @我」：状态、开关、节奏与额度、白名单、语气、模型、凭证路径、数据目录、日志尾巴
- 离线测试 `tests/offline.mjs`：纯函数、请求形状、配置落盘、定时器装卸，全程不碰网络

[0.2.0]: #020---2026-11-02
[0.1.0]: #010---2026-11-01
