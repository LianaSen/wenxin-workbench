/**
 * roles.mjs —— 六角色分模型 AI 调用配置（叙事工坊兼容）
 *
 * 叙事工坊把创作拆成六个角色（architect 故事策划 / director 分章编剧 /
 * writer 正文作者 / stylist 文风编辑 / continuity 连续性审核 / reader 读者审稿），
 * 每个角色可独立配置 provider / model / base_url / api key / instructions。
 *
 * 本模块把这套角色模型搬进毛颖的 novel/ 目录：`novel/roles.yml` 为唯一事实源，
 * 顶层数组、平键（与 novel/ 数据规范一致）；api_key 不落明文，只存环境变量名
 * `api_key_env`。每个角色用 `slot` 映射到毛颖的委派槽位（outline/draft/review/
 * lore/research），主编按槽位取角色、按角色的 provider/model 委派子代理。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { parseFlatYamlArray } from './novel-parse.mjs'

/** 叙事工坊角色 kind 枚举（与 ai.py ROLE_INSTRUCTIONS 一致）。 */
export const ROLE_KINDS = ['outline', 'plan', 'draft', 'polish', 'review']

/** 毛颖委派槽位枚举。 */
export const ROLE_SLOTS = ['outline', 'draft', 'review', 'lore', 'research']

/** 角色可编辑字段（roles-set 校验用）。 */
export const ROLE_FIELDS = ['id', 'label', 'kind', 'slot', 'provider', 'model', 'base_url', 'api_key_env', 'enabled', 'instruction']

/**
 * 六角色默认配置：来源为叙事工坊 ai.py 的 default_settings()（六角色 id/name/kind/
 * instructions 逐字对齐），slot 为毛颖侧新增的槽位映射。
 */
export const DEFAULT_ROLES = [
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

/**
 * 读 roles.yml：缺文件/坏文件回退 DEFAULT_ROLES（与叙事工坊 default_settings 同口径）。
 * @returns {Array<object>}
 */
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

/** 序列化角色数组为 roles.yml 文本（顶层数组、平键，供人直接编辑）。 */
export function toYaml(roles) {
  const lines = [
    '# roles.yml —— 六角色分模型 AI 调用配置（叙事工坊兼容）',
    '# 生成后可手工编辑；api_key 不落明文，只写环境变量名 api_key_env。',
    '# kind：outline | plan | draft | polish | review；slot：outline | draft | review | lore | research',
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

/** 取某槽位上启用中的角色（供主编按槽位选模型）。 */
export function rolesForSlot(roles, slot) {
  return roles.filter((r) => r.enabled && r.slot === slot)
}

/** 取某角色的 provider/model（未设模型时回退默认空，交给主编用会话默认模型）。 */
export function roleModel(role) {
  return {
    provider: role.provider === 'openai_compatible' ? '' : role.provider,
    model: role.model,
    reasoning_effort: '',
  }
}
