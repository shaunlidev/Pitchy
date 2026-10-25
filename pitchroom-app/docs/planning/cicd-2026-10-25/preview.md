# Multica待同步预览

新增11项、更新PIT-11描述1项；远端写入0。全部backlog、无负责人，不启动Agent。

1. [建立完整的 GitHub 代码基线与发布文件边界](release-baseline.md) — high
2. [确认 Web、Clarify worker 与数据库的部署拓扑](hosting-topology.md) — medium
3. [隔离 Neon 的 dev、staging 与 prod 数据及凭据](neon-isolation.md) — high
4. [建立可复现且隔离数据的 PR CI 门禁](ci-gates.md) — high
5. [建立环境配置契约与生产拒绝错误配置的启动检查](env-runtime.md) — high
6. [接入身份与逐项目授权，移除固定共享项目入口](identity-access.md) — high
7. [建立 Clarify worker 的托管、健康监控与重启恢复](worker-operations.md) — medium
8. [建立自动 staging 发布、串行迁移与持久化冒烟](staging-release.md) — medium
9. [建立 prod 手动晋级、备份恢复及回滚演练](prod-recovery.md) — medium
10. [补齐线上限流、全局模型预算与可观测性](cost-observability.md) — medium
11. [刷新部署证据清单并对齐实际 Web/worker 模型验收](release-evidence.md) — medium

PIT-11保留原文并追加本轮审查现状与索引；不改其他字段。复用PIT-5/6/8/9/10及V6六批任务。

完整内容：preview.json
SHA256: 85c79cc8d8462443bf21a03293b42a5eb839a31a4a2d69e0a511b00a26b67062
