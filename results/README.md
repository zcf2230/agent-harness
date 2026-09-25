# results — 评测证据（脱敏）

这些 JSON 是 `eval`/`bench`/`ablation` 的聚合输出，绝对路径已替换为 `<HOME>`，不含任何 API key。

**重要（诚实声明）**：本目录数据产生于 **g01 判分收紧与安全整改之前**，因此其中的通过率/消融数字**不作为结论**，
仅用于让审阅者独立复核"为什么首轮消融不成立"——例如 `ablation.json` 里 baseline 的 `compactions` 计数即为 0，
印证"压缩对照是空跑"。修正后的可信数字需按"每配置 R≥3、逐任务配对"重测后更新本目录。

- `ablation.json` — 4 配置 × 22 任务单轮消融原始数据
- `bench.json` — pass@R / 方差 / flaky 聚合
- `summary.sample.json` — 一次全量 eval 的逐任务记录（含 status / failure reason / 成本）
