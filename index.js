/**
 * dsh-fish-atme —— 盯着 B 站「@我的」，只回你本人
 * ============================================================================
 * 它做什么
 *   1. 每 N 分钟读一次 `/x/msgfeed/at`（只读接口，纯 HTTP，不花 token）；
 *   2. 命中「他本人 @ 我」就调模型写一句回复（人格可配），发在评论下面；
 *   3. 三道默认闸：只回白名单里的人、一天最多 3 条、两条之间至少 10 分钟。
 *
 * 三个工具
 *   bili_at_me        —— 读「@我的」（只读，不发东西）
 *   bili_at_me_draft  —— 生成一条草稿（只生成，不发），调语气用
 *   bili_at_me_status —— 看定时器状态、今天回了几条、去重表里有谁
 *
 * 参数全在 Config 里（设置页可改），字段说明与建议值见 README.md。
 * 🔴 这是**会自动公开发言**的插件：`dryRun` 先开着观察一轮，确认语气之后再关。
 * ============================================================================
 */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadSchemastery } from './lib/schema.mjs'

export const name = 'fish-atme'
export const inject = ['tools', 'llm', 'webServer']

const AT_ME_CANDIDATES = [
  // /x/msgfeed/atme 已下线（404 错误页），新接口是 /x/msgfeed/at；旧的留作退路
  'https://api.bilibili.com/x/msgfeed/at?platform=web&mobi_app=web&build=0',
  'https://api.bilibili.com/x/msgfeed/atme?build=0&mobi_app=web&platform=web',
]
const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
const REPLY_ADD_API = 'https://api.bilibili.com/x/v2/reply/add'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 默认值：patch 里没写、设置页也没改时用这一份 */
export const DEFAULTS = {
  enabled: true,
  intervalMinutes: 5,
  maxPerDay: 3,
  minGapMinutes: 10,
  maxChars: 80,
  allowUids: [],
  includeOthers: false,
  dryRun: false,
  provider: 'ark-code-latest',
  model: 'ark-code-latest',
  personaPrompt: '',
  credentialPath: '',
  home: '',
}

/** 回复口吻的底稿；personaPrompt 会接在它后面，用来覆盖/补充 */
const BASE_PERSONA = [
  '你负责替号主在 B 站评论区回复评论。',
  '说话简洁、直接给结论，不说客套话；偶尔幽默一下，可以有自嘲。',
  '不要用「主人」「本喵」「人家」这类称呼；不要提设置项、内部术语、插件名、判重、额度这些。',
  '不要复述对方的原话，不要长篇大论。一句话到两句话，60 字以内。',
  '只输出回复正文，不要加引号、不要加 @ 前缀。',
].join('\n')

const z = await loadSchemastery()

/**
 * Config —— 每个字段都必须 `.extra('volatile', true)`：
 * DSH 的设置层只认 volatile 字段（否则写设置时报「no volatile fields」）。
 * 另外两条前提：**entry id 必须等于本模块的 name（fish-atme）**、本模块导出 Config。
 */
export const Config = !z ? undefined : z.object({
  /** 总开关（关掉 = 定时器不启动，工具还留着可以手动用） */
  enabled: z.boolean().default(true).extra('volatile', true),
  /** 多久查一次「@我的」（分钟）。建议 3–10：太勤容易被风控，太慢回得迟 */
  intervalMinutes: z.natural().default(5).extra('volatile', true),
  /** 一天最多自动回几条。建议 3–5；设 0 等于「只看不回」 */
  maxPerDay: z.natural().default(3).extra('volatile', true),
  /** 两条之间至少隔几分钟。建议 ≥10：连着刷屏会显得像机器人 */
  minGapMinutes: z.natural().default(10).extra('volatile', true),
  /** 单条回复最多多少字（超了截断）。B 站评论建议 ≤80 */
  maxChars: z.natural().default(80).extra('volatile', true),
  /** 只回这些 UID（逗号分隔也行，填一个数字就行）。留空 = 回「登录账号自己」 */
  allowUids: z.array(z.string()).default([]).extra('volatile', true),
  /** 危险：连别人的 @ 也回。默认关 —— 公开场合回陌生人，说错话没人兜 */
  includeOthers: z.boolean().default(false).extra('volatile', true),
  /** 只生成不发送（草稿写进日志）。第一次用建议先开一轮看看语气 */
  dryRun: z.boolean().default(false).extra('volatile', true),
  /** 用哪个模型写回复：provider 路由 */
  provider: z.string().default('ark-code-latest').extra('volatile', true),
  /** 用哪个模型写回复：model id */
  model: z.string().default('ark-code-latest').extra('volatile', true),
  /** 额外人格：接在默认口吻后面。比如「更贱一点」「每个回复带一个 emoji」 */
  personaPrompt: z.string().default('').extra('volatile', true),
  /** B 站凭证文件路径。留空 = <home>/bili_credential.json */
  credentialPath: z.string().default('').extra('volatile', true),
  /** 数据目录（状态 / 日志 / 凭证都在这儿）。留空 = $DSH_HOME/fish-atme（默认 ~/.dsh/fish-atme） */
  home: z.string().default('').extra('volatile', true),
})

/* ─────────────── 路径与文件 ─────────────── */

function resolveHome(config) {
  const configured = String(config?.home ?? '').trim()
  if (configured) return configured
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return process.env.FISH_ATME_HOME || join(dshHome, 'fish-atme')
}

function credentialPathOf(config) {
  const configured = String(config?.credentialPath ?? '').trim()
  return configured || join(resolveHome(config), 'bili_credential.json')
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {})
  await writeFile(path, JSON.stringify(value, null, 1), 'utf8')
}

async function appendLog(path, line) {
  try {
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {})
    await appendFile(path, `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去就算了，绝不能因为日志把功能搞挂 */
  }
}

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date)
}

/**
 * 把宿主送进来的 config 洗一遍。
 * 🔴 为什么必须洗：Config 里每个字段都标了 `volatile`，而 schemastery 解析 volatile 字段
 *    时给的是**一个占位对象**（不是默认值）。宿主没在 patch / 设置页里显式写过的参数，
 *    到 apply() 里就是 `{}` —— 直接 `String(cfg.home)` 会得到 "[object Object]"，
 *    日志就会被写到 `node_modules/desktop/[object Object]/` 这种鬼地方（真踩过）。
 *    所以：只接受类型对的标量，其它一律回落到 DEFAULTS。
 */
export function normalizeConfig(raw) {
  const source = raw ?? {}
  const out = { ...DEFAULTS }
  const take = (key, accepts, cast) => {
    const value = source[key]
    if (!accepts(value)) return
    out[key] = cast ? cast(value) : value
  }
  const isBool = (value) => typeof value === 'boolean'
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
  const isStr = (value) => typeof value === 'string'

  take('enabled', isBool)
  take('intervalMinutes', isNum)
  take('maxPerDay', isNum)
  take('minGapMinutes', isNum)
  take('maxChars', isNum)
  take('allowUids', (value) => Array.isArray(value) && value.every(isStr))
  take('includeOthers', isBool)
  take('dryRun', isBool)
  take('provider', (value) => isStr(value) && value.trim().length > 0)
  take('model', (value) => isStr(value) && value.trim().length > 0)
  take('personaPrompt', isStr)
  take('credentialPath', isStr)
  take('home', isStr)
  return out
}

/* ─────────────── B 站 HTTP ─────────────── */

async function credentialRaw(config) {
  return JSON.parse(await readFile(credentialPathOf(config), 'utf8'))
}

async function cookieHeader(config) {
  const parsed = await credentialRaw(config)
  const field = (...names) => {
    for (const key of names) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }
  const sessdata = field('sessdata', 'SESSDATA')
  if (!sessdata) throw new Error(`凭证文件里没有 sessdata：${credentialPathOf(config)}`)
  const parts = [`SESSDATA=${sessdata}`]
  const jct = field('bili_jct', 'BILI_JCT')
  if (jct) parts.push(`bili_jct=${jct}`)
  const uid = field('dedeuserid', 'DedeUserID', 'DEDEUSERID')
  if (uid) parts.push(`DedeUserID=${uid}`)
  const buvid = field('buvid3', 'BUVID3')
  if (buvid) parts.push(`buvid3=${buvid}`)
  return { cookie: parts.join('; '), csrf: field('bili_jct', 'BILI_JCT') ?? '', meUid: field('dedeuserid', 'DedeUserID') ?? '' }
}

async function biliJson(url, cookie, signal) {
  const response = await fetch(url, {
    headers: {
      cookie,
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      accept: 'application/json, text/plain, */*',
    },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return await response.json()
}

function replyText(item) {
  const candidates = [
    item?.item?.source_content,
    item?.reply?.content?.message,
    item?.item?.content,
    item?.content?.message,
    item?.reply?.content,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }
  return ''
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function normalize(item) {
  // /x/msgfeed/at 的字段：item.item.subject_id = 稿件 aid、source_id = 评论 rpid
  return {
    from: firstString(item?.user?.nickname, item?.user?.name) ?? '未知用户',
    mid: firstString(item?.user?.mid, item?.user?.uid),
    text: replyText(item),
    rpid: firstString(item?.item?.source_id, item?.reply?.rpid, item?.reply?.id),
    aid: firstString(item?.item?.subject_id, item?.item?.target_id, item?.item?.oid, item?.reply?.oid),
    uri: firstString(item?.item?.uri),
    title: firstString(item?.item?.title),
    at: typeof item?.at_time === 'number' ? new Date(item.at_time * 1000).toISOString() : undefined,
  }
}

async function resolveVideo(aid, cookie, signal) {
  if (!aid) return {}
  try {
    const payload = await biliJson(`${VIEW_API}?aid=${encodeURIComponent(aid)}`, cookie, signal)
    const data = payload?.data
    if (!data) return {}
    return { bvid: data.bvid, title: data.title, owner: data.owner?.name }
  } catch {
    return {}
  }
}

async function fetchAtItems(cookie, signal) {
  const failures = []
  for (const url of AT_ME_CANDIDATES) {
    try {
      const attempt = await biliJson(url, cookie, signal)
      if (attempt?.code === 0) return Array.isArray(attempt.data?.items) ? attempt.data.items : []
      failures.push(`${url} → code=${attempt?.code} ${attempt?.message ?? ''}`)
    } catch (error) {
      failures.push(`${url} → ${error?.message ?? error}`)
    }
  }
  throw new Error(`「@我的」接口全部失败：\n${failures.join('\n')}`)
}

async function postReply({ cookie, csrf, aid, root, message, signal }) {
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    root: String(root),
    parent: String(root),
    message,
    csrf,
    plat: '1',
  })
  const response = await fetch(REPLY_ADD_API, {
    method: 'POST',
    headers: {
      cookie,
      'user-agent': UA,
      referer: `https://www.bilibili.com/video/av${aid}`,
      origin: 'https://www.bilibili.com',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal,
  })
  const payload = await response.json().catch(() => ({}))
  if (payload?.code !== 0) throw new Error(`发送失败 code=${payload?.code} ${payload?.message ?? ''}`)
  return payload?.data?.rpid ?? payload?.data?.rpid_str
}

/* ─────────────── 回复文本 ─────────────── */

async function generateReply(llm, persona, info, signal) {
  const system = String(persona ?? '').trim() ? `${BASE_PERSONA}\n${String(persona).trim()}` : BASE_PERSONA
  const prompt = [
    `视频：《${info.title ?? '未知标题'}》${info.owner ? `（UP：${info.owner}）` : ''}`,
    `他在评论里写了：${info.text}`,
    '',
    '给这条 @ 写一句回复。',
  ].join('\n')
  let text = ''
  let failure = ''
  for await (const chunk of llm.stream({
    provider: info.provider,
    model: info.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0.8,
    maxTokens: 300,
    signal,
  })) {
    if (chunk?.type === 'text-delta') text += chunk.text
    if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
      failure = chunk.reason.failure?.message ?? chunk.reason.kind
    }
  }
  if (text.trim().length === 0 && failure) throw new Error(`模型调用失败：${failure}`)
  return text.trim()
}

function tidyReply(text, maxChars) {
  let out = String(text ?? '').trim()
  out = out.replace(/^["'“「]|["'”」]$/g, '').trim()
  out = out.replace(/^@\S+\s*/, '').trim()
  out = out.replace(/\s*\n+\s*/g, ' ').trim()
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

/* ─────────────── 去重 / 额度 ─────────────── */

function allowSet(config, meUid) {
  const listed = (Array.isArray(config.allowUids) ? config.allowUids : [])
    .flatMap((value) => String(value).split(/[,，\s]+/))
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
  if (listed.length > 0) return new Set(listed)
  return new Set(meUid ? [String(meUid)] : [])
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = compact(inner)
    }
    return out
  }
  return value
}

/* ─────────────── 定时器 ─────────────── */

function createWatcher(ctx, getConfig) {
  let timer = null
  let kick = null

  const log = (line) => appendLog(join(resolveHome(getConfig()), 'fish-atme.log'), line)

  async function tick() {
    const cfg = getConfig()
    const home = resolveHome(cfg)
    const stateFile = join(home, 'fish-atme-state.json')
    const maxPerDay = Math.max(0, Number(cfg.maxPerDay) || 0)
    const minGapMinutes = Math.max(1, Number(cfg.minGapMinutes) || DEFAULTS.minGapMinutes)
    const maxChars = Math.max(20, Number(cfg.maxChars) || DEFAULTS.maxChars)
    const dryRun = cfg.dryRun === true
    const includeOthers = cfg.includeOthers === true

    if (maxPerDay === 0) {
      log('今天额度是 0（maxPerDay=0）⇒ 只看不回')
      return
    }
    const state = await readJson(stateFile, { seen: {}, day: '', count: 0, lastAt: 0 })
    const today = dayKey()
    if (state.day !== today) {
      state.day = today
      state.count = 0
    }
    const lastAt = Math.min(Number(state.lastAt || 0), Date.now())
    if (Date.now() - lastAt < minGapMinutes * 60_000) return

    const { cookie, csrf, meUid } = await cookieHeader(cfg)
    const allowed = allowSet(cfg, meUid)
    const items = (await fetchAtItems(cookie)).map(normalize)
    const fresh = items.filter((item) => {
      if (!item.rpid || !item.aid) return false
      if (!includeOthers && allowed.size > 0 && !allowed.has(String(item.mid))) return false
      return !state.seen[item.rpid]
    })
    if (fresh.length === 0) {
      log(`查了一次：${items.length} 条 @，没有要回的`)
      return
    }
    if (Number(state.count || 0) >= maxPerDay) {
      log(`@ 监听：今天已经处理 ${state.count} 条（上限 ${maxPerDay}）`)
      return
    }

    // 接口最新在前；先处理最早那条，免得越堆越多
    const target = fresh[fresh.length - 1]
    const video = await resolveVideo(target.aid, cookie)
    const draft = await generateReply(
      ctx.llm,
      cfg.personaPrompt,
      { ...target, ...video, provider: cfg.provider, model: cfg.model },
      undefined,
    )
    const message = tidyReply(draft, maxChars)
    if (!message) {
      log(`@ 监听：模型没给出内容，跳过 rpid=${target.rpid}`)
      return
    }
    const where = `《${video.title ?? target.title ?? target.aid}》`

    if (dryRun) {
      state.seen[target.rpid] = { at: target.at ?? new Date().toISOString(), dryRun: true, text: message }
      state.count = Number(state.count || 0) + 1
      state.lastAt = Date.now()
      await writeJson(stateFile, state)
      log(`[dryRun] 本会回 ${target.from} 在${where}下的 @ → 「${message}」`)
      return
    }

    const replyId = await postReply({ cookie, csrf, aid: target.aid, root: target.rpid, message, signal: undefined })
    state.seen[target.rpid] = { at: target.at ?? new Date().toISOString(), replyId: String(replyId ?? ''), text: message }
    state.count = Number(state.count || 0) + 1
    state.lastAt = Date.now()
    await writeJson(stateFile, state)
    log(`回了 ${target.from} 在${where}下的 @ → 「${message}」（rpid=${replyId}）`)
  }

  const guard = (label) => () => {
    tick().catch((error) => log(`${label}异常：${error?.message ?? error}`))
  }

  function stop() {
    if (timer) clearInterval(timer)
    if (kick) clearTimeout(kick)
    timer = null
    kick = null
  }

  /** 按当前配置（重新）起表；改参数后调它一次即可，不用重启 DSH */
  function start() {
    stop()
    const cfg = getConfig()
    if (cfg.enabled === false) {
      log('定时器：配置里关着（enabled=false），不启动')
      return false
    }
    const intervalMinutes = Math.max(1, Number(cfg.intervalMinutes) || DEFAULTS.intervalMinutes)
    timer = setInterval(guard('定时器'), intervalMinutes * 60_000)
    timer.unref?.()
    // 启动 15 秒后先看一次，省得刚开完就要等一整个周期
    kick = setTimeout(guard('首跳'), 15_000)
    kick.unref?.()
    log(
      `定时器已启动：每 ${intervalMinutes} 分钟查一次 · 每天上限 ${Math.max(0, Number(cfg.maxPerDay) || 0)} 条`
        + ` · 间隔 ≥${Math.max(1, Number(cfg.minGapMinutes) || DEFAULTS.minGapMinutes)} 分钟`
        + ` · ${cfg.dryRun === true ? 'dryRun（只写草稿）' : '真的会发'}`
        + ` · ${cfg.includeOthers === true ? '含陌生人' : '只回白名单'}`,
    )
    return true
  }

  start()
  ctx.effect(() => () => stop(), 'dsh-fish-atme: 定时器')
  return { start, stop, running: () => timer !== null }
}

/* ─────────────── 插件入口 ─────────────── */

export function apply(ctx, rawConfig = {}) {
  const entryConfig = normalizeConfig(rawConfig)
  const home = resolveHome(entryConfig)
  const configFile = join(home, 'fish-atme-config.json')
  const logFile = join(home, 'fish-atme.log')
  const stateFile = join(home, 'fish-atme-state.json')
  const log = (line) => appendLog(logFile, line)

  // 设置页存的覆盖 > patch 里的初始值 > DEFAULTS。用同一个可变对象，改完就地生效
  const readOverrides = () => {
    try {
      const saved = JSON.parse(readFileSync(configFile, 'utf8'))
      return saved && typeof saved === 'object' ? saved : {}
    } catch {
      return {}
    }
  }
  const config = normalizeConfig({ ...entryConfig, ...readOverrides() })
  const reloadConfig = () => {
    Object.assign(config, normalizeConfig({ ...entryConfig, ...readOverrides() }))
    return config
  }

  /* 工具一：读「@我的」 */
  ctx.tools.register({
    name: 'bili_at_me',
    description: '读取当前登录的 B 站账号「@我的」消息，最新在前。返回发送者、评论原文、BV 号与标题、rpid。只读，不会发评论。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回几条，默认 10，范围 1-30' },
        debug: { type: 'boolean', description: '调试用：原样返回接口原始数据' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                mid: { type: 'string' },
                text: { type: 'string' },
                bvid: { type: 'string' },
                title: { type: 'string' },
                rpid: { type: 'string' },
                at: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          note: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        const lines = []
        for (const item of value?.items ?? []) {
          const link = item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : item.uri ?? ''
          const when = item.at ? new Date(item.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未知'
          lines.push(`- ${item.from} 在《${item.title ?? item.bvid ?? '未知视频'}》里 @ 了你（${when}）`)
          lines.push(`  评论：${item.text || '(空)'}`)
          if (link) lines.push(`  链接：${link}`)
          if (item.rpid) lines.push(`  rpid：${item.rpid}（可用 bili_reply 回复这条）`)
        }
        if (lines.length === 0) lines.push('没有新的 @ 消息。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const limit = Math.min(Math.max(Number(args?.limit ?? 10) || 10, 1), 30)
      const { cookie } = await cookieHeader(config)
      const rawItems = await fetchAtItems(cookie, exec.signal)
      if (args?.debug) return compact({ ok: true, count: rawItems.length, raw: rawItems.slice(0, 3) })
      const items = []
      for (const raw of rawItems.slice(0, limit)) {
        const base = normalize(raw)
        const video = await resolveVideo(base.aid, cookie, exec.signal)
        items.push(compact({ ...base, ...video }))
      }
      return compact({
        ok: true,
        count: items.length,
        items,
        note: rawItems.length === 0 ? '消息列表为空：可能确实没有新 @，也可能接口需要额外参数。' : undefined,
      })
    },
  })

  /* 工具二：只生成不发（调语气用） */
  ctx.tools.register({
    name: 'bili_at_me_draft',
    description: '给某条「@我的」生成一条回复草稿，只生成不发送。rpid 用 bili_at_me 返回的值；不填就挑最新一条。',
    parameters: {
      type: 'object',
      properties: {
        rpid: { type: 'string', description: '要回复的那条评论的 rpid' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          rpid: { type: 'string' },
          video: { type: 'string' },
          hisText: { type: 'string' },
          draft: { type: 'string' },
          tidied: { type: 'string' },
          willSend: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (!value?.ok) return [{ type: 'text', text: '没生成出来。' }]
        return [{
          type: 'text',
          text: [
            `《${value.video ?? '未知视频'}》`,
            `他写的：${value.hisText ?? ''}`,
            '',
            `草稿（截到 ${DEFAULTS.maxChars} 字口径）：${value.tidied ?? value.draft ?? ''}`,
            `定时器现在：${value.willSend ? '会真的发' : 'dryRun，只写草稿'}`,
          ].join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const { cookie, meUid } = await cookieHeader(config)
      const items = await fetchAtItems(cookie, exec.signal).then((list) => list.map(normalize))
      const wanted = args?.rpid === undefined ? undefined : String(args.rpid)
      const fallback = meUid
        ? items.find((item) => String(item.mid) === String(meUid))
        : items[0]
      const target = wanted ? items.find((item) => item.rpid === wanted) : fallback ?? items[0]
      if (!target) throw new Error('没找到这条 @（rpid 对不上？先跑一次 bili_at_me 看看）')
      const video = await resolveVideo(target.aid, cookie, exec.signal)
      const draft = await generateReply(
        ctx.llm,
        config.personaPrompt,
        { ...target, ...video, provider: config.provider, model: config.model },
        exec.signal,
      )
      return compact({
        ok: true,
        rpid: target.rpid,
        video: video.title ?? target.title,
        hisText: target.text,
        draft,
        tidied: tidyReply(draft, Math.max(20, Number(config.maxChars) || DEFAULTS.maxChars)),
        willSend: config.dryRun !== true,
      })
    },
  })

  /* 工具三：状态 */
  ctx.tools.register({
    name: 'bili_at_me_status',
    description: '看「回 @」插件的状态：定时器开没开、今天回了几条、去重表里记了哪些、日志在哪。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (!value?.ok) return [{ type: 'text', text: '读不到状态。' }]
        return [{
          type: 'text',
          text: [
            `定时器：${value.enabled ? `开（每 ${value.intervalMinutes} 分钟）` : '关'}`,
            `今天：${value.count}/${value.maxPerDay} 条${value.dryRun ? '（dryRun，只写草稿）' : ''}`,
            `去重表：${value.seenCount} 条`,
            `最近一条：${value.lastText ?? '(无)'}`,
            `状态文件：${value.stateFile}`,
            `日志：${value.logFile}`,
          ].join('\n'),
        }]
      },
    },
    async execute() {
      const state = await readJson(stateFile, { seen: {}, day: '', count: 0, lastAt: 0 })
      const entries = Object.entries(state.seen ?? {})
      const last = entries.length > 0 ? entries[entries.length - 1][1] : undefined
      return compact({
        ok: true,
        enabled: config.enabled !== false,
        intervalMinutes: Number(config.intervalMinutes) || DEFAULTS.intervalMinutes,
        maxPerDay: Number(config.maxPerDay) || 0,
        dryRun: config.dryRun === true,
        day: state.day ?? '',
        count: state.day === dayKey() ? Number(state.count || 0) : 0,
        seenCount: entries.length,
        lastText: last?.text,
        stateFile,
        logFile,
      })
    },
  })

  let watcher = null
  try {
    // getConfig 每次都重读一遍配置文件 ⇒ 手改 fish-atme-config.json 也能下一跳生效
    watcher = createWatcher(ctx, () => { reloadConfig(); return config })
  } catch (error) {
    log(`定时器没启动起来（已兜住）：${error?.stack ?? error}`)
  }

  /* ───────── 设置页用的 HTTP 接口 ───────── */
  const sendJson = (res, code, payload) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers.host || '')
      if (!host) return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const pick = String(req.headers.origin || req.headers.referer || '')
      if (!pick) return true
      try {
        const u = new URL(pick)
        if (String(u.host || '').toLowerCase() === String(host).toLowerCase()) return true
        const withPort = (u.hostname + ':' + (u.port || (u.protocol === 'https:' ? '443' : '80'))).toLowerCase()
        return withPort === String(host).toLowerCase()
      } catch {
        return false
      }
    } catch {
      return false
    }
  }

  // 宿主自己的信任栅栏（认 cookie/token）—— 拿不到就退回本机同源那一道
  let fenceCache
  const getConnection = () => {
    if (fenceCache !== undefined) return fenceCache
    fenceCache = null
    const tries = [
      () => (typeof ctx.get === 'function' ? ctx.get('connection') : null),
      () => Reflect.get(ctx, 'connection'),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root.connection : null),
    ]
    for (const pick of tries) {
      try {
        const conn = pick()
        if (conn && typeof conn.requestRejection === 'function') {
          fenceCache = conn
          break
        }
      } catch {
        /* 换下一个写法 */
      }
    }
    return fenceCache
  }

  const fenceReject = (req, res) => {
    const conn = getConnection()
    if (!conn) return false
    try {
      const rejection = conn.requestRejection({ headers: req.headers })
      if (rejection === undefined) return false
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      try { res.end() } catch { /* 忽略 */ }
      return true
    } catch {
      res.statusCode = 403
      try { res.end() } catch { /* 忽略 */ }
      return true
    }
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) reject(new Error('请求体太大'))
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })

  const readLogTail = async (lines = 12) => {
    try {
      const text = await readFile(logFile, 'utf8')
      return text.trim().split('\n').slice(-lines)
    } catch {
      return []
    }
  }

  const snapshot = async () => {
    const state = await readJson(stateFile, { seen: {}, day: '', count: 0, lastAt: 0 })
    const entries = Object.entries(state.seen ?? {})
    return {
      ok: true,
      config: {
        enabled: config.enabled !== false,
        intervalMinutes: config.intervalMinutes,
        maxPerDay: config.maxPerDay,
        minGapMinutes: config.minGapMinutes,
        maxChars: config.maxChars,
        allowUids: config.allowUids ?? [],
        includeOthers: config.includeOthers === true,
        dryRun: config.dryRun === true,
        provider: config.provider,
        model: config.model,
        personaPrompt: config.personaPrompt ?? '',
        credentialPath: config.credentialPath ?? '',
        home: config.home ?? '',
      },
      status: {
        day: state.day ?? '',
        count: state.day === dayKey() ? Number(state.count || 0) : 0,
        seenCount: entries.length,
        lastAt: Number(state.lastAt || 0),
        timerRunning: watcher ? watcher.running() : false,
        lastText: entries.length > 0 ? entries[entries.length - 1][1]?.text : undefined,
      },
      logTail: await readLogTail(),
      files: { stateFile, logFile, configFile },
    }
  }

  const handleApi = async (req, res, url) => {
    const path = url.pathname.replace(/^\/api\/fish-atme/, '') || '/'

    if (req.method === 'GET' && (path === '/' || path === '/state')) {
      return sendJson(res, 200, await snapshot())
    }

    if (req.method === 'POST' && path === '/config') {
      const body = await readBody(req)
      const patch = body?.config && typeof body.config === 'object' ? body.config : body
      const saved = { ...readOverrides() }
      for (const key of Object.keys(DEFAULTS)) {
        if (!(key in (patch ?? {}))) continue
        const value = patch[key]
        saved[key] = Array.isArray(value) ? value.map(String) : value
      }
      await writeJson(configFile, saved)
      reloadConfig()
      const running = watcher ? watcher.start() : false
      log('设置页改了参数：' + Object.keys(saved).join(',') + (running ? '（定时器已按新参数重启）' : '（定时器当前关着）'))
      return sendJson(res, 200, await snapshot())
    }

    if (req.method === 'POST' && path === '/draft') {
      const state = await readJson(stateFile, { seen: {} })
      const { cookie, meUid } = await cookieHeader(config)
      const items = (await fetchAtItems(cookie)).map(normalize)
      const allowed = allowSet(config, meUid)
      const target = items.find((item) => allowed.has(String(item.mid))) ?? items[0]
      if (!target) return sendJson(res, 200, { ok: false, error: '现在没有 @ 可以拿来试' })
      const video = await resolveVideo(target.aid, cookie)
      const draft = await generateReply(
        ctx.llm,
        config.personaPrompt,
        { ...target, ...video, provider: config.provider, model: config.model },
        undefined,
      )
      return sendJson(res, 200, {
        ok: true,
        video: video.title ?? target.title,
        hisText: target.text,
        draft,
        tidied: tidyReply(draft, Math.max(20, Number(config.maxChars) || DEFAULTS.maxChars)),
        alreadyReplied: Boolean(state.seen?.[target.rpid]),
        willSend: config.dryRun !== true,
      })
    }

    return sendJson(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + path })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/fish-atme',
      handler: async (req, res) => {
        if (fenceReject(req, res)) return
        if (!sameOriginOk(req)) {
          try { sendJson(res, 403, { ok: false, error: '只接受本机同源请求' }) } catch { /* 忽略 */ }
          return
        }
        try {
          await handleApi(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (error) {
          try { sendJson(res, 500, { ok: false, error: error?.message ?? String(error) }) } catch { /* 忽略 */ }
        }
      },
    }), 'dsh-fish-atme: /api/fish-atme 路由')
  } catch (error) {
    log(`HTTP 路由没挂上：${error?.message ?? error}`)
  }
}

// 测试出口（宿主不读它）
export const __test__ = { tidyReply, normalize, postReply, generateReply, resolveHome, allowSet, DEFAULTS }
