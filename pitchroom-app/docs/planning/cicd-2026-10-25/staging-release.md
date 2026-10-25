## 1. 用户结果与证据
Vercel只有空项目；当前E2E固定fixture；无实际staging、迁移发布编排或云端冒烟。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
medium；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-5, PIT-6, PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
CI通过后部署明确SHA的Web/worker；独立迁移步骤与schema门禁；访问保护；合成持久化流程、worker和SSE冒烟；模型质量单列。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/DEPLOYMENT_CHECKLIST.md:1 sha256=66a64ebfe646b65f2c6154048ea9ca71b9e518f178d0509909a0a65d14edebde
- pitchroom-app/RUNBOOK.md:1 sha256=c88371fd7b0b12087fe1e28b3e2de9746e5fa9761b3f44a1c8151ad515cf78c0
- pitchroom-app/scripts/qa-persistent-http.mjs:1 sha256=92a6af538ff5027637e8dba0478b2161ea2af3b8a72e2cda97012664c27c2757

## 7. 验收草案
正常：迁移失败停止发布；Web/worker/schema版本可追踪；重复触发不并发迁移；重启后版本和历史保留；绝不使用prod或用户私密材料。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：部署拓扑、环境隔离、CI门槛先确认；模型调用/录像预算另审批。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
