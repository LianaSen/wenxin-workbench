# 六角色分模型路由（maoying-role-routing）

叙事工坊兼容的角色 AI 调用。主编在**委派前**按 `novel/roles.yml` 选角色模型；写手/审校等角色按本行职责执行。

## 六角色

| id | 名称 | kind | slot |
|---|---|---|---|
| architect | 故事策划 | outline | outline |
| director | 分章编剧 | plan | outline |
| writer | 正文作者 | draft | draft |
| stylist | 文风编辑 | polish | review |
| continuity | 连续性审核 | review | review |
| reader | 读者审稿 | review | review |

- `kind`：outline 全书规划 / plan 章节拆解 / draft 正文 / polish 文风 / review 审核。
- `slot`：映射毛颖委派槽位（outline/draft/review/lore/research）。

## 委派纪律

1. 委派前读 `novel/roles.yml`；缺文件按默认六角色。
2. 同槽位多角色按任务性质选：规划选 architect/director，写正文选 writer，审改选 stylist/continuity/reader。
3. 按角色 `provider`/`model` 传给 subagent 的 `provider`/`model` 参数；`model` 为空回退会话默认。
4. `api_key_env` 只是环境变量名，绝不把密钥写进对话、日志或文件。
5. 角色配置改了之后，下一次委派即生效（每次读 roles.yml）。

## 维护

- 面板「AI 角色」tab：可视化编辑 + 从叙事工坊导入。
- CLI：`maoying roles` / `maoying roles-set <id> field=value` / `maoying import <db>`。
