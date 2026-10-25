## 1. 用户结果与证据
Neon pitchroom 只有 production 默认分支、neondb、neondb_owner；本地 live 的直连与 pooled URL 指向同一端点；尚无 staging。
来源：本对话与 /Users/shaun/Documents/ChatGPT/ai-slide-generator/pitchroom-app/docs/planning/cicd-2026-10-25/review.md；SHA256 1d08f250b5326cc85c23677631c8d5b0cd449b2dc42eb66d4386dca72b7a079f

## 2. 优先级
high；服务发布关键路径或真实用户数据边界；不要求抢占V6产品批次。

## 3. 前置与顺序
引用现有任务：PIT-8, PIT-11。本预览新任务的建议顺序：基线/拓扑/数据→CI/环境/身份/worker→staging→prod。依赖仅规划，不是调度门禁；实施前补齐精确硬依赖及签收证据。

## 4. 有界交付
先确认现有 production 分支实际用途，不查询业务内容；设计独立环境数据、端点、凭据、最小权限应用角色与迁移角色；确定空库/仅结构/脱敏测试数据方案。

## 5. 范围与保护
仅规划建单，执行授权pending。保留来源、未知、手工编辑、明确Apply、历史及Undo；不改archive、pitchroom-v6/prototype、原始证据、私密数据库或密钥。编辑范围扩大需重新确认。

## 6. 源码与依据
file_plan_status=partial；以下为只读参考，不是最终实施编辑清单：
- pitchroom-app/compose.yaml:1 sha256=1209d5631c7740b17e576402654a531d35fdfe1eaeab558ba21f8177ac97bf02
- pitchroom-app/packages/persistence/src/repository.ts:1 sha256=da7fec61bffdc0f35597901ae44b443684b12f0bf6bb0ca0f216d8fe46ff3505
- pitchroom-app/packages/persistence/drizzle.config.ts:1 sha256=9f4b5dc9e2b68839abb152405456a14f9adf3cd191a34eb01db98998e0dbd6d0

## 7. 验收草案
正常：环境映射可复核；dev/staging 凭据不能访问 prod；应用不能执行迁移管理操作；直连与 pooled 明确分工；任何测试不能误指向现有分支。
拒绝：缺授权、缺配置或目标无法确认时拒绝执行并保留已有状态。
失败：如实记录原始失败，不弱化断言或把跳过当通过。
恢复：保留版本与原数据，按本卡确认的恢复方案重试；不自动覆盖或删除。

## 8. 验证与未决
确定性/DB/浏览器/真实模型/人工验收分别记录；只使用隔离合成状态；真实模型、录制及资源变更单独确认。
未决：分支或独立项目、现有数据归属、凭据隔离方式、权限策略；建资源与改配置待批准。

## 9. 启动和完成门禁
start_approval=pending；建单不等于启动。实施前确认决策、精确文件/配置范围、依赖及验收。状态backlog、负责人空；不派发Agent，不自动done。交付实际结果及未验证项后人工签收。
