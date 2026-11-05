# 给「刷B站」（`dsh-bili-scroll`）加 `bili_brief` 的补丁说明

> **为什么需要它**：`dsh-fish-atme`（本插件）只负责「监听 @ → 摘要 → 回评」，
> 视频理解要交给刷B站。刷B站原生只给**材料**（字幕原文 / 画面 / 评论），没有「理解出口」，
> 所以这里给它补一个 `bili_brief` 工具：读字幕 → 出要点（默认 400 字内），只回要点不回原文。
>
> **为什么不塞进 fish-atme**：那等于把「理解」重新搬回鱼脑，职责又乱了。

## 影响范围

- 只**新增**一个工具，不改任何已有工具的行为。
- 不改 `export const inject`（`llm` 用 `ctx.get('llm')` 懒取）：宿主没有 llm 服务时这个工具返回
  `{ ok: false, error }`，其他工具完全不受影响，也不会因为多声明一个服务导致插件装不上。
- 用到的依赖：`ctx.tools`（已有）、`ctx.get('llm')`（懒取）、MCP 的 `bili_subtitle`（已有）。

## 怎么打（两种）

### 方式一：手动粘贴（推荐）

在 `index.js` 里找到 `name: 'bili_subtitle'` 那个 `tool({...})` 的结束处，紧跟着插入下面这段：

```js
  // ⭐ 给别的插件用的「理解出口」：读字幕 + 出要点，只回要点不回原文。
  //    典型消费者是「B站@我」（dsh-fish-atme）：它拿到要点后自己写成一句回复发出去。
  //    llm 服务用 ctx.get 懒取 —— 宿主没有 llm 时这个工具返回 ok:false，别的工具不受影响。
  tool({
    name: 'bili_brief',
    description: '按 BV 号「理解」一个视频，产出一份要点（默认 400 字内）：讲了什么 + 和这个问题直接相关的'
      + '具体内容（数字/结论/步骤）。给别的插件用，只给要点，不给字幕原文。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      question: { type: 'string', description: '他关心/在问什么（可空，空了就写成通篇要点）' },
      maxChars: { type: 'number', description: '要点最多多少字，默认 400' },
      provider: { type: 'string', description: '可选：用哪个 provider，空=宿主默认' },
      model: { type: 'string', description: '可选：用哪个模型，空=宿主默认' },
    },
    async execute(args) {
      const bvid = String(args.bvid ?? '').trim()
      if (!bvid) return { ok: false, error: '没有 BV 号' }
      const maxChars = Math.max(80, Math.min(Number(args.maxChars) || 400, 2000))
      const question = String(args.question ?? '').trim()

      let sub
      try {
        sub = await call('bili_subtitle', { bvid })
      } catch (error) {
        return { ok: false, bvid, error: `取字幕失败：${error?.message ?? error}` }
      }
      const subtitle = typeof sub === 'string' ? sub : String(sub?.text ?? '')
      const title = typeof sub === 'object' ? String(sub?.title ?? '') : ''
      if (!subtitle.trim()) return { ok: false, bvid, title, error: '这条视频没有可用字幕' }

      const llm = (() => {
        try { return ctx.get?.('llm') ?? ctx.llm ?? null } catch { return null }
      })()
      if (!llm || typeof llm.stream !== 'function') {
        return { ok: false, bvid, title, error: '这个宿主没有 llm 服务，出不了要点' }
      }

      // 字幕太长就截尾：要点本来就要丢细节，没必要把两万字全塞进来
      const cap = 20000
      const body = subtitle.length > cap ? `${subtitle.slice(0, cap)}\n…（后面 ${subtitle.length - cap} 字截掉了）` : subtitle
      const ask = question
        ? `他在问：${question}\n请写一份给他的要点：先一句话说这条视频在讲什么，再写和他这个问题**直接相关**的具体内容（有数字、结论、步骤就原样写出来）。如果视频里压根没回答这个问题，就直接说「视频里没讲这个」。`
        : '请写一份给他的要点：这条视频讲了什么，分 2 到 4 条，有数字和结论就写出来。'
      const prompt = [
        `下面是 B站视频${title ? `《${title}》` : ''}的字幕（AI 转写，可能有错别字、断句很碎）。`,
        '',
        body,
        '',
        ask,
        `只写要点，不要寒暄、不要复述字幕原文、不要加小标题，不超过 ${maxChars} 字。`,
      ].join('\n')

      let text = ''
      let failure = ''
      try {
        for await (const chunk of llm.stream({
          provider: String(args.provider ?? '').trim() || undefined,
          model: String(args.model ?? '').trim() || undefined,
          system: '你是看视频的助手。只根据给你的字幕说话，字幕里没有的不要编。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0.3,
          maxTokens: Math.min(2000, Math.ceil(maxChars * 2)),
        })) {
          if (chunk?.type === 'text-delta') text += chunk.text
          if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            failure = chunk.reason.failure?.message ?? chunk.reason.kind
          }
        }
      } catch (error) {
        return { ok: false, bvid, title, error: `理解失败：${error?.message ?? error}` }
      }
      const brief = text.trim().replace(/\s*\n+\s*/g, ' ').slice(0, maxChars)
      if (!brief) return { ok: false, bvid, title, error: failure ? `模型调用失败：${failure}` : '模型这一跳没返回正文（可能只给了 reasoning）' }
      return { ok: true, bvid, title, brief, chars: brief.length, subtitleChars: subtitle.length }
    },
  })
```

### 方式二：从本仓库拿整份 `index.js`

本机打补丁时改的就是整份文件；如果你在别处重装刷B站，把本仓库 `patches/` 下的这份说明照方式一贴回去即可。

## 验证

1. 重启/重载刷B站插件。
2. 让任意 agent 调 `bili_brief({ bvid: 'BV1DDxD6hEQn', question: '调度实验里差多少' })`，应返回
   `{ ok: true, brief: '……12.4 分钟……', chars, subtitleChars }`。
3. `dsh-fish-atme` 的 `bili_at_me_status` 里「看视频」一行会从「直接读字幕原文」变成「要刷B站的理解要点」。

## 上游更新了怎么办

刷B站是**拷贝安装**（`~/.dsh/plugins/dsh-bili-scroll`），上游发布新版会**整份覆盖**，这个工具会消失。
消失后的表现是：fish-atme 日志出现「没找到 bili_brief（刷B站版本旧？），退回字幕原文」，
功能自动退回读字幕原文（不会坏，只是贵一点）。想恢复就照方式一再贴一次。
