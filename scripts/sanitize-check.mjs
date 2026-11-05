#!/usr/bin/env node
/**
 * scripts/sanitize-check.mjs —— 推送前脱敏体检
 * ============================================================================
 * 干什么
 *   扫一遍要被提交的文件，找出「不该进仓库」的东西：cookie / csrf / UID /
 *   本机绝对路径 / 邮箱 / API Key / 明文口令 / 运行时产物。
 *   命中任意一条 → 退出码 1（git 提交会被 pre-commit 钩子拦下）。
 *
 * 怎么用
 *   node scripts/sanitize-check.mjs                 # 查暂存区（默认，提交时用）
 *   node scripts/sanitize-check.mjs --all           # 查工作区全部受版本控制的文件
 *   node scripts/sanitize-check.mjs --fix           # 只报告，不自动改（本脚本从不改文件）
 *
 * 设计原则
 *   - **只读**：不改任何文件，不联网，不执行别的东西。
 *   - 白名单优先：先剔除明显的公开域名/许可证链接，再报真问题，避免狼来了。
 *   - 规则集中在这一处；以后加规则只改 RULES。
 * ============================================================================
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|zip|gz|woff2?|ttf|mp4|mp3)$/i
const SKIP_PATH = /^(node_modules|\.git)\//

/** 这些域名出现在正文里是正常的（开源地址 / 规范链接 / B 站接口），不算泄露 */
const SAFE_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'semver.org',
  'keepachangelog.com',
  'example.com',
  'bilibili.com',
  'b23.tv',
  'deepseek.com',
  'opensource.org',
  'nodejs.org',
  'npmjs.com',
]

/** 测试里常见的假值：全大写占位、纯 x、常见 dummy 数字。真值是混大小写+数字+% 的 */
const DUMMY_TOKEN = /^(?:[A-Z][A-Z_\-]*|x+|0+|\.+|REDACTED|<[^>]+>|\$\{[^}]+\})$/i
const DUMMY_UIDS = new Set(['12345678', '123456789', '1234567890', '10000000', '0', '1'])
const valueOf = (hit) => hit.split(/[=:]\s*["']?/).pop().replace(/["'`,;)\]]+$/, '')

const RULES = [
  {
    id: 'bili-sessdata',
    why: 'B 站 SESSDATA（等于登录态）',
    re: /SESSDATA\s*[=:]\s*["']?[A-Za-z0-9%*_\-]{8,}/gi,
    allow: (hit) => DUMMY_TOKEN.test(valueOf(hit)),
  },
  {
    id: 'bili-csrf',
    why: 'B 站 bili_jct / csrf（能替你发言）',
    re: /bili_jct\s*[=:]\s*["']?[0-9a-f]{16,}/gi,
    allow: (hit) => /^(?:0+|f+|deadbeef|REDACTED)$/i.test(valueOf(hit)),
  },
  {
    id: 'bili-uid',
    why: '硬编码的 B 站 UID（会暴露账号）',
    re: /(?:allowUids|dedeuserid|DedeUserID|space\.bilibili\.com\/)\D{0,6}\d{5,}/g,
    allow: (hit) => {
      const digits = hit.match(/\d{5,}$/)?.[0]
      return digits !== undefined && DUMMY_UIDS.has(digits)
    },
  },
  {
    id: 'cookie-literal',
    why: '明文 cookie 串',
    re: /cookie\s*[=:]\s*["'`][^"'`\n]*(?:SESSDATA|bili_jct|DedeUserID)[^"'`\n]*["'`]/gi,
    allow: (hit) => /SESSDATA=x["'`]?$/i.test(hit),
  },
  {
    id: 'local-path',
    why: '本机绝对路径（用户名/盘符）',
    re: /[A-Za-z]:[\\/](?:Users|DeepseekHarness)[\\/][^\s"'`)]*/g,
  },
  {
    id: 'email',
    why: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allow: (hit) => SAFE_DOMAINS.some((d) => hit.toLowerCase().endsWith(`@${d}`)),
  },
  {
    id: 'secret-assign',
    why: '明文密钥/口令赋值',
    re: /\b(?:api[_-]?key|appsecret|app_secret|secret|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key)\b\s*[=:]\s*["'`][^"'`\n]{8,}["'`]/gi,
    allow: (hit) => /["'`](?:__FROM_ENV__|<[^>]+>|\$\{[^}]+\}|YOUR[_\w]*|xxx+|redacted|changeme)["'`]/i.test(hit),
  },
  {
    id: 'long-hex-token',
    why: '疑似 32 位以上令牌/哈希',
    re: /\b[0-9a-f]{32,}\b/g,
    allow: (hit) => /^(?:0+|deadbeef|f{32,})$/i.test(hit),
  },
  {
    id: 'runtime-artifact',
    why: '运行时产物不该进仓库',
    re: /^(?:fish-atme-state\.json|fish-atme-config\.json|bili_credential\.json|.*credential.*\.json|.*\.log)$/i,
    onPath: true,
  },
]

const args = process.argv.slice(2)
const scanAll = args.includes('--all')

function listFiles() {
  if (scanAll) {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  // 默认只看暂存区（pre-commit 时索引就是要提交的内容）
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' })
    const staged = out.split('\n').map((s) => s.trim()).filter(Boolean)
    if (staged.length > 0) return staged
  } catch {
    /* 不是 git 仓库就退回全量 */
  }
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
}

const files = listFiles().filter((f) => !SKIP_PATH.test(f) && !SKIP_EXT.test(f))
const findings = []

for (const file of files) {
  for (const rule of RULES) {
    if (rule.onPath) {
      if (rule.re.test(file)) findings.push({ file, line: 0, rule, hit: file })
      continue
    }
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      rule.re.lastIndex = 0
      if (!rule.re.test(line)) return
      rule.re.lastIndex = 0
      let match
      while ((match = rule.re.exec(line)) !== null) {
        const hit = match[0]
        if (rule.allow && rule.allow(hit)) continue
        findings.push({ file, line: index + 1, rule, hit })
      }
    })
  }
}

if (findings.length === 0) {
  console.log(`✓ 脱敏体检通过：扫了 ${files.length} 个文件，没有命中敏感规则`)
  process.exit(0)
}

console.error(`✗ 脱敏体检没通过：${findings.length} 处需要处理\n`)
for (const f of findings) {
  const where = f.line > 0 ? `${f.file}:${f.line}` : f.file
  console.error(`  [${f.rule.id}] ${where}\n      为什么不行：${f.rule.why}\n      命中内容：${f.hit.slice(0, 120)}`)
}
console.error('\n处理办法：把真值换成占位符（<YOUR_UID> / __FROM_ENV__ / 相对路径），确认无误后重新提交。')
process.exit(1)
