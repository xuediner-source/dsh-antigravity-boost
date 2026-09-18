# dsh-antigravity-boost

DeepSeek Harness 插件：**Antigravity `/boost` 风格的深度推理模式** —— 临时隔离 worktree、并行实现/调查工作流、本地验证，失败诊断自动回灌下一轮迭代。

> 功能面严格对照**官方文档** `antigravity.google/docs/boost/` 逆向实现，逐条对齐三阶段流水线、workspace 模型、验证规则与措辞。

## 安装

```sh
dsh plugin --profile web add github:xuediner-source/dsh-antigravity-boost
```

重启 DSH 后即生效。

## 能力（对照官方规格）

官方 `/boost` 的三阶段：

1. **目标与策略制定** —— Orchestrator 把 prompt 拆成离散、可验证的子任务，决定需要哪些工作流
2. **并行执行与验证** —— 实现工作流构建代码；**调查工作流追踪根因，且必须不修改文件**；子 agent 本地执行 build/test 验证后再上报
3. **综合与交付** —— 用完整测试套件验证合并后的方案；**断言失败 → 诊断信息喂回下一轮迭代**；全部通过后才交付

| 官方机制 | 本插件实现 |
|---|---|
| **`/boost <task>`** | 命令 + `boost_run` 工具，打开临时隔离 worktree |
| **临时隔离 worktree** | `lib/worktree.js`，分支 `boost/<runId>`，路径 `<repo>/.dsh-boost/worktrees/<runId>` |
| **实现工作流** | `boost_report kind=implementation` |
| **调查工作流（不改文件）** | `boost_report kind=investigation` —— 报告含文件变更时**拒绝**并提示改用 implementation |
| **本地验证** | `lib/verify.js`，在 worktree 内执行 `verifyCommands` |
| **失败诊断回灌迭代** | `/boost-verify` 失败时返回 `diagnostics` + `feedback`，状态转 `iterating` |
| **迭代轮次上限** | `maxRounds`（默认 3），耗尽后转 `needs_review` 交人工 |
| **交付前必须全绿** | `/boost-deliver` 在未通过全部验证轮次时拒绝合并 |
| **主仓不受污染** | 所有改动发生在隔离 worktree，主仓工作树保持干净 |
| **一次性 workspace（对比 Teamwork 的持久 worktree）** | `closeRun` / `/boost-discard` 合并或丢弃后移除 worktree 与分支 |
| **状态留痕** | `<repo>/.dsh-boost/runs/<runId>/state.json`，崩溃后可查 |

## 三种模式对照（官方表）

| 维度 | 默认 Agent | 🚀 本插件 | 👥 Teamwork |
|---|---|---|---|
| 定位 | 全谱交互式编码 | 深推理 / 疑难 bug | 自主多天 agent 团队 |
| 时间尺度 | 秒~分钟 | **秒~小时** | 小时~天 |
| 架构 | 单 agent 直接循环 | **3 阶段推理层级** | 多角色 agent 团队 |
| 工作区 | 共享工作树 | **临时隔离 worktree** | 每里程碑持久隔离 worktree |
| 验证 | 单次工具检查 | **多轮独立验证** | 对抗性证伪 + 独立成功审计 |

## 适用场景（官方列出的四类）

1. **并发与竞态**：多线程时序问题、死锁、缓存同步
2. **算法问题求解**：高性能算法、数据结构、图遍历，配严格边界测试
3. **非平凡重构**：紧耦合模块、同步→异步迁移
4. **深度根因调查**：跨陌生大代码库追踪失败源头

## 用法

```
/boost Investigate the race condition in the session cache and implement a thread-safe fix with tests.
```

然后按协议推进：
1. 计划 —— 拆分实现 / 调查工作流
2. 执行 —— `boost_report` 记录工作流结论（调查流不可报文件变更）
3. 验证 —— `/boost-verify`；失败则按诊断迭代
4. 交付 —— `/boost-deliver`（需全部验证通过）或 `/boost-discard`

## 已知差异

| 项 | 官方 | 本插件 |
|---|---|---|
| 子 agent 编排 | Orchestrator 自动派发专用子 agent 并行执行 | 提供协议 + 工具，由当前会话的模型按协议推进；DSH 子 agent 的 cwd 无法覆盖（宿主约束），故 worktree 隔离通过独立 git worktree 实现而非子 agent cwd |
| 并行子 agent | Phase 2 真并发 | 工具顺序执行；并发可由模型在 worktree 内自行组织 |

## 配置

```yaml
- id: dsh-antigravity-boost
  config:
    enabled: true
    maxRounds: 3
    verifyCommands: ["npm test"]
```

## 验证

```sh
npm run check   # 语法
npm test        # 32 项测试
```

测试覆盖：临时 worktree 创建与主仓隔离、diff 汇总、验证命令的退出码与 spawn 错误捕获、**引号内命令的正确解析**（`node -e "process.exit(1)"` 必须真正失败）、失败诊断回灌、`maxRounds` 耗尽转人工、调查流报文件变更被拒、未验证全绿拒绝交付、验证通过后合并并清理 worktree。

## 许可

MIT © [xuediner-source](https://github.com/xuediner-source)
