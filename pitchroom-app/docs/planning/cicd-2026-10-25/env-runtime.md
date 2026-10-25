## 1. 用户结果与证据
fixture/postgres-fake/live 是运行模式；多处默认 fixture；health 对 fixture 可 ready；Vercel 无 env；DATABASE_URL_POOLED 未见接入。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
high；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
明确 deployment environment 与 runtime；固定 Node及Postgres版本契约（云端18、Compose17）；区分Web/worker/迁移变量、连接池和secret；启动错误拒绝。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/scripts/check-env.mjs:1 sha256=7d3710137d32e4fa275bb85d7d3d7b3ec1e300b55ea53c2427b27be0215d4431
- pitchroom-app/apps/web/app/api/health/route.ts:1 sha256=aa623f41963f4d80ba1761859bd7daaa4121c0fd869bc6ac66943aa31feddf7e
- pitchroom-app/compose.yaml:1 sha256=1209d5631c7740b17e576402654a531d35fdfe1eaeab558ba21f8177ac97bf02

## 7. 验收草案
正常：staging/prod 缺 runtime/DB/model/ack 或环境目标错误即拒绝；部署不允许 fixture 假绿；health 返回版本与 schema readiness，凭据不输出；记录 shell override 行为。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：版本对齐策略、变量来源和轮换负责人。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
