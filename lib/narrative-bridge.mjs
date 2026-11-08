/**
 * narrative-bridge.mjs —— 叙事工坊 workbench.sqlite3 → novel/ 结构桥接
 *
 * 叙事工坊（src/AutoAI）把作品存在 SQLite 的 projects 表（JSON）与 settings 表；
 * 本模块用 node:sqlite 只读打开，把一部作品迁移成毛颖的 novel/ 结构：
 *   project.yml / volumes.yml / chapters/ / outlines/ / roles.yml
 * 密钥不迁移（叙事工坊的 api_key 加密存储，桥接只写环境变量名 api_key_env）。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_ROLES, toYaml } from './roles.mjs'

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

const SLOT_BY_KIND = { outline: 'outline', plan: 'outline', draft: 'draft', polish: 'review', review: 'review' }

function openDb(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') throw new Error('缺少 workbench.sqlite3 路径')
  const p = path.resolve(dbPath)
  if (!existsSync(p)) throw new Error(`数据库不存在：${p}`)
  try {
    return { db: new DatabaseSync(p, { readOnly: true }), path: p }
  } catch {
    return { db: new DatabaseSync(p), path: p }
  }
}

function readJsonRows(db, sql) {
  const rows = db.prepare(sql).all()
  return rows.map((r) => {
    try {
      return JSON.parse(r.data)
    } catch {
      return null
    }
  }).filter(Boolean)
}

/** 列出库里所有作品标题（导入 UI 的下拉数据源）。 */
export function listWorkbenchTitles(dbPath) {
  const { db } = openDb(dbPath)
  try {
    return readJsonRows(db, 'SELECT data FROM projects')
      .map((p) => (typeof p.title === 'string' ? p.title : ''))
      .filter(Boolean)
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 从 outline 文本解析分卷：`卷一 · 他人之名（第 1–21 章）`。 */
function parseVolumes(outline) {
  const text = typeof outline === 'string' ? outline : ''
  const re = /卷\s*([一二三四五六七八九十]+)\s*·\s*([^（(]+)[（(]\s*第\s*(\d+)\s*[–\-—~～至]\s*(\d+)\s*章/g
  const out = []
  let m
  while ((m = re.exec(text))) {
    const num = CN_NUM[m[1]] ?? 0
    if (num <= 0) continue
    out.push({ num, title: `第${m[1]}卷 ${m[2].trim()}`, from: Number(m[3]), to: Number(m[4]) })
  }
  return out
}

function chapterContent(ch) {
  let content = ''
  for (const v of ch.versions || []) {
    if (typeof v?.content === 'string' && v.content.trim() !== '') content = v.content
  }
  return content
}

function cjk(text) {
  let n = 0
  for (const ch of String(text || '')) {
    if (ch >= '\u4e00' && ch <= '\u9fff') n++
  }
  return n
}

function yamlScalar(v) {
  const s = v === undefined || v === null ? '' : String(v)
  return s
}

function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

function roleConfigFromSettings(settings) {
  const list = settings && Array.isArray(settings.roles) ? settings.roles : null
  if (!list || list.length === 0) return DEFAULT_ROLES.map((r) => ({ ...r }))
  return list.map((r) => {
    const id = String(r.id || 'role').trim() || 'role'
    return {
      id,
      label: String(r.name || id).trim() || id,
      kind: ['outline', 'plan', 'draft', 'polish', 'review'].includes(r.kind) ? r.kind : 'draft',
      slot: SLOT_BY_KIND[r.kind] ?? 'draft',
      provider: String(r.provider || 'openai_compatible'),
      model: String(r.model || ''),
      base_url: String(r.base_url || ''),
      api_key_env: `DSH_ROLE_${id.toUpperCase()}_KEY`,
      enabled: r.enabled !== false,
      instruction: String(r.instructions || '').trim(),
    }
  })
}

/**
 * 导入一部作品。
 * @param {{dbPath:string, novelDir:string, title?:string, overwrite?:boolean}} opts
 * @returns {{ok:true, title:string, chapters:number, written:number, volumes:number, roles:number}}
 */
export function importFromWorkbench({ dbPath, novelDir, title, overwrite = false }) {
  if (typeof novelDir !== 'string' || novelDir.trim() === '') throw new Error('缺少 novel 目录')
  const dir = path.resolve(novelDir)
  if (existsSync(path.join(dir, 'project.yml')) && !overwrite) {
    throw new Error(`目标 novel 目录已有 project.yml：${dir}（加 --overwrite 覆盖，或换 --dir）`)
  }

  const { db } = openDb(dbPath)
  let projects
  let settings = null
  try {
    projects = readJsonRows(db, 'SELECT data FROM projects')
    const sRow = db.prepare('SELECT data FROM settings WHERE id = 1').get()
    if (sRow && typeof sRow.data === 'string') {
      try { settings = JSON.parse(sRow.data) } catch { settings = null }
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }

  const project = title
    ? projects.find((p) => p && p.title === title)
    : projects[0]
  if (!project) throw new Error(title ? `未找到作品：${title}` : '数据库里没有作品')

  const chapters = Array.isArray(project.chapters) ? project.chapters : []
  const maxNum = chapters.reduce((m, c) => Math.max(m, Number(c?.number) || 0), 0)
  let volumes = parseVolumes(project.outline)
  if (volumes.length === 0) volumes = [{ num: 1, title: '第1卷', from: 1, to: Math.max(maxNum, 1) }]
  const volOf = (n) => {
    const v = volumes.find((x) => n >= x.from && n <= x.to)
    return `v${String(v ? v.num : 1).padStart(2, '0')}`
  }

  // project.yml
  const genre = yamlScalar(project.genre)
  const targetWords = Number(project.target_words) || (maxNum * 3000)
  const lenText = `约${Math.round(targetWords / 1000)}千字 / ${chapters.length}章 / ${volumes.length}卷`
  const projectYml = [
    '# project.yml —— 书稿元信息（平键，无嵌套）。',
    `title: ${yamlScalar(project.title || '未命名书稿')}`,
    'author: ""',
    `genre: ${genre}`,
    `length: ${lenText}`,
    'language: zh',
    'phase: setting',
    'mode: ai-draft',
    `description: ${yamlScalar(project.brief || '')}`,
    '',
  ].join('\n')
  writeText(path.join(dir, 'project.yml'), projectYml)

  // volumes.yml
  const volLines = ['# volumes.yml —— 分卷规划（顶层数组，每卷一条）']
  for (const v of volumes) {
    volLines.push(`- id: v${String(v.num).padStart(2, '0')}`)
    volLines.push(`  title: ${v.title}`)
    volLines.push(`  summary: ${''}`)
    volLines.push(`  chapters: ${String(v.from).padStart(3, '0')}-${String(v.to).padStart(3, '0')}`)
  }
  writeText(path.join(dir, 'volumes.yml'), volLines.join('\n') + '\n')

  // chapters + outlines
  let written = 0
  for (const ch of chapters) {
    const num = Number(ch.number) || 0
    if (num <= 0) continue
    const v = volOf(num)
    const stem = `${v}-c${String(num).padStart(3, '0')}`
    const content = chapterContent(ch)
    const status = content.trim() ? 'writing' : 'pending'
    if (content.trim()) written++
    const plan = String(ch.plan || '').replace(/\n+/g, ' ').trim()
    const fm = [
      '---',
      `volume: ${v}`,
      `num: ${num}`,
      `title: ${yamlScalar(ch.title || stem)}`,
      `status: ${status}`,
      `summary: ${plan}`,
      'cognitive_frame: ""',
      'emotional_anchor: ""',
      'world_texture: ""',
      'suspense: ""',
      'interpersonal_tension: ""',
      '---',
      '',
    ].join('\n')
    writeText(path.join(dir, 'chapters', `${stem}.md`), fm + (content ? content + '\n' : ''))
    const outline = [
      `# 第 ${num} 章 ${ch.title || ''}`,
      '',
      `- 本章目标：${plan || '（待补）'}`,
      '- 节拍：（待补）',
      '- 出场角色：（待补）',
      '- 需埋/需收伏笔：（待补，对照 foreshadows.yml）',
      '- 与前章接口：（待补）',
      '',
      '## 钩子',
      '',
      '- 类型：（待定）',
      '- 内容：（待补）',
      '',
    ].join('\n')
    writeText(path.join(dir, 'outlines', `${stem}.md`), outline)
  }

  // roles.yml
  const roles = roleConfigFromSettings(settings)
  writeText(path.join(dir, 'roles.yml'), toYaml(roles))

  return { ok: true, title: project.title || '', chapters: chapters.length, written, volumes: volumes.length, roles: roles.length }
}
