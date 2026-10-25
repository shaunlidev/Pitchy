## 1. 用户结果与证据
Vercel pitchroom-app 已存在但没有部署、环境变量或 Git link；框架未显式配置；Clarify 需要独立 worker。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
medium；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
比较保留 Vercel Web + 单独 worker 与统一托管；确定 staging/prod 服务、区域、域名、启动命令、运行时与发布兼容窗口。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/apps/web/package.json:1 sha256=293b4ee4b19dc4f695cf311180b3f064fa188e2fcae41009074e3fc05f889d6c
- pitchroom-app/scripts/clarification-worker.ts:1 sha256=3ccada7a4d031207aef03be846598c0c7c7c39dc2f68b4e46c78be7f32bf0aec
- pitchroom-app/apps/web/next.config.ts:1 sha256=f5b84fa0eb2c4d706cc46cc7dda6b396ab8b84ed82ff694ea5e95c2de7d200f8

## 7. 验收草案
正常：选定方案覆盖 60 秒模型请求、25 秒 SSE、常驻 worker、连接池、端口、secret 注入和版本标识；费用与限制有依据；不把平台自动部署视为原子发布。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：平台、预算、域名、worker 托管和服务区域；Railway 只是候选。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
