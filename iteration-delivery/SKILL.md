---
name: iteration-delivery
description: 把一段需求描述、PRD 或需求文档变成已部署到测试环境的端到端迭代编排。当用户给出需求材料并要求"从头做到推送""走完整迭代流程""实现并自测完推到测试环境""按流程做完这个需求"，或直接要求"部署到测试环境""推到测试环境并部署""合并到 env_test 并上线"时使用。依次驱动需求澄清、设计方案、代码实现、单元测试、全量 mvn 测试、实现与设计一致性审查、合并推送与测试环境部署（部署子流程见本 skill 的 references/部署到测试环境.md）；过程产物落 .task/<迭代>/，正式产物落 docs/。
argument-hint: "<需求描述 | PRD 或需求文档路径>"
disable-model-invocation: true
---

# 需求迭代全流程

把一次需求从材料推进到测试环境部署。本 skill 只做**编排、关卡、产物落点和证据留痕**——需求规则、编码规范、审查标准分别由目标仓库既有的项目 skill 提供，**不复制它们的规则**。

`<repo-root>` 指 `git rev-parse --show-toplevel` 的结果。本 skill 引用的项目 skill 路径一律以 `<repo-root>` 解析，本 skill 自身的 `references/`、`assets/` 以本文件所在目录解析。

## 授权边界

用户在会话中显式调用本 skill，即视为授权：创建 `.task/<迭代>/` 目录、创建本地分支、修改业务代码、编写测试、运行测试、`git add` 与 `git commit`、把迭代分支合入 `env_test`、推送 `env_test`、ssh 登录测试服务器执行 `deploy_dev.sh`。

**不授权**（需要用户当次明确同意才可做）：修改 `.gitignore` / git 配置 / git hook / remote；force push；rebase 或 merge 他人分支；改写远端历史；在服务器上 `git reset --hard` 或改配置文件；回滚已部署的版本。

- 阶段 7 起，合并、推送与部署由本 skill 的 `references/部署到测试环境.md` 子流程连续完成（不再委托外部 skill）。**关卡③的用户确认同时包含测试环境部署授权**，不另设部署关卡。
- 部署是真实的环境变更：服务器会重新打包、覆盖运行中的 jar、`kill -9` 并重启 8080 服务，期间测试环境不可用。这是关卡③必须展示的影响面。
- 项目 `AGENTS.md` 要求"未经明确要求不 commit/push"——显式调用本 skill 就是那个"明确要求"，但推送前仍有确认关卡兜底。
- 轻量流程红线：不创建审批链、交付台账、执行事件流、SHA 冻结或多身份系统；**不得引用已停用的 `.agents/references/需求版本与交付追踪规范.md`**。确认关卡是对话内的一次决策确认，不是审批状态机。

## 依赖的项目 skill

按阶段读取，已读且未变化的规范不重复加载：

| 阶段 | 路径 | 必需性 |
|---|---|---|
| 1、2 | `<repo-root>/.agents/skills/paneasypush-requirements/SKILL.md`，并读取该 skill 目录下的需求分析与文档规则，以及需求记录、技术方案、上线计划三个模板（详见该 SKILL.md 内的引用） | 必需 |
| 1 | `<repo-root>/.agents/skills/prd-prototype-delivery/SKILL.md` | 输入含 PRD / HTML 原型 / 跨端接口时必需 |
| 3、4 | `<repo-root>/.agents/skills/code-standards/SKILL.md`，并按其指引读取该 skill 目录下的规范正文与 Java 开发质量流程 | 必需 |
| 3 | `<repo-root>/.agents/skills/subagent-driven-development/SKILL.md` | 可选，任务可独立拆分时 |
| 6 | `<repo-root>/.agents/skills/paneasypush-java-review/SKILL.md` | 必需 |
| 7 | 本 skill 的 `references/部署到测试环境.md`（含 `部署环境与故障处理.md`） | 必需 |

同时读取 `<repo-root>/AGENTS.md` 作为最高约束（存在时）。项目 skill 缺失时按 `references/异常与边界处理.md` 的 `DEGRADED_MODE` 处理。

## 入口分流

- **完整迭代**（默认）：从第 0 步顺序走到阶段 7。
- **仅部署**：用户只要求"部署到测试环境""推到测试环境并部署""合并到 env_test 并上线"，且代码已在迭代分支上时，**跳过第 0 步与阶段 1~6**，直接执行阶段 7。仍需先展示关卡③要求的内容（待提交文件清单、commit message、合并路径、目标远端与分支、部署服务器与影响面）并取得确认。
- 仅部署入口下，不得因为跳过了前置阶段就省略关卡③。用户答"先别推"即整体停下。

## 第 0 步：进入与基线（不停）

1. 定位仓库并记录基线：`git rev-parse --show-toplevel`、`git rev-parse --abbrev-ref HEAD`、`git log -1 --format=%H`、`git status --porcelain`。
2. 检查 `<repo-root>/.agents/skills/paneasypush-requirements/SKILL.md` 是否存在，决定 `REPO_MODE` 或 `DEGRADED_MODE`。
3. 读 `<repo-root>/AGENTS.md` 与需求材料（用户文本、指定文件、PRD、HTML）。
4. 生成 `slug`（需求短标识，kebab-case），确定迭代目录 `.task/<YYYYMMDD>-<slug>/` 与分支 `codex/<slug>`。
5. 用 `assets/迭代说明模板.md` 建 `.task/<迭代>/迭代说明.md`，写入基线与复杂度初判。
6. `git checkout -b codex/<slug>`，**从当前 HEAD 拉**，不切换到 dev/master。
7. 用 5 行以内的摘要告知用户（迭代目录、分支、起始 HEAD、预计确认关卡数），**然后直接进入阶段 1**。

脏工作区：保留既有改动作为基线并记录在 `迭代说明.md`，**不 stash、不丢弃、不提交无关改动**；若发现未跟踪的敏感文件（`*.pem`、`*.env`）先报告。

需求材料模糊到无法判断"要做什么业务"时，停在第 0 步要求补充，不建目录、不建分支。判据见 `references/异常与边界处理.md`。

## 阶段 1：需求澄清

- **动作**：读 `paneasypush-requirements`，先检索 `docs/需求/需求索引.md` 历史，再核对该需求的当前入口与消费者；按"必须主动澄清的边界"识别缺口，缺口影响业务时**一次提 1~3 个最关键问题**（附具体场景、候选处理、业务影响）。
- **产物**：`.task/<迭代>/01-需求澄清.md`（原文摘要、澄清问答、被否候选、用户裁定、链接），用 `assets/分阶段记录模板.md`。判定为较大改动时，同时按 `paneasypush-requirements` 落 `docs/需求/<业务名>/<日期>-<需求名>.md`。
- **停下**：较大改动停关卡①；小改动不停。
- **失败**：业务缺口未答 → 停在该阶段，只推进不依赖答案的部分。

## 阶段 2：设计方案

- **动作**：读 `paneasypush-requirements` 的方案部分及其技术方案模板，产出复用点、职责划分、数据流、状态与事务、接口契约、SQL 与索引策略、实施步骤、验收用例。**完成后复核一次复杂度判定**（方案常暴露更多改动点）。
- **产物**：`.task/<迭代>/02-设计方案.md`（候选方案、被否原因、裁定、链接）。判定为较大或涉及接口/DDL 变化时，同时落 `docs/技术方案/<需求名>技术方案.md`。
- **停下**：较大改动停关卡②；小改动不停。
- **失败**：设计冲突 → 列出冲突与影响交给用户，不自行挑一句。

## 阶段 3：编码实现

- **动作**：读 `code-standards` 及其必读的规范正文与 Java 开发质量流程，按方案做最小完整实现；同步 Mapper XML、DTO、校验与中文注释；跑注释门禁 `python3 <repo-root>/.agents/skills/scripts/check_java_comments.py --base <base-ref>`。
- **产物**：`.task/<迭代>/03-实现记录.md`（动作、命令、观察结果、证据、结论，加"改动文件清单 ↔ 设计章节"映射）。
- **停下**：否。
- **失败**：实现中发现方案缺口 → 记入 `迭代说明.md` 的未决项，继续不依赖该缺口的部分；缺口影响业务时按阶段 1 的提问规则澄清。

## 阶段 4：编写单元测试

- **动作**：按验收条件写定向测试，落各模块 `src/test/java`，包结构与主代码对齐，命名沿用 `*Test` / `*ContractTest` / `*SqlContractTest` / `*PolicyTest` 惯例（JUnit 4 + Mockito）。验证业务结果，不只 verify 方法调用。不强制 TDD、不设覆盖率门槛，但金额、权限、状态流转、幂等、迁移必须有针对性用例。
- **产物**：`.task/<迭代>/04-单元测试.md`（测试类/用例 ↔ 验收条件映射）。
- **停下**：否。
- **失败**：测试无法在本地运行（如需要外部依赖）→ 记 `NOT_RUN` 与原因，不伪造通过。

## 阶段 5：mvn 全量单测

- **动作**：在 `<repo-root>` 执行 `./mvnw test`（根 pom 为 packaging=pom 的 7 模块 reactor）。失败按 `references/异常与边界处理.md` 的 E1/E2/E3 分流：E1 本次引入 → 自动修复最多 2 轮，每轮先用 `./mvnw -pl <module> -am -Dtest=<Class> -Dsurefire.failIfNoSpecifiedTests=false test` 定位，轮末重跑全量。
- **产物**：`.task/<迭代>/05-测试执行.md`（轮次表：轮次 / 命令 / 结果 / 失败类 / 处理）。
- **停下**：否，除非 E3。
- **失败**：E3（2 轮后仍失败或无法判定归属）→ 停下报告失败类、断言、原始报错、已尝试修复，**不进入阶段 6/7**。
- 注意 `AGENTS.md` 约束：`application-local.yml` 指向共享测试环境，**只读**。测试不得写入共享环境数据；需要写入验证时用 Mock 或独立隔离数据库。

## 阶段 6：Review

- **动作**：读 `paneasypush-java-review`，同时回答两个结论——**需求/设计符合性**与**代码质量**；核对实现与 `02-设计方案.md` 的一致性、`code-standards` 的规范与注释门禁；额外检查 `.task/` 是否出现 `docs/` 正文的整段复制。
- **产物**：`.task/<迭代>/06-审查报告.md`（结论摘要 + 链接）。较大改动或用户要求落盘时，正本写 `docs/代码审查/<日期>-<范围>审查.md`。
- **停下**：否，除非 D2/D3。
- **失败**：按 `references/异常与边界处理.md` 的 D1/D2/D3 分流；P0/P1 修复后需独立复查；同一问题连续 2 轮无进展 → 停下升级给用户。

## 阶段 7：推送与部署（子流程：references/部署到测试环境.md）

- **动作**：**关卡③——所有改动都停**。展示待提交文件清单、commit message、合并路径（`origin/dev` + 迭代分支 → `env_test`）、目标远端与分支、部署目标服务器与影响面（测试环境在打包与重启期间不可用）。确认后生成"确认凭据"（用户原话摘要 + 时间），读本 skill 的 `references/部署到测试环境.md` 并按其阶段 2~5 执行。
- **产物**：`.task/<迭代>/07-推送记录.md`（commit SHA、`origin/env_test` SHA、服务器 HEAD、jar 时间戳、端口状态、失败与恢复记录）。
- **停下**：是，所有改动都停。这一次确认**同时授权推送与部署**。
- **失败**：子流程报告 merge 冲突、push 被拒、ssh 不通、服务器分支不对或脚本非零退出 → **停下交给用户**，不得自行修改仓库或服务器配置、不得 force push、不得自行回滚。
- **如实性**：区分"已推送" / "已部署" / "业务可用"三种状态。端口在监听不等于业务正常，没有实际接口验证就不要写"验证通过"。

## 推进规则

- 中间阶段（3、4、5、6）**连续执行不停**；只有阶段 1、2、7 可能停。
- 前置关系：阶段 5 全量测试通过 → 才能进阶段 6；阶段 6 无未解决 P0/P1 → 才能进阶段 7。
- 每阶段开始把 `迭代说明.md` 进度表状态置 `doing`，结束置 `done` 并写产物路径与证据（命令 + 结果摘要）。
- 中途发现新的硬信号（例如实现时才知需要 DDL）→ 升级为较大改动，在下一个关卡报告，**不回溯补停**。
- 恢复会话：先读最新 `.task/*/迭代说明.md` 的进度表与关卡记录，只做未完成阶段，不重跑已完成工作。

## 红线

- 禁止 `-DskipTests`、`-Dmaven.test.skip`、删除测试、改断言使其通过、把失败写成通过。
- 禁止用 Mock 结果冒充真实环境验证。
- 未执行的检查一律写 `NOT_RUN` 并附原因，不宣称通过。
- 禁止 force push、禁止未授权的 rebase/merge、禁止改写远端历史。
- 提交时禁止 `git add -A` / `git add .` / `git add -u`——按显式路径添加，避免带入 `target/`、`.idea/`、日志等无关内容。

## 引用

- `references/复杂度判定与确认关卡.md` — 大小改动判定信号、判定时机、关卡话术模板。
- `references/异常与边界处理.md` — 测试失败分流、审查不一致分档、跨项目降级、需求模糊判据、推送与部署失败处置。
- `references/部署到测试环境.md` — 阶段 7 子流程正文：本地合并到 `env_test`、推送、ssh 部署、验证与报告。
- `references/部署环境与故障处理.md` — 部署环境事实、hook 现状、冲突与失败处理、回滚步骤。
- `references/产物落点与防重复.md` — `.task/` 与 `docs/` 的唯一归属表与防重复规则。
- `assets/迭代说明模板.md`、`assets/分阶段记录模板.md`。
