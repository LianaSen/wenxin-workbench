# 叙事工坊整合说明

本分支在毛颖（dsh-maoying）之上，接入叙事工坊（Narrative Workbench）的「角色 AI 调用」。可视化全部沿用毛颖创作台面板，最终产物仍是一个可安装的 DSH 插件。

## 1. 两个系统的分工

| | 毛颖（本插件） | 叙事工坊（AutoAI） |
|---|---|---|
| 编排 | 主编 + 五帮手（outline/draft/review/lore/research），七阶段 + 六步法 | 六角色流水线（故事策划→分章编剧→正文作者→文风编辑→连续性审核→读者审稿） |
| 数据 | `novel/` 结构化 markdown/YAML，无数据库 | `workbench.sqlite3`（projects/settings/tasks） |
| 模型 | 会话/子代理模型 | 每角色独立 provider/model/base_url/api_key |
| 可视化 | 毛颖创作台面板 | 独立 Python 桌面工作台 |

整合点：把叙事工坊的**分角色模型配置**搬进 `novel/roles.yml`，由毛颖主编在委派时按角色路由；并提供从 `workbench.sqlite3` 导入作品与角色配置的桥接。

## 2. 六角色

来源为叙事工坊 `workbench/ai.py` 的 `default_settings()`（逐字对齐）：

| id | 名称 | kind | 毛颖槽位 slot |
|---|---|---|---|
| architect | 故事策划 | outline | outline |
| director | 分章编剧 | plan | outline |
| writer | 正文作者 | draft | draft |
| stylist | 文风编辑 | polish | review |
| continuity | 连续性审核 | review | review |
| reader | 读者审稿 | review | review |

## 3. roles.yml

`novel/roles.yml` 为顶层数组、平键（与 `novel/` 数据规范一致），每个角色一条：

```yaml
- id: writer
  label: 正文作者
  kind: draft
  slot: draft
  provider: openai_compatible
  model: qwen3.7-plus
  base_url: ""
  api_key_env: DSH_ROLE_WRITER_KEY
  enabled: true
  instruction: 按本章任务写完整正文……
```

- `provider`：`openai_compatible` / `anthropic` / `ollama` 等（与叙事工坊一致）。
- `model` 为空时回退会话默认模型。
- `api_key_env` 只是**环境变量名**，密钥绝不落明文、不进对话/日志。
- 主编委派某槽位时，取该槽位启用角色的 provider/model 传给 subagent 的 `provider`/`model` 参数。

## 4. 创作台面板

毛颖创作台新增「AI 角色」tab（与既有 tab 同一套快照/写面/校验）：

- 六角色卡片：kind/slot 标签、启用开关、provider/model/base_url/api_key_env 输入框；
- 保存走 `POST /api/maoying/roles-save`（结构校验 + `base_hash` 人工改动保护）；
- 「从叙事工坊导入」：填 `workbench.sqlite3` 路径与书名，走 `POST /api/maoying/import-workbench`。

## 5. CLI

```bash
maoying roles [dir]                                  # 列出 roles.yml
maoying roles-set [dir] writer model=qwen3.7-plus    # 改角色字段
maoying import <workbench.sqlite3> --list            # 列叙事工坊作品
maoying import <workbench.sqlite3> --title 无名者登记簿 --dir novel --overwrite
```

## 6. 导入桥接（node:sqlite）

`lib/narrative-bridge.mjs` 用 `node:sqlite` 只读打开 `workbench.sqlite3`：

1. 读 `projects` 表（JSON）与 `settings` 表；
2. 选目标作品（`--title`，缺省第一部）；
3. 从 `outline` 文本解析分卷（`卷一 · 他人之名（第 1–21 章）`）；
4. 写 `project.yml` / `volumes.yml` / `chapters/` / `outlines/`；
5. 由 `settings.roles` 生成 `roles.yml`（真实分角色模型，密钥不迁移）。

导入后 `phase` 置 `setting`（角色卡/世界观由主编在设定阶段补齐），`maoying check` 只报五维待补类提醒，0 错误。

## 7. 边界

- 密钥：叙事工坊的 `api_key` 加密存于其数据库，桥接只写环境变量名；实际密钥由用户在环境变量中提供。
- 数据：导入是单向迁移；`novel/` 是唯一事实源，导入后不再依赖 `workbench.sqlite3`。
- 正文：叙事工坊 `chapters[].versions` 里最后一个非空 `content` 作为该章正文；其余章保留一句章纲。
