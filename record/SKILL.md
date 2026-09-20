---
name: record
description: 日常记录——默认快速写入桌面 MMDD记录.txt;问答概要用真实"提问→回答完成"时刻(解析会话transcript);按问答真实日期判定归属日期,支持前一天对话第二天补录(自动归前一日,桌面无txt则从本地归档取回);跨天自动归档真正陈旧txt;第二步从对话抽取个人画像落 memory,与 /evolve 分工
argument-hint: "[可选:时间线事项;含'全天/全部会话'跨会话取当天;含'强制'则删除/绕过互斥锁]"
disable-model-invocation: true
---

# 任务：日常记录(本地txt为主 + 本地归档 + 真实时间戳 + 按真实日期归属)

## 模型
两份存储(桌面工作副本 + 本地归档),内容格式一致(markdown 三段):
- **桌面 txt**(快):`~/Desktop/<MMDD>记录.txt`(如 `0814记录.txt`),某日工作副本。
- **本地归档**:`~/claudeRecord/<MMDD>记录.txt`,陈旧日 txt 的归档处,兼作补录时的取回源。
- **真实时间戳**:问答与时间线的时刻**来自解析会话 transcript**(提问发送时间 / 回答完成时间),不再是 `/record` 触发时刻。
- **按真实日期归属**:本次记录写哪天,由**对话本身的日期**决定(不是 `/record` 触发日)。解决"前一天的对话,第二天才执行 /record"——自动归到前一天,而非错误归到今天。

## 固定参数
- 本地归档目录:`~/claudeRecord/`(陈旧日 txt 归档处;兼作补录取回源)
- transcript 解析脚本:`~/.codefuse/engine/cc/record-data/parse_session.py`(自包含,自动定位当前会话 jsonl,UTC→+08,只输出精简 TSV)
- 桌面 txt 路径:`~/Desktop/<MMDD>记录.txt`
- 跨会话关键词(命中则解析当天所有会话):`全天`、`全部会话`。

## 内容格式(三段,极简原则;txt 通用)

### 一、会话问答概要(按会话分组 / 问题完整 / 答案极简 / 真实时刻)
**以「会话」为维度分组,不把多个会话混在一个时间线里。** 同一 `sid` 的若干问答归到同一会话块;不同 `sid` 各自成块,块内按时间排,块间按各块首条 Qtime 排序。
```markdown
### 会话 · <首Qtime>→<末Atime> · <一句话主题> · sid:<8位>
#### <Qtime> → <Atime>
**Q:** <用户原话问题,完整保留,不改写不裁剪>
**A:** <极简概要:只留"做了什么/结论/关键数字或参数",≤2 行,砍铺垫推导客套>
```
- 会话块头 `<一句话主题>` 由你据该会话问答归纳(≤12 字);`<8位>` = parse 输出首列 `sid`。**追加时按 sid 匹配**:命中既有 `sid:<8位>` 块 → 把新 `####` 问答并进该块末尾(并顺手把块头 `<末Atime>` 更新为更晚者,`<首Qtime>` 更新为更早者);未命中 → 新建会话块插到「## 一」末尾(下个 `### 会话` 或 `## ` 之前)。
- `<Qtime>`=提问发送时刻,`<Atime>`=回答完成时刻,均 `HH:MM:SS`,来自 transcript。
- **问题必须完整;答案极度精炼是硬性要求。**

### 二、全天时间线(按真实时间顺序的并行事项)
```markdown
- <HH:MM:SS> 事项一句话(例:16:48:02 设计record命令;17:08:41 讨论精确时间戳方案)
```
- 自动项:每个新记录的问答 → 一条,用其 `Qtime` + 问题一句话浓缩。
- 手动项:`$ARGUMENTS` 里用户附带的事项;能识别 `HH:MM` 开头则用其时间,否则用 `NOW`(`/record` 触发时刻)。
- 一条一行,简短。**这段就是纯时间线维度,跨所有会话混排,与「一」的会话维度互补。**

### 三、任务视角(当日并发处理的事项 / 起止时间 / 甘特条)
**把一天里并发的"事项"画成甘特条,一眼看出哪几件事在同时推进。** 一个会话 = 一个任务条(同一主题的连续问答);起=遍历该会话块内所有 `#### HH:MM:SS → HH:MM:SS` 得到的最早 Qtime,止=最晚 Atime;任务条横向落在当天时间轴上,多条横向重叠即代表该时段并发。
```markdown
时间轴(每格=30min):           09:00 09:30 10:00 10:30 11:00 11:30 12:00
任务1  09:30→11:15  1h45m 优化record skill        ▓▓▓▓▓▓░░░░░░░░░
任务2  10:00→10:45  0h45m 讨论时间戳方案           ░░░▓▓░░░░░░░░░░
任务3  11:30→13:00  1h30m 直付通诊断               ░░░░░░░░░▓▓▓▓▓▓
```
- 渲染规则(ASCII,txt 通用,不依赖 mermaid):
  1. 时间轴起点 = 当日所有任务最早 Qtime 向前对齐到整点;终点 = 最晚 Atime 向后对齐到整点;每 30min 一格。
  2. 每任务一行:从其「起」对应格到「止」对应格画 `▓`,其余格 `░`,行末不接标注(起止/时长/主题放行首)。`▓` 格数 = round(任务时长 ÷ 30min),至少 1 格。
  3. 任务按起始时间排序;行间纵向对齐,条形横向重叠即并发了几件事。
  4. 同一 sid 跨多次补录合并为一条;主题复用「一」该会话块的一句话主题;时长 = 止 − 起。
- **每次写入时「三」整段重建**(基于当前 txt「一」中所有会话块),不做增量追加——它是「一」的派生视图。
- 当日仅 1 个会话照常画一条;无任何任务写"今日无任务"。

## 执行流程

### -1. 取互斥锁(防止并发 /record 把同一日 txt 写串)

锁:`~/.codefuse/engine/cc/record-data/record.lock` 用 `mkdir` 原子占用,内部写 `owner` 文件记录获取时刻(Unix 秒)。**取锁逻辑全部在本步 bash 块内完成,先于步骤 0。**

- 把本次 `$ARGUMENTS` 原文填入下面 `ARGUMENTS=` 一行后整段执行。若 `ARGUMENTS` 含 `强制` → **FORCE 模式**:`rm -rf` 锁、跳过取锁、直接进步骤 0(`强制` 一词从后续 CONTENT/关键词判定中剔除)。
- 否则取锁:**取到 → 继续;取不到 → 每 30s 重试;累计等满 10m 仍取不到 → 中止本次 /record**(回报"取锁超时,已中止,可用 /record 强制 绕过",不再走后续任何步骤)。
- **崩溃自愈**:锁龄 >10m 视为前次崩溃残留,自动清掉后取(所以一次异常未释放也不会永久卡死)。
- 锁在**步骤 0~第二步 memory 全部完成后、最终回报前释放**(见末步「释放锁」)。

```bash
ARGUMENTS='<填入本次 $ARGUMENTS 原文>'
LOCK=~/.codefuse/engine/cc/record-data/record.lock
STALE_SEC=600   # 锁龄超过此值视为崩溃残留
RETRY_SEC=30
MAX_WAIT_SEC=600

case "$ARGUMENTS" in *强制*) FORCE=1;; *) FORCE=0;; esac

acquire_record_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$ $(date +%s)" > "$LOCK/owner"   # pid + 获取时刻(Unix秒)
    return 0
  fi
  if [ -f "$LOCK/owner" ]; then
    held=$(awk '{print $2}' "$LOCK/owner" 2>/dev/null)
    now=$(date +%s)
    if [ -n "$held" ] && [ $((now - held)) -ge "$STALE_SEC" ]; then
      rm -rf "$LOCK"; return 2   # 崩溃残留,清掉让外部立即重试
    fi
  fi
  return 1   # 被活锁占着,继续等
}

if [ "$FORCE" = "1" ]; then
  rm -rf "$LOCK"
  echo "record: 强制模式,已清锁并跳过取锁"
else
  start=$(date +%s)
  while true; do
    acquire_record_lock; rc=$?
    if [ "$rc" -eq 0 ]; then echo "record: 取锁成功"; break; fi
    if [ "$rc" -eq 2 ]; then continue; fi
    if [ $(( $(date +%s) - start )) -ge "$MAX_WAIT_SEC" ]; then
      echo "record: 取锁超时(>${MAX_WAIT_SEC}s),已中止。可用 /record 强制 绕过" >&2
      exit 7
    fi
    sleep "$RETRY_SEC"
  done
fi
```
- `exit 7` ⇒ 取锁中止:agent 见此输出直接回报中止、结束,不再执行步骤 0 及之后。

---

### 0. 取日期与 CONTENT
```bash
TODAY=$(date +%Y%m%d); MMDD=$(date +%m%d); NOW=$(date +%H:%M:%S)
```
- `CONTENT = $ARGUMENTS`(已在步骤 -1 剔除 `强制` 一词)。
- `$ARGUMENTS` 命中**跨会话关键词** → 解析时给脚本加 `--today`(默认只解析当前会话)。

---

### 解析当前会话拿真实时间戳
```bash
python3 ~/.codefuse/engine/cc/record-data/parse_session.py --exclude ~/Desktop/<MMDD>记录.txt --marker "<锚点>"
```
- `<锚点>` = **本会话上一条真实提问的前 ~15 个字**(你从当前上下文知道,例如 `按方案 A 落地`)。**必填**:并发多会话时"latest mtime"会误选到别的会话,必须用本会话的提问作锚点定位。`$ARGUMENTS` 命中"全天/全部会话"时改用 `--today`(替代 `--marker`,扫当天所有会话)。
- 输出 TSV(6 列):`sid<TAB>Qdate<TAB>Qtime<TAB>Atime<TAB>Qtext<TAB>Aexcerpt`。
  - `Qdate`=提问发送的 `YYYYMMDD`(已 UTC→+08);`Qtime/Atime`=`HH:MM:SS`;`Aexcerpt`=回答末段≤300字(供概要参考)。
  - **已自动去重**(Q 签名命中 `--exclude` 指定 txt 已有 `**Q:**` 行的会被跳过);文件不存在时 `--exclude` 自动忽略。
- 把输出当作"本次新增问答清单"。对每条:`Q` 用 `Qtext` 原文;`A` 由你基于 `Aexcerpt` + 当前上下文对该轮回答的认知,浓缩成 ≤2 行。
- 若输出为空且 `CONTENT` 为空 → 无新内容,直接回报"无新问答,未写入"并结束。

#### 0.5 判定本次记录归属日期 `RECORD_DATE`(关键!)
- 取解析输出**最后一条新问答的 `Qdate`** 作为 `RECORD_DATE`(本次记录归属日期,后续全程按此日期写)。
  - 用最后一条而非第一条:因为一次补录往往跨越多天,最后一条问答最贴近"用户当前在回头处理的那天",归它最合理。
- 兜底(脚本未输出 `Qdate` 时):若最后一条 `Qtime > NOW` → `RECORD_DATE=TODAY-1`(前一天补录);否则 `RECORD_DATE=TODAY`。
- 边界:若 `RECORD_DATE > TODAY`(异常未来日期)→ 按 `TODAY` 处理。
- `RECORD_MMDD` = `RECORD_DATE` 的后 4 位;本次桌面 txt 路径 = `~/Desktop/<RECORD_MMDD>记录.txt`;补录场景的取回源 = `~/claudeRecord/<RECORD_MMDD>记录.txt`。

---

### 主流程(默认:只写本地,不联网)

> 全程以 `RECORD_DATE` 为目标日期,不是 `TODAY`。`RECORD_DATE` 可能等于 `TODAY`(正常当天),也可能小于 `TODAY`(补录前一天)。

#### L1. 检测跨天 + 归档真正陈旧 txt
glob `~/Desktop/[0-9][0-9][0-9][0-9]记录.txt`,对每个匹配文件:
- 文件名前 4 位 = MMDD;映射 `YYYYMMDD`(oldDate):MMDD 数值 ≤ 今天取当年,否则取上年(跨年兜底)。
- `oldDate != TODAY 且 oldDate != RECORD_DATE` → 真正的陈旧 txt:`mkdir -p ~/claudeRecord` 后 `mv` 到 `~/claudeRecord/<MMDD>记录.txt`(归档,桌面不再保留)。多个逐个处理。
- `oldDate == RECORD_DATE` → 本次目标副本,保留,进 L2。
- `oldDate == TODAY`(且 `RECORD_DATE<TODAY`)→ 今天副本,保留不动(本次不碰)。

#### L2. 追加本次增量到 `RECORD_DATE` 的 txt
- 增量 = 上面解析出的**新问答**条目(带真实 `Qtime→Atime`,按 `sid` 并入「一」对应会话块——命中既有块则追加、否则新建块) + **时间线**条目(每条新问答一条 + `CONTENT` 手动项) + **重建「三、任务视角」整段**(遍历「一」所有会话块的 `####` 时刻重画甘特条)。
- 桌面模板(新建空壳时用):
  ```markdown
  # <RECORD_DATE> 工作记录

  ## 一、会话问答概要

  ## 二、全天时间线

  ## 三、任务视角
  ```
- **情形 A:`~/Desktop/<RECORD_MMDD>记录.txt` 存在**(含 `RECORD_DATE==TODAY`,以及前一天 txt 还在桌面的情况)→ 读出,新问答按 sid 并入「## 一」对应会话块(命中既有块追加 `####`、未命中新建 `### 会话` 块于「## 一」末尾),时间线并到「## 二」末尾,「## 三」整段重建,写回。用 Write/Edit,不要 shell `>`。
- **情形 B:`~/Desktop/<RECORD_MMDD>记录.txt` 不存在**(前一天早已归档,最常见的前一天补录场景)→ 归档是唯一存储,必须"取回→剔重→只追加增量→放回",**严禁用本次增量直接覆盖归档副本**:
  1. `~/claudeRecord/<RECORD_MMDD>记录.txt` 存在 → `cp` 回 `~/Desktop/<RECORD_MMDD>记录.txt`(保留归档已有问答/时间线)→ **重跑一次解析** `python3 parse_session.py --exclude ~/Desktop/<RECORD_MMDD>记录.txt --marker "<锚点>"`,基于取回的正文去重,只让真正新增的问答通过 → 把增量按情形 A 规则追加进 txt → 把合并后的 txt `cp` 回 `~/claudeRecord/<RECORD_MMDD>记录.txt`(更新归档副本,保持两边一致)。
  2. `~/claudeRecord/<RECORD_MMDD>记录.txt` 不存在(前一天从未归档)→ 用上面模板建空壳 `~/Desktop/<RECORD_MMDD>记录.txt` → 追加增量。

#### L3. 回报
一句话:本次记录已归到 `RECORD_DATE`,`~/Desktop/<RECORD_MMDD>记录.txt`(新建/追加)或归档 `~/claudeRecord/<RECORD_MMDD>记录.txt`(取回合并/新建),本次几条问答 / 几条时间线 / 几个任务条(「三」)。`RECORD_DATE<TODAY` 时补一句"为补录前一日对话";`RECORD_DATE==TODAY` 时维持原口径,L1 跨天归档则附"旧日 <oldDate> 已归档到 ~/claudeRecord"。

---

## 第二步:个人画像 → memory(与 /evolve 分工)

**第一步(L1-L3)完成后执行。** 复用当前对话上下文(已在 context,不重读 transcript、不做深度推断),识别与**用户个人及工作长期相关**的信息,落到 memory 目录 `/Users/fq/.codefuse/engine/cc/projects/-Users-fq-IDEA/memory/`。

**负责范围(个人画像类)**
- 习惯 / 性格 / 偏好:工作节奏、沟通风格、效率偏好、喜恶等明确暴露的
- 职责 / 角色:负责的领域、应用、模块、owner / 备 owner 关系
- 工作内容:需求路线图、半年 / 年度目标、在推进的事项、阶段性重点
- 团队 / 对接:团队、汇报线、同组协作人、跨团队业务接口人
- 外部资源:常态访问的仪表盘 / 文档 / 工单链接

**边界:归 /evolve,这里不收** —— 知识、技能、踩坑、试错、经验、流程改进结论。

**判定与去重**
- 仅记"非显而易见 + 跨会话仍有用"。仓库 / git / CLAUDE.md 已有、或仅本对话有意义的不收;只记明确暴露的事实,不做性格推测。
- 写前读 `MEMORY.md` 索引(或用上下文已有的),按命中情况处理:
  - 命中 `[骨架待填]` 条目 → Edit 该骨架文件填实,顺手去掉 `[骨架待填]` 标记,并更新 `MEMORY.md` 对应行的 hook。
  - 命中已有条目 → Edit 补充 / 更新(内容过时则改,不要重复记;被证伪则删除)。
  - 无落点且确有价值 → 新建 `fq-<slug>.md`,带 frontmatter(`name` / `description` / `metadata.type`),并在 `MEMORY.md` 末尾加一行索引。
- type 选型:`user`(身份 / 性格 / 职责 / 偏好)、`project`(目标 / 路线图 / 进行中事项,相对日期转绝对)、`feedback`(工作习惯 / 协作纠正,带 **Why** / **How to apply**)、`reference`(对接人 / 链接)。

**回报(极简)**:一句话——扫到 N 条画像信息 → 写入 / 更新了哪些文件;或"无可记"。不展开推断过程。

---

## 末:释放锁(任何完成/收尾路径都要做)

```bash
rm -rf ~/.codefuse/engine/cc/record-data/record.lock
```
FORCE 模式同样删一次(幂等)。万一漏释放也无伤大雅:锁龄 >10m 自动自愈,或下次 `/record 强制` 清理。

---

## 硬性注意
- **互斥锁**:步骤 -1 先取锁(`~/.codefuse/engine/cc/record-data/record.lock`),覆盖整个"解析→写 txt→归档→memory"流程,末步释放;取不到 30s 重试、10m 中止;`强制` 删锁跳过。锁龄 >10m 自愈防止崩溃永久卡死。
- **「一」按会话(sid)分组**,不混排;追加时按 parse 输出首列 `sid` 匹配既有会话块,命中并入、未命中新建。**「三、任务视角」是「一」的派生视图,每次写入整段重建**(遍历「一」各会话块内 `#### HH:MM:SS → HH:MM:SS` 取首末时刻画甘特条),绝不增量追加以免条形碎片化。
- 本地模型,**不联网**;两处例外:① L1 跨天归档真正陈旧 txt 到 `~/claudeRecord/`;② **前一天补录(`RECORD_DATE<TODAY`)**——桌面有该日 txt 则直接追加;桌面无该日 txt 则**从 `~/claudeRecord/` 取回合并再放回**(归档是唯一存储,必须"取回→剔重→追加→放回")。其余 `RECORD_DATE==TODAY` 的流程不碰归档。
- **取回归档正文后必须"取回→重跑 parse 剔重→只追加增量→放回"**,严禁用本次增量直接覆盖归档副本(会丢历史问答)。
- 问题必须完整保留原话;答案极度精炼,宁可过简不可啰嗦。
- 时间戳一律取自 `parse_session.py` 输出(transcript ground truth);`NOW` 仅用于无真实时间的手动时间线项。
- 桌面 txt 用 Edit/Write 维护,不要 shell `>` 重定向;归档移动 / 复制用 `mv` / `cp`。
- 去重靠脚本按 Q 签名(去标点后前 15 字符)比对 `--exclude` 指定 txt 已有 `**Q:**` 行;同一问不会被重复记录。
- 解析脚本定位当前会话靠 `--marker`(本会话上一条真实提问前~15字);**不传 marker 时退化为 latest-mtime,并发多会话会误选**,故命令必须传 marker。`--today` 才扫当天所有会话(噪声较多,仅"全天"时用)。
- 解析脚本输出已含 `Qdate`(YYYYMMDD)列,据此判定 `RECORD_DATE`;若脚本因故没输出 `Qdate`,退化为"最后一条 `Qtime>NOW` ⇒ 前一天"的兜底判断。
