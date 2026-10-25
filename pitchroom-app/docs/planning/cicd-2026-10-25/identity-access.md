## 1. 用户结果与证据
本地只有 Clerk test keys，未见 SDK/Provider/middleware；持久化入口固定 atelier；Web API与SSE缺真实用户授权。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
high；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
确认 Clerk 方案及环境划分后接入身份；明确项目归属/成员权限；覆盖读写、材料、版本和SSE，建立与认证机制匹配的CSRF/origin策略。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/apps/web/lib/persistent-workspace.ts:1 sha256=30acbd4fd7ba9c5a700d7ce13db49d7f944741d4dc0c327c909b9240e4014b13
- pitchroom-app/apps/web/app/api/workspace/route.ts:1 sha256=63df7161271c8b78cb77ea6fe89eec6dd43ea767bcbdbb970c5e46b447cb0fbf
- pitchroom-app/apps/web/app/api/workspace/events/route.ts:1 sha256=a752543bbc0e59ff11f9a5210f382772041f4030f9e04ef4a2ab244aed6d75bc

## 7. 验收草案
正常：未登录被拒绝；用户A不能读写用户B项目或订阅其事件；未知项目不自动共享创建；过期会话有恢复路径；既有来源/历史/Apply边界保持。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：身份/成员模型、历史项目归属、Clerk prod配置。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
