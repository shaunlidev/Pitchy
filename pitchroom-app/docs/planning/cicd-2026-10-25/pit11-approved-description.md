审阅稿：未经用户批准不得执行。状态保留 Backlog，负责人留空，不触发 Agent。

来源：[PIT-3 只读调查](http://localhost:3100/pitchroom/issues/PIT-3)。项目根目录：/Users/shaun/Documents/ChatGPT/ai-slide-generator。以下依据来自该静态调查，历史执行结果不等于本次复验。

优先级：high。

前置依赖（人工检查，不自动调度）：
- [PIT-5](http://localhost:3100/pitchroom/issues/PIT-5)
- [PIT-8](http://localhost:3100/pitchroom/issues/PIT-8)

问题：本地闭环不构成生产部署背书；尚无完整上线证据。
证据：pitchroom-app/SECURITY.md:33–46；首批验收报告 open[4]。
范围：先形成用户可批准的部署和数据方案，再实施验证；本卡本身不授权公开上线。优先级是上线前高优先级，当前产品迭代可独立推进。
依赖说明：安全公告处置完成；材料任务的数据留存/删除范围先确定。公开发布还需语言、质量及核心恢复达到发布门槛；若声明 PDF/辅助技术支持，也须相应验收。
验收条件：
- 批准部署、身份/项目授权、数据流、留存/删除、加密、限流成本与备份方案。
- 保存越权拒绝、CSRF、传输安全、限流/成本、删除及备份恢复的实际证据。
- 在隔离环境验证发布、健康检查与回滚，明确剩余风险、负责人和发布门槛。
- 用户单独批准正式发布；部署证据与客户验收分别记录，不互相替代。

交付规则：交回实际修改/验证/未验证项和证据，进入 in_review，由用户验收；不自动标 done、提交、推送或部署。

## 本轮部署隔离审查补充（待批准同步）
# 本对话部署审查记录（2026-10-25）
用户目标：搭建CI/CD、staging和prod；当前只读核对后整理到Multica，不授权实施。
已观察：无Git remote；可访问GitHub账号/组织未找到Pitchroom仓库，其他账号未知。Vercel已有pitchroom-app但无部署/env/git link，默认域名已绑定；groundai.app/com未绑定Pitchroom。
Neon控制台已读：pitchroom / production默认唯一分支 / neondb / neondb_owner；新加坡Free，Postgres18，1compute，6小时恢复，未保护，公网任意IP凭凭据可达。env本地比对直连和pooled均同端点，live。未查询业务数据，未验证迁移/数据内容/恢复。
应用已有Web、独立Clarify worker、Postgres；产品测试基础和模型全链路记录不构成部署/用户验收。现有本地代码含大量未提交实现。
建议而非决策：CI自动验证，自动staging，人工prod晋级；平台拓扑尚未定，Railway只是候选，Vercel已有资源应纳入比较。
保护：不上传原始QA/私密资料；不改v6原型/证据；不启动Agent、模型、安装、迁移、提交、部署、建资源、付费。
远端观察均为本对话时点快照，实施前复核。

建议独立规划任务：
- 建立完整的 GitHub 代码基线与发布文件边界
- 确认 Web、Clarify worker 与数据库的部署拓扑
- 隔离 Neon 的 dev、staging 与 prod 数据及凭据
- 建立可复现且隔离数据的 PR CI 门禁
- 建立环境配置契约与生产拒绝错误配置的启动检查
- 接入身份与逐项目授权，移除固定共享项目入口
- 建立 Clarify worker 的托管、健康监控与重启恢复
- 建立自动 staging 发布、串行迁移与持久化冒烟
- 建立 prod 手动晋级、备份恢复及回滚演练
- 补齐线上限流、全局模型预算与可观测性
- 刷新部署证据清单并对齐实际 Web/worker 模型验收
复用 PIT-5（安全）、PIT-6（质量）、PIT-8（留存/删除）、PIT-9（用户）、PIT-10（PDF/AT）及现有V6六批计划，不重复创建；不改状态/负责人/父级/阶段/标签/订阅。
