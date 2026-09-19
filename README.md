# Deckdraft

一个用于验证“公司信息输入 → Pitch Deck 叙事生成 → 可见预览”的零后端原型。

当前版本使用规则生成 8 页 deck，不调用外部模型，也不上传数据。产品假设验证通过后，可把 `dist/app.js` 中的 `buildDeck` 替换为结构化 LLM 输出，并增加 PPTX 导出。
