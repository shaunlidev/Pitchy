## 1. 用户结果与证据
本地无 .github；pnpm 已固定版本但 Node 未约束；现有集成脚本硬编码本地 DB 且未纳入全部 suite；历史 pnpm check 被安全提示阻断。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
high；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-5, PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
固定 Node/pnpm/lockfile；类型、单测、全部隔离 DB suites、离线 eval、构建；明确串行迁移和测试；浏览器检查使用合成状态。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/package.json:1 sha256=8a0c1464c9b8581814c21f033525777cdfde994a252ab9309b094258b0f7c82d
- pitchroom-app/packages/persistence/package.json:1 sha256=49c65f22b7b35d72b3750d50467aae267f7e0527e992a1dd0e077ae9f3c8b815
- pitchroom-app/apps/web/playwright.config.ts:1 sha256=50a1695365864bcd0ceaaecc12085585c141a8e0bb9951a53ae03899379bd917

## 7. 验收草案
正常：PR 检查失败不可放行；临时 DB 不接触 Neon；不跳过构建安全阻断；不上传原始 trace/截图；冻结允许脱敏日志及证据输出政策。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：CI 浏览器供应方式、证据政策；新增安装/下载另授权。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
