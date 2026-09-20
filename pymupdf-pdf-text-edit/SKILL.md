---
name: pymupdf-pdf-text-edit
description: 用 PyMuPDF 在已有 PDF 里插入/替换/修改文本时必读（在 PDF 里加字、改字、替换/删除某段文字、redact、insert_text、中文乱码 \x00、已子集化 PDF 二次编辑文字变乱码、文本提取顺序被打乱、保读取顺序、splice 进 content stream、内嵌/子集字体缺字形、subset_fonts、嵌入字体、get_texttrace、文件变大、文字溢出被截断、行宽超页面、多页 PDF、编辑简历 PDF、移动/上移/下移/整体调整 PDF 文字位置、调整小节间距、update_stream 保存后报 syntax error in content stream、PDF 内容流损坏、re.subn 计数、Tm 坐标）。遇到「修改/编辑/插入/替换 PDF 文本」「PDF 中文乱码」「二次插入/二次编辑后文字 \x00」「PDF 文本提取顺序不对」「PDF 内嵌字体缺字」「PDF 文件变大几十倍」「文字超出页面/被截断」「把某段文字整体移动/调整间距」「保存 PDF 报 syntax error / 内容流损坏」等场景时使用。
---

# PyMuPDF 修改已有 PDF 文本 — 避坑清单

用 PyMuPDF 在**已有** PDF 里插入/替换文本时，以下坑全部实测踩过。渲染对了 ≠ 文本提取对了，要按需选择做法。

## 核心认知

- **文本提取顺序 = content stream 执行顺序**，不是渲染位置顺序。
- `page.insert_text()` 永远把新内容**追加**到 `/Contents` 末尾 → `get_text()` 里新文本排到整页最后，即使渲染位置正确。
- PDF 里内嵌的字体是**子集**：只有原文档出现过的字形，且通常**没有 cmap 表**（Unicode 映射靠 PDF 的 ToUnicode CMap，不靠字体 cmap）。

## 避坑清单

### 1. 别拿 `extract_font()` 出来的子集字体去 insert_text ❌
`doc.extract_font(xref)` 取出的 .ttf 是 PDF 子集，常无 cmap。用它 `insert_text(fontfile=...)` 插入中文，**渲染正常但 `get_text()` 返回 `\x00\x00...` 乱码**。
✅ 改用系统**完整** CJK 字体（macOS：`/Library/Fonts/Arial Unicode.ttf`，或 MuPDF 内置 `fontname="china-s"`）。注意 `china-s` 字形更宽，易超出原布局，优先用 Arial Unicode。

### 2. insert_text 嵌入字体后必须 `doc.subset_fonts()` ❌
不子集化会把完整字体（Arial Unicode 23MB）整个嵌入，输出文件暴涨（153KB → 15MB）。
✅ `doc.subset_fonts()` 后再 `save`，只保留用到的字形。

### 3. `doc.save()` 不能覆盖自己打开的文件 ❌
报 `ValueError: save to original must be incremental`。
✅ 先 `save` 到临时路径，验证后再 `mv` 覆盖。

### 4. redact + insert_text 会打乱文本提取顺序（最隐蔽）⚠️
`add_redact_annot` + `apply_redactions()` 删旧文本、`insert_text` 插新文本：渲染、提取内容都对，但新文本被提取到页面内容末尾。**以文本提取为核心的产品（简历/文档解析 CLI）这是明显回归。**
✅ 需要保读取顺序时，手术式 splice 进主 content stream：
1. redact 后 `main_xref = page.get_contents()[0]`，`base = page.read_contents()` 取主流字节；
2. 在**同一页面** `insert_text` 生成正确编码的字形片段（这会追加多个 stream：一个 `q`、一个 `Q`、一个含 `BT` 的正文流），取含 `BT` 的那个，正则抠出 `[<hex>]TJ`；
3. 把片段坐标换算进主流的变换坐标系，Tf 字号按同比例缩放（见第 6 条）；
4. 找锚点（如已知文本块的 `Tm/Tj`），在其后 splice：` BT 1 0 0 -1 x y Tm /FontName 13 Tf [<hex>]TJ ET `；
5. `doc.update_stream(main_xref, new_content)` 写回；`page.xref_set_key(...)` 已把 `/Contents` 改回 `[main_xref 0 R]`。
简单场景（不关心提取顺序、不追求字体完全一致）用 redact+insert 就够。

### 5. 子集字体缺字形 ⚠️
想复用的内嵌字体只有原文档出现过的字符。缺字就换完整字体，别硬凑。**但 ToUnicode 覆盖 ≠ 字体程序里有字形轮廓**：子集器常把完整 ToUnicode CMap 抄进 PDF（文本提取正常），轮廓却只留子集。实测：换用某子集字体后 `get_text()` 解出「专业技能」、span 字体/字号全对，渲染却是**整段空白**（该区像素 0% 墨迹）。要确认字形真的存在，直接解析该字体的 font program（`doc.extract_font(xref)[3]` 拿字节，查 `glyf`/`loca` 表里目标 GID 的轮廓长度>0），或改完**渲染验像素**。

### 6. 坐标换算用已知锚点反推，别手算 cm 矩阵 ⚠️
内容流的 `cm` 变换 + Tm 的 `1 0 0 -1` 翻转极易算错。取一段已知文本：其 fitz bbox 坐标 ↔ 其 content 里的 `Tm` 坐标，两个点反推线性映射（本例页面坐标 / 0.75 = 内容坐标）。同理 Tf 字号 = 目标渲染字号 / 0.75。

### 7. PyMuPDF API 版本差异大 ⚠️
- `fitz.get_text_length` 没有 `font=` 参数 → 用 `fitz.Font(fontfile=...).text_length(text, fontsize=)`。
- `Document.get_contents` / `Document.add_stream` / `Document.clean_contents` 不存在 → 用 `page.get_contents()`、`doc.update_stream(xref, bytes)`、`page.clean_contents()`。
- 不确定就 `print([m for m in dir(obj) if 'content' in m.lower()])` 或跑最小片段。

### 8. 调试字体归属：别信 get_texttrace() 的 uni 字段 ⚠️
`page.get_texttrace()` 返回的 char 元组里 `uni` 是**原始 CID 码**（content stream 里写的那个 2 字节码），**不是解析后的 unicode**（例如「北」显示 `U+2489`，那其实是'⒉'装饰符，极易误导）。且同一份 PDF 常有**多个子集字体同名**（如 F5/F6 都叫 "BAAAAA+AlibabaPuHuiTi-Regular"），PyMuPDF 按字体名合并 span，看不出到底是哪个 xref 在画。
✅ 要确认某段文本用哪个字体资源：直接读 content stream，找该文本 `BT` 前的 `/Fx` `Tf` 算子（`raw.count('/F5')` 看频次）。别靠 trace/span 的字体名或 uni 推断。

### 9. 保提取顺序的推荐落法：临时页生成算子 + 原位 splice 进同一 BT 块 ✅
比第 4 条的坐标换算更省事：**不用碰 cm 矩阵、不用算坐标**，天然保提取顺序。
1. **临时页生成正确编码**：开一个 throwaway `fitz.open()` + `new_page()`，`insert_font(fontname='X', fontfile=系统完整字体)` 后 `insert_text()` 画目标文本，`read_contents()` 抠出 `[<hex>]TJ` 数组。hex 就是 GID，用 `fitz.Font(fontfile=...).has_glyph(ord(ch))` 核对（如「不」=0x209C）。
2. **原位替换**：在原 content stream 里找到要改的旧字形算子（如 `<2489>Tj 12.792023 0 Td <201e>Tj`，须先 `count()==1` 确认唯一），整段替换为 `/新字体 13 Tf [<hex>]TJ`。**在同一 BT 块内**用 `Tf` 切字体 + TJ 画字，自动复用原 BT 的坐标系和当前光标位置——光标正好停在旧文本起点，零换算。
3. **资源与收尾**：新字体用 `page.insert_font()` 加进页面 Resources（若临时页生成的字体名对不上，splice 前先 insert_font）；`doc.subset_fonts()` 防体积暴涨；`save` 到临时路径再覆盖。
优势：新算子就在原位，`get_text()` 整行仍连贯；只替换旧字形、不用 redact；字号/颜色继承 BT 上下文（颜色对不上就补 `rg`）。

### 10. 已子集化的 PDF 不要再二次 insert 文字（最隐蔽的 \x00 来源）⚠️
一份已经 `subset_fonts()` 保存过的 PDF，再次打开往里 `insert_text`：若用与之前相同的 `fontname`（如 `f0`）再 `insert_font`，会与页面上已有的**子集字体资源重名**，新文字实际落到旧子集字体 → 新字全 `\x00`（实测：首次编辑正常，对产物二次编辑时踩坑）。
✅ **每次改动都从源 PDF 重新生成**：复制一份干净源文件，把所有编辑（redact + insert）合并到**一次 pass**，最后统一 `subset_fonts()` + save。别在已编辑产物上继续叠编辑。

### 11. 文件暴涨不止靠 subset_fonts，保存要带 garbage 回收 ⚠️
`insert_text` 嵌入完整字体 + redact 会留下**重复的字体/对象**（实测 Arial Unicode 被嵌 3 份），`subset_fonts()` 不清理不可达对象，文件仍可能 225KB → 1.7MB。
✅ `doc.save(tmp, garbage=3, deflate=True, clean=True)` 再覆盖：`garbage=3` 移除不可达的重复对象，`deflate` 压缩流。保存后确认文件大小与原文件同量级。

### 12. 长行溢出页面右缘被截断：插入前先量宽 ⚠️
估算 CJK 行宽时容易低估全角宽度（Arial Unicode 全角字≈字号 pt），长行 `x1` 会超出页面宽（如 596pt）被截断（实测某行 x1=603）。
✅ 插入前用 `fitz.Font(fontfile=完整字体).text_length(text, fontsize=fs)` 预测量宽，目标 `x1 ≤ 内容右缘`（留边距）；插入后遍历 `get_text("dict")` 所有 span 断言 `x1 ≤ 页面宽`。

### 13. 先确认页数，多页 PDF 内容可能不在第 0 页 ⚠️
`get_text("text")` 只反映当前页；多页 PDF（如简历第 2 页是教育/证书）单页看会误以为内容丢了。
✅ 动手前 `len(doc)` 确认页数，逐页检查目标内容在哪；验证时逐页过（新旧两版同页像素 diff），确认改动只落在目标页/区域、其余页零变化。

### 14. `update_stream` 别自己 zlib 压缩：已有 `/FlateDecode` 的流传原始字节 ⚠️（最隐蔽的保存损坏）
content stream 对象本身带 `/FlateDecode`。往 `doc.update_stream(xref, zlib.compress(data))` 塞压缩字节、再 `save(deflate=True)` → **双重压缩**：save 报一堆 `syntax error in content stream` / `array not closed before end of file`，产物从 257KB 缩到 9KB、内容全丢。
✅ `doc.update_stream(xref, 未压缩的原始字节)`，压缩交给 `save(deflate=True)`。

### 15. 移动/重排文字块：先 dump 全部 Tm 矩阵认坐标系，别指望「包一段 cm」 ⚠️
要把某小节整体上移/下移时：
- **内容流顺序 ≠ 视觉顺序**（实测公司行画在姓名前、却渲染在姓名下方），`q ... cm ... Q` 包不出一段"视觉连续"的区域 → 只能**逐块改 TmY**。
- 同一文档可能有**多套坐标系**：Tm 矩阵的 `d` 分量是判别器——`1 0 0 -1 X Y Tm`（y 翻转，套 `.24` 顶变换 + `3.125` 块变换）与 `1 0 0 1 X Y Tm`（追加算子，`Q Q EMC` 之后的原始空间）**位移方向相反**：上移 N pt 时，前者 `TmY -= N/0.75`、后者 `TmY += N`。
- **各页的 cm 平移不同**（实测第 1 页块 cm 是 `3.125 0 0 3.125 0 -3446.875`，第 0 页是 `...0 0`），y↔渲染位置公式逐页不同，别把第 0 页的公式套到第 1 页。
- 权威位置用 `get_text("rawdict")` 的 **origin（基线）**，别用 bbox 顶。
✅ 动手前 dump 所有 `BT..ET` 块的 `Tf`/`Tm`/字体，按「渲染基线 ≥ 阈值」决定每块改多少，逐块正则替换；改完用 get_text 复查每块新基线 = 旧基线 ∓ 位移量。标题/字体换用见第 17 条。

### 16. `re.subn` 配替换函数：计数是「函数被调用次数」不是「实际替换次数」 ⚠️
`re.sub(函数, ...)` 对每个匹配都会调用函数，**即使函数返回与匹配串相同，subn 也计入一次**。实测 5 处实际改动报成 11，容易误判"正则过匹配"。
✅ 别信 subn 计数，直接对比替换前后结果验证。

### 17. 换字体最干净的办法：查子集 ToUnicode 覆盖 → 直接 splice 复用该字体资源 ⚠️
系统里可能没有目标字体文件（如 AlibabaPuHuiTi-Bold），redact+insert 又踩子集 `\x00`。若想要的字**已存在于某个已有子集字体**的 ToUnicode（读 `doc.xref_get_key(font_xref,"ToUnicode")` 流，逐个确认目标字形的 CID 都在），直接改内容流算子：把旧算子的字体名 + hex 串换掉（如 `/F7 15 Tf [<hex>]TJ`），不嵌字体、不 redact、位置不变。先 `count()==1` 确认算子唯一。前提：两字体字号换算要一致（如 `F7 20`×有效缩放 0.75 == 裸空间 `F7 15`）。
**但 ToUnicode 命中 ≠ 能渲染**（见第 5 条）：splice 前必须确认该字体程序里目标 GID 真有轮廓，否则文本层对、渲染空白（实测教训）。最稳的兜底：文档里可能没有字全的粗体子集 → 下载完整目标字体（如 AlibabaPuHuiTi-Bold 免费商用）→ `page.insert_font(fontname='新名', fontfile=完整字体)` → 流里换 `/F7`→`/新名`（CID 通常恰好一致）→ `doc.subset_fonts()` 裁小。

## 验证清单（改完 PDF 必须过）

- [ ] `doc.get_text("text")` 提取内容正确、无 `\x00`（含二次编辑场景）
- [ ] **新增/替换文本必须验渲染**：目标区域渲染出墨迹（像素计数 > 0）——`get_text` 正常但目标区 0 墨迹 = 缺字形/隐形文本，文本层验证替代不了渲染验证
- [ ] 先确认页数，多页 PDF 逐页检查目标内容/验证（`len(doc)` + 逐页 get_text）
- [ ] 文本提取顺序符合预期（尤其要保读取顺序的场景）
- [ ] 目标文本 span 的 bbox 位置/居中正确，且**所有 span 的 `x1` ≤ 页面宽度**（防溢出截断）
- [ ] 整体位移后，每个被移动块的**新基线 = 原基线 ∓ 位移量**（逐块抽查，防个别块漏改/多改）
- [ ] 文件大小没有暴涨（应和原文件同量级；必要时 `save(garbage=3, deflate=True, clean=True)`）
- [ ] 改后页面的 `/Contents` q/Q 平衡（正则 `\bq\b`/`\bQ\b` 计数一致）
- [ ] 其他页面内容未变
- [ ] 环境不支持看图时：像素级 diff（旧/新 PDF 同页渲染逐像素比较）确认改动只落在目标区域、其余页零变化
