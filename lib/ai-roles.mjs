/**
 * ai-roles.mjs —— 按角色配置调用模型（面板「AI 生成/补全」的服务端）
 *
 * 角色来自 novel/roles.yml（文心八角色）。每个角色可有独立 provider/model/
 * base_url；api_key 从环境变量 api_key_env 读取，不落盘。
 * 调用走 OpenAI 兼容的 /chat/completions。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 解析 Codex CLI 路径：优先 CODEX_BIN，其次 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
 * 里最新的一份（Codex 更新会把新 CLI 放这里，PATH 上的 codex 可能仍是旧版），最后回退 PATH。
 */
export function resolveCodexBin() {
  const env = process.env.CODEX_BIN
  if (env && existsSync(env)) return env
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const base = path.join(localAppData, 'OpenAI', 'Codex', 'bin')
  try {
    let best = null
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const p = path.join(base, d.name, 'codex.exe')
      if (!existsSync(p)) continue
      const mtime = statSync(p).mtimeMs
      if (!best || mtime > best.mtime) best = { p, mtime }
    }
    if (best) return best.p
  } catch {
    /* ignore */
  }
  return 'codex'
}

/** 各编辑面的默认角色与提示规则（surface → { role, rule }）。 */
export const SURFACE_RULES = {
  chapter: { role: 'writer', rule: '写章节正文。直接输出可用的正文；段落之间空行；不要写章纲、说明或标题。' },
  outline: { role: 'director', rule: '写章纲：本章目标、节拍、出场角色、需埋/需收伏笔、与前章接口，以及「## 钩子」（类型 + 内容）。' },
  project: { role: 'architect', rule: '写书稿元信息（书名/题材/一句话简介等），简洁、可直接引用。' },
  style: { role: 'stylist', rule: '写写作风格基准：人称视角、语言基调、对话腔、描写密度、禁忌项。' },
  source: { role: 'chief-editor', rule: '按该文件的数据规范补全内容。' },
  character: { role: 'chief-editor', rule: '写角色卡字段（身份/性格/动机/能力边界/行为红线），具体可用。' },
  world: { role: 'chief-editor', rule: '写世界观条目，规则边界清晰。' },
  foreshadow: { role: 'continuity', rule: '写伏笔台账条目（id/标题/状态/优先级/埋设章/预期回收/备注）。' },
  research: { role: 'research', rule: '整理考据结论，区分史实/通说/演义并附来源。' },
}

/** 默认角色（surface 缺省时）。 */
export function defaultRoleForSurface(surface) {
  return (SURFACE_RULES[surface] && SURFACE_RULES[surface].role) || 'writer'
}

/** 带状态码的错误（路由层按 statusCode 回 JSON）。 */
export class AiError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'AiError'
    this.statusCode = statusCode
  }
}

/** 组装 system prompt：角色职责 + 编辑面规则 + 写作风格基准 + 书稿元信息。 */
export function buildSystemPrompt({ role, surface, styleText, projectText }) {
  const surfaceRule = (SURFACE_RULES[surface] && SURFACE_RULES[surface].rule) || ''
  const parts = [
    `你是「文心工作台」的${role.label}（${role.id}）。`,
    role.instruction || '',
    surfaceRule,
    styleText ? `写作风格基准：\n${styleText}` : '',
    projectText ? `书稿元信息：\n${projectText}` : '',
    '只输出可直接填入编辑器的内容：不要解释、不要用代码围栏、不要加多余标题。',
  ]
  return parts.filter((p) => typeof p === 'string' && p.trim() !== '').join('\n\n')
}

/** 组装 user prompt：生成（全新一版）或补全（只给新增部分）。 */
export function buildUserPrompt({ mode, text, instruction, surface }) {
  const label = (SURFACE_RULES[surface] && SURFACE_RULES[surface].role) || '内容'
  const extra = typeof instruction === 'string' && instruction.trim() !== '' ? `\n补充要求：${instruction.trim()}` : ''
  if (mode === 'complete') {
    return [
      '请补全/续写下面的内容。要求：',
      '1. 只输出需要追加到末尾的新增部分，不要重复已有内容；',
      '2. 保持人物、设定、时间线与文风一致；',
      '3. 直接输出新增正文，不要任何说明。',
      extra,
      '',
      '现有内容：',
      text && text.trim() !== '' ? text : '（空，请从开头补全）',
    ].join('\n')
  }
  return [
    `请为「${label}」生成一版内容。`,
    '要求：直接输出最终内容，不要解释；符合该书的世界观、人物与风格。',
    extra,
    text && text.trim() !== '' ? `\n参考现有内容（可改写）：\n${text}` : '',
  ].join('\n')
}

/**
 * 用 Codex CLI（ChatGPT/Codex 订阅登录）生成，不走 OpenAI API 计费。
 * @param {{role:object, system:string, user:string, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
export function runCodexCompletion({ role, system, user, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wenxin-codex-'))
    const outFile = path.join(dir, 'last.md')
    const prompt = `${system}\n\n${user}`
    const bin = resolveCodexBin()
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-s', 'read-only', '-C', dir, '-o', outFile]
    // 快速模式：thinking effort 由角色配置决定（default 则沿用 Codex 原生 config）。
    const effort = String(role.reasoning_effort || '').trim()
    if (['minimal', 'low', 'medium', 'high'].includes(effort)) args.push('-c', `model_reasoning_effort="${effort}"`)
    const model = String(role.model || '').trim()
    if (model !== '' && model !== 'codex' && model !== 'codex-cli') args.push('-m', model)
    args.push('-')

    let stderr = ''
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      reject(new AiError(502, `无法启动 codex：${err?.message || String(err)}`))
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, timeoutMs)
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      reject(new AiError(502, `codex 启动失败：${err?.message || String(err)}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        if (existsSync(outFile)) {
          const text = readFileSync(outFile, 'utf8').trim()
          rmSync(dir, { recursive: true, force: true })
          if (text !== '') {
            resolve(text)
            return
          }
        }
      } catch {
        /* fall through */
      }
      rmSync(dir, { recursive: true, force: true })
      reject(new AiError(502, `codex 退出码 ${code}${stderr ? '：' + stderr.slice(0, 200) : ''}`))
    })
    child.stdin.end(prompt)
  })
}

/**
 * 调用角色模型。
 * @param {{role:object, system:string, user:string, env?:object, timeoutMs?:number}} opts
 * @returns {Promise<string>}
 */
export async function runRoleCompletion({ role, system, user, env = process.env, timeoutMs = 120000 }) {
  if (role.provider === 'codex' || role.provider === 'codex-cli') {
    return runCodexCompletion({ role, system, user, timeoutMs: Math.max(timeoutMs, 180000) })
  }
  const baseUrl = String(role.base_url || env.DSH_AI_BASE_URL || '').trim().replace(/\/+$/, '')
  const model = String(role.model || env.DSH_AI_MODEL || '').trim()
  const keyName = String(role.api_key_env || '').trim()
  const apiKey = (keyName && env[keyName]) || env.DSH_AI_API_KEY || env.OPENAI_API_KEY || ''
  if (!baseUrl) throw new AiError(422, `角色「${role.label}」未配置接口地址（roles.yml 的 base_url）`)
  if (!model) throw new AiError(422, `角色「${role.label}」未配置模型（roles.yml 的 model）`)
  if (!apiKey) throw new AiError(422, `角色「${role.label}」未配置密钥（环境变量 ${keyName || 'DSH_AI_API_KEY'}）`)

  let res
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.8,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new AiError(502, `模型接口请求失败：${err?.message || String(err)}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiError(502, `模型接口返回 ${res.status}：${body.slice(0, 200)}`)
  }
  const data = await res.json().catch(() => null)
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (typeof text !== 'string' || text.trim() === '') throw new AiError(502, '模型未返回有效内容')
  return text.trim()
}
