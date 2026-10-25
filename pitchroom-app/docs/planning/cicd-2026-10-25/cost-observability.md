## 1. 用户结果与证据
已有单次执行边界、request ID、失败分类，但独立eval预算不能视为Web/worker共享预算；SSE每500ms读取状态。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
medium；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-6, PIT-8, PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
统一环境/用户/项目成本与并发限制；模型关闭开关；关联HTTP/run/task日志；DB连接及SSE负载、延迟、失败与队列监控；脱敏。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/apps/web/app/api/workspace/events/route.ts:1 sha256=a752543bbc0e59ff11f9a5210f382772041f4030f9e04ef4a2ab244aed6d75bc
- pitchroom-app/packages/agent/src/persisted-run.ts:1 sha256=e6000ab78b7c69a4a09d6fc1f652e4630c463c9842db38fe5095f986843b35e4
- pitchroom-app/SECURITY.md:1 sha256=0d5ac9c8d9e46cd32165b178b2ea5e3f5348ccc2a3062c2b4101d7fd214aff27

## 7. 验收草案
正常：超预算在调用前拒绝；并发不能突破共享上限；provider失败不无限重试；告警能定位到版本/请求/任务；日志不泄露密钥和原始私密材料。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：费用/并发/告警阈值、监控服务、日志保留及SSE优化是否必要。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
