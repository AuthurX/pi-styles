# Changelog

## 0.1.1

- 修复工具摩擦归因：并行工具批次（任意数量 toolResult）后的用户纠偏均可正确归因
- 蒸馏/压缩模型调用失败时透传 provider 错误信息
- 增强风格落盘防覆盖：同名冲突自动 `-enhanced`/`-enhanced-2` 递增
- 补充发布元数据（license、files 白名单、repository、publishConfig）

## 0.1.0

- 首发：100% 兼容 Claude Code 输出风格（容错 YAML、三级作用域、热加载）
- 可执行工具策略护栏：先图后写确认门、写路径白/黑名单、覆盖确认、单轮文件数上限、bash 确认/禁止正则、tool_result 超行瘦身
- 自动成本标签与状态栏（token 估算 + verbosity 推断 + 策略徽章）
- 蒸馏闭环：`/style create` 从历史会话（对话纠偏 + 工具摩擦）后台 LLM 蒸馏新风格；`/style enhance` 为已有纯文本风格补齐 policy/cost
- 8 个内置风格
