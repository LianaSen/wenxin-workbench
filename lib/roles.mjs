/**
 * roles.mjs —— 八角色分模型 AI 调用配置（文心工作台）
 *
 * 合并毛颖（主编 / 设定管理员 / 素材调研员）与叙事工坊（故事策划 / 分章编剧 /
 * 正文作者 / 文风编辑 / 连续性审核 / 读者审稿）两套角色，去重后为 8 个：
 * 设定管理员并入主编（主编兼管设定与台账）。
 *
 * roles.yml 为唯一事实源：顶层数组、平键；api_key 不落明文，只存环境变量名
 * `api_key_env`。每个角色用 `slot` 映射编排槽位，主编按角色取 provider/model
 * 委派子代理；面板编辑面按角色做「一键生成/补全」。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { parseFlatYamlArray } from './novel-parse.mjs'

/** 角色 kind 枚举：编排 / 大纲 / 章纲 / 正文 / 润色 / 审核 / 考据。 */
export const ROLE_KINDS = ['orchestrate', 'outline', 'plan', 'draft', 'polish', 'review', 'research']

/** 编排槽位枚举（lore 保留给旧数据，新角色不再使用）。 */
export const ROLE_SLOTS = ['chief', 'outline', 'draft', 'review', 'lore', 'research']

/** 角色可编辑字段（roles-set 校验用）。 */
export const ROLE_FIELDS = ['id', 'label', 'kind', 'slot', 'provider', 'model', 'base_url', 'api_key_env', 'enabled', 'instruction']

/**
 * 八角色默认配置：
 *   1 主编（兼设定管理员）2 故事策划 3 分章编剧 4 正文作者
 *   5 文风编辑 6 连续性审核 7 读者审稿 8 素材调研员
 */
export const DEFAULT_ROLES = [
  {
    id: 'chief-editor', label: '主编', kind: 'orchestrate', slot: 'chief',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_CHIEF_EDITOR_KEY', enabled: true,
    instruction: '统筹全书：规划、衔接、验收、阶段推进与拍板；并兼管设定与台账——角色卡、世界观、伏笔、时间线、记忆、线索板的落盘与推进。只做规划与把关，不代写正文。',
  },
  {
    id: 'architect', label: '故事策划', kind: 'outline', slot: 'outline',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_ARCHITECT_KEY', enabled: true,
    instruction: '规划整本故事的核心冲突、人物欲望与代价、世界规则、起承转合、主线因果、人物弧线、分卷和明确结局。区分已确定事实与建议。',
  },
  {
    id: 'director', label: '分章编剧', kind: 'plan', slot: 'outline',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_DIRECTOR_KEY', enabled: true,
    instruction: '把本章纲要拆成能实际落笔的场景，写清人物目标、阻碍、选择、代价、局面变化与本章不能提前揭示的信息。保留已确认章纲。',
  },
  {
    id: 'writer', label: '正文作者', kind: 'draft', slot: 'draft',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_WRITER_KEY', enabled: true,
    instruction: '按本章任务写完整正文，以行动、对白和有作用的细节落实情节，人物按自身动机和已知信息行动，不用梗概代替正文。',
  },
  {
    id: 'stylist', label: '文风编辑', kind: 'polish', slot: 'review',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_STYLIST_KEY', enabled: true,
    instruction: '只编辑表达、句式节奏、段落、标点、具体动作与对话自然度，保留事件、因果、信息边界与原有叙述声音，拿不准就留原文。',
  },
  {
    id: 'continuity', label: '连续性审核', kind: 'review', slot: 'review',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_CONTINUITY_KEY', enabled: true,
    instruction: '只读审稿，检查设定、人物已知、时间线、因果、伏笔与润色保真，区分确定错误与需作者裁决的疑点。',
  },
  {
    id: 'reader', label: '读者审稿', kind: 'review', slot: 'review',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_READER_KEY', enabled: true,
    instruction: '站在普通读者视角检查是否看得懂、人物是否值得关心、情绪是否成立、哪里拖沓，避免只有抽象评分。',
  },
  {
    id: 'research', label: '素材调研员', kind: 'research', slot: 'research',
    provider: 'openai_compatible', model: '', base_url: '', api_key_env: 'DSH_ROLE_RESEARCH_KEY', enabled: true,
    instruction: '联网检索历史/地理/民俗/专业领域/市场同类书素材，区分史实/通说/演义并附来源，结论要能直接用于写作。',
  },
]

/** roles.yml 路径。 */
export function rolesFile(novelDir) {
  return path.join(novelDir, 'roles.yml')
}

/** 规范化单个角色（补默认值、越枚举折返、字符串化）。 */
export function normalizeRole(raw) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
  const kind = ROLE_KINDS.includes(text(r.kind)) ? text(r.kind) : 'draft'
  const slot = ROLE_SLOTS.includes(text(r.slot)) ? text(r.slot) : 'draft'
  return {
    id: text(r.id).trim(),
    label: text(r.label).trim(),
    kind,
    slot,
    provider: text(r.provider).trim() || 'openai_compatible',
    model: text(r.model).trim(),
    base_url: text(r.base_url).trim(),
    api_key_env: text(r.api_key_env).trim(),
    enabled: !(r.enabled === false || r.enabled === 'false' || r.enabled === 0 || r.enabled === '0'),
    instruction: text(r.instruction).trim(),
  }
}

/** 读 roles.yml：缺文件/坏文件回退 DEFAULT_ROLES。 */
export function loadRoles(novelDir) {
  const file = rolesFile(novelDir)
  if (!existsSync(file)) return DEFAULT_ROLES.map((r) => normalizeRole(r))
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return DEFAULT_ROLES.map((r) => normalizeRole(r))
  }
  let parsed
  try {
    parsed = parseFlatYamlArray(text)
  } catch {
    parsed = null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ROLES.map((r) => normalizeRole(r))
  return parsed.map(normalizeRole).filter((r) => r.id !== '')
}

/** 序列化角色数组为 roles.yml 文本。 */
export function toYaml(roles) {
  const lines = [
    '# roles.yml —— 文心工作台八角色分模型 AI 调用配置',
    '# 生成后可手工编辑；api_key 不落明文，只写环境变量名 api_key_env。',
    '# kind：orchestrate | outline | plan | draft | polish | review | research',
    '# slot：chief | outline | draft | review | research',
  ]
  for (const raw of roles) {
    const r = normalizeRole(raw)
    lines.push(`- id: ${r.id}`)
    lines.push(`  label: ${r.label}`)
    lines.push(`  kind: ${r.kind}`)
    lines.push(`  slot: ${r.slot}`)
    lines.push(`  provider: ${r.provider}`)
    lines.push(`  model: ${r.model}`)
    lines.push(`  base_url: ${r.base_url}`)
    lines.push(`  api_key_env: ${r.api_key_env}`)
    lines.push(`  enabled: ${r.enabled ? 'true' : 'false'}`)
    lines.push(`  instruction: ${r.instruction}`)
  }
  return lines.join('\n') + '\n'
}

/** 写 roles.yml（覆盖）。 */
export function saveRoles(novelDir, roles) {
  writeFileSync(rolesFile(novelDir), toYaml(roles), 'utf8')
}

/** 取某槽位上启用中的角色。 */
export function rolesForSlot(roles, slot) {
  return roles.filter((r) => r.enabled && r.slot === slot)
}

/** 取某角色 id。 */
export function roleById(roles, id) {
  return roles.find((r) => r.id === id) || null
}

/** 每角色推荐模型：标准版（质量优先）/ 经济版（成本优先）。 */
export const RECOMMENDED_MODELS = {
  'chief-editor': { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' },
  architect: { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' },
  director: { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' },
  writer: { standard: 'qwen3.7-plus', economy: 'deepseek-flash' },
  stylist: { standard: 'qwen3.7-plus', economy: 'deepseek-flash' },
  continuity: { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' },
  reader: { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' },
  research: { standard: 'qwen3.7-plus', economy: 'deepseek-flash' },
}

/** 取某角色的推荐模型（按角色细分，缺省回退到标准档）。 */
export function recommendFor(roleId) {
  const rec = RECOMMENDED_MODELS[roleId] || { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' }
  return {
    standard: { label: '标准版', model: rec.standard },
    economy: { label: '经济版', model: rec.economy },
  }
}
