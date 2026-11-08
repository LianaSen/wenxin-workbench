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
export const ROLE_FIELDS = ['id', 'label', 'kind', 'slot', 'provider', 'model', 'base_url', 'api_key_env', 'enabled', 'reasoning_effort', 'instruction']

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
    reasoning_effort: text(r.reasoning_effort).trim(),
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
    lines.push(`  reasoning_effort: ${r.reasoning_effort}`)
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

/**
 * 市场模型目录（2026-11 官方直连文本 API）：
 * 来源《六角色模型、价格与组合建议》（叙事工坊 docs/model-recommendations.md）。
 */
export const MODEL_CATALOG = {
  'gpt-6-astra': { id: 'gpt-6-astra', model: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai_compatible', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', note: '关键情节与多重约束复核' },
  'gpt-6.1-terra': { id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', provider: 'openai_compatible', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', note: '文本起草/修订' },
  'claude-opus-5.5': { id: 'claude-opus-5.5', model: 'claude-opus-5.5', label: 'Claude Opus 5.5', provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key_env: 'ANTHROPIC_API_KEY', note: '复杂感情戏/重要场景' },
  'claude-sonnet-5.5': { id: 'claude-sonnet-5.5', model: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key_env: 'ANTHROPIC_API_KEY', note: '日常正文与读者审稿' },
  'deepseek-v4-pro': { id: 'deepseek-v4-pro', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'openai_compatible', base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY', note: '策划/约束检查/连续性复核' },
  'deepseek-flash': { id: 'deepseek-flash', model: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'openai_compatible', base_url: 'https://api.deepseek.com', api_key_env: 'DEEPSEEK_API_KEY', note: '分章拆场/高频初筛' },
  'qwen3.7-plus': { id: 'qwen3.7-plus', model: 'qwen3.7-plus', label: 'Qwen3.7 Plus', provider: 'openai_compatible', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key_env: 'DASHSCOPE_API_KEY', note: '中文正文/改稿' },
  'codex-gpt-6-astra': { id: 'codex-gpt-6-astra', model: 'gpt-6-astra', label: 'Codex · gpt-6-astra（订阅）', provider: 'codex', base_url: '', api_key_env: '', note: '用 ChatGPT/Codex 订阅登录，不走 API 计费（需 Codex CLI 0.167+）' },
  'codex-gpt-5.6-sol': { id: 'codex-gpt-5.6-sol', model: 'gpt-5.6-sol', label: 'Codex · gpt-5.6-sol（订阅）', provider: 'codex', base_url: '', api_key_env: '', note: '用 ChatGPT/Codex 订阅登录，不走 API 计费（旧 CLI 也可用）' },
}

/** 每角色推荐（标准版 / 经济版）：主推荐与经济候选。 */
export const RECOMMENDED_BY_ROLE = {
  'chief-editor': { standard: 'gpt-6-astra', economy: 'deepseek-v4-pro' },
  architect: { standard: 'gpt-6-astra', economy: 'deepseek-v4-pro' },
  director: { standard: 'deepseek-v4-pro', economy: 'deepseek-flash' },
  writer: { standard: 'claude-opus-5.5', economy: 'qwen3.7-plus' },
  stylist: { standard: 'gpt-6.1-terra', economy: 'qwen3.7-plus' },
  continuity: { standard: 'gpt-6-astra', economy: 'deepseek-v4-pro' },
  reader: { standard: 'claude-sonnet-5.5', economy: 'deepseek-flash' },
  research: { standard: 'gpt-6-astra', economy: 'deepseek-v4-pro' },
}

/** 取某角色的推荐模型（按角色细分，缺省回退到正文作者档）。 */
export function recommendFor(roleId) {
  const rec = RECOMMENDED_BY_ROLE[roleId] || RECOMMENDED_BY_ROLE.writer
  const pick = (id) => {
    const m = MODEL_CATALOG[id]
    return m
      ? { catalogId: m.id, model: m.model || m.id, label: m.label, provider: m.provider, base_url: m.base_url, api_key_env: m.api_key_env }
      : { catalogId: id, model: id, label: id, provider: 'openai_compatible', base_url: '', api_key_env: '' }
  }
  return {
    standard: { tier: '标准版', ...pick(rec.standard) },
    economy: { tier: '经济版', ...pick(rec.economy) },
  }
}

/** 默认模型目录（数组形式）。 */
export function modelCatalogArray() {
  return Object.values(MODEL_CATALOG).map((m) => ({ ...m }))
}

/** 归一化模型条目。 */
export function normalizeModel(raw) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
  return {
    id: text(r.id).trim(),
    model: text(r.model).trim() || text(r.id).trim(),
    label: text(r.label).trim() || text(r.id).trim(),
    tier: text(r.tier).trim() || 'candidate',
    provider: text(r.provider).trim() || 'openai_compatible',
    base_url: text(r.base_url).trim(),
    api_key_env: text(r.api_key_env).trim(),
    note: text(r.note).trim(),
  }
}

/** 读 novel/models.yml；缺文件/坏文件回退默认目录。 */
export function loadModelCatalog(novelDir) {
  const file = path.join(novelDir, 'models.yml')
  if (!existsSync(file)) return modelCatalogArray()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return modelCatalogArray()
  }
  try {
    const parsed = parseFlatYamlArray(text)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(normalizeModel).filter((m) => m.id !== '')
    }
  } catch {
    /* fall through */
  }
  return modelCatalogArray()
}

/** 序列化模型目录。 */
export function toModelsYaml(list) {
  const lines = ['# models.yml —— 市场模型目录（面板「AI 角色」刷新/推荐用）', '# tier：standard | economy | candidate']
  for (const raw of list) {
    const m = normalizeModel(raw)
    lines.push(`- id: ${m.id}`)
    lines.push(`  model: ${m.model}`)
    lines.push(`  label: ${m.label}`)
    lines.push(`  tier: ${m.tier}`)
    lines.push(`  provider: ${m.provider}`)
    lines.push(`  base_url: ${m.base_url}`)
    lines.push(`  api_key_env: ${m.api_key_env}`)
    lines.push(`  note: ${m.note}`)
  }
  return lines.join('\n') + '\n'
}

/** 写 novel/models.yml。 */
export function saveModelCatalog(novelDir, list) {
  writeFileSync(path.join(novelDir, 'models.yml'), toModelsYaml(list), 'utf8')
}
