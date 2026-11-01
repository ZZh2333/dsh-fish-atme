/**
 * lib/schema.mjs —— 拿 `@deepseek-ai/schemastery`（Config 要用它）
 * ============================================================================
 * 为什么不能直接 `import '@deepseek-ai/schemastery'`：
 *   本插件装在 `~/.dsh/plugins/dsh-fish-atme`，Node 的模块解析只往上找
 *   `~/.dsh/plugins/node_modules`、`~/.dsh/node_modules`……而 schemastery 在
 *   `~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/` 里 —— 那条路径**不在**解析链上。
 *
 * 做法（跟 dsh-bili-scroll 的 hostdeps 一个思路）：
 *   ① 先试裸 import（web profile / 别人机器上可能装得上）；
 *   ② 再扫 `~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/schemastery`（桌面版就在这里）；
 *   ③ 都拿不到就返回 null —— **插件照常加载**，只是没有 Config、设置页不显示参数。
 *      宁可少一个设置面板，也不能因为一个 import 让整条插件不激活 ✗
 * ============================================================================
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const CANDIDATE_SUBPATHS = [
  'lib/index.mjs',
  'lib/index.js',
  'index.mjs',
  'index.js',
]

function profileRoots() {
  const roots = []
  const push = (p) => {
    if (p && !roots.includes(p)) roots.push(p)
  }
  push(process.env.DSH_HOST_MODULES)
  const home = homedir()
  push(join(home, '.dsh', 'node_modules'))
  const profiles = join(home, '.dsh', 'profiles')
  try {
    for (const name of readdirSync(profiles)) {
      push(join(profiles, name, 'node_modules'))
    }
  } catch {
    /* 没有 profiles 目录就算了 */
  }
  return roots
}

async function fromDisk() {
  for (const root of profileRoots()) {
    const pkgDir = join(root, '@deepseek-ai', 'schemastery')
    for (const sub of CANDIDATE_SUBPATHS) {
      const file = join(pkgDir, sub)
      if (!existsSync(file)) continue
      try {
        const mod = await import(pathToFileURL(file).href)
        const z = mod?.default ?? mod
        if (z && typeof z.object === 'function') return z
      } catch {
        /* 这个路径不行就试下一个 */
      }
    }
  }
  return null
}

let cached
let resolved = false

export async function loadSchemastery() {
  if (resolved) return cached
  resolved = true
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const z = mod?.default ?? mod
    if (z && typeof z.object === 'function') {
      cached = z
      return cached
    }
  } catch {
    /* 解析不到就走磁盘 */
  }
  cached = await fromDisk()
  return cached
}
