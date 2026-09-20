#!/usr/bin/env python3
"""
AbutionGraph 公众号文章保存适配脚本

在 wechat-article-spider skill 通用抓取逻辑之上，按 AbutionGraph 现有的扁平结构输出：
  AbutionGraph Ontoflow本体智能/
    ├── images/                       ← 公共图片目录
    └── YYYYMMDD-标题.md              ← md 直接放顶层（无子文件夹）

与 save_aibiancheng_article.py 的区别：
  - 扁平结构（非嵌套）
  - md 图片引用 images/xxx.jpg（非 ../images/）
  - safe_name 用黑名单方式（只过滤 Windows 非法字符），匹配现有 44 篇文件命名风格

用法:
    python save_abutiongraph_article.py <文章URL> [--force]

保护：同名 .md 已存在时默认跳过，除非传 --force。
"""
import os
import sys
from datetime import datetime

# 复用 skill 通用模块
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from scraper import fetch_article, extract_article_content, html_to_markdown
from images import extract_images, download_image, get_image_filename

# 输出根目录：AbutionGraph 文件夹
BASE_DIR = os.path.normpath(
    r"E:\我的科研1\003 大模型LLM\000 LLM Agent学习资料\004 微信公众号\AbutionGraph Ontoflow本体智能"
)
IMAGES_DIR = os.path.join(BASE_DIR, "images")


def safe_name(title: str) -> str:
    """生成文件系统安全的名称（黑名单方式，保留更多标点以匹配现有风格）"""
    safe = title[:80].replace("/", "_").replace("\\", "_")
    # 只过滤 Windows 非法字符，其余保留（现有文件保留了冒号/方括号等）
    illegal = set(':*?"<>|')
    safe = "".join("_" if c in illegal else c for c in safe)
    safe = safe.strip().rstrip(".")
    return safe or "wechat-article"


def save_images_flat(images, base_url: str) -> dict:
    """下载图片到同级 images/ 目录，返回 url -> 相对路径(images/xxx) 映射"""
    os.makedirs(IMAGES_DIR, exist_ok=True)
    url_mapping = {}
    downloaded = 0
    for idx, (img_url, _img_tag) in enumerate(images, 1):
        if img_url in url_mapping:
            continue
        filename = get_image_filename(img_url, idx)
        save_path = os.path.join(IMAGES_DIR, filename)
        if download_image(img_url, save_path):
            downloaded += 1
            # 扁平结构：md 在顶层，图片在同级 images/，所以用 images/xxx
            url_mapping[img_url] = f"images/{filename}"
    print(f"✅ 下载 {downloaded}/{len(images)} 张图片 → {IMAGES_DIR}")
    return url_mapping


def main():
    if len(sys.argv) < 2:
        print("❌ 用法：python save_abutiongraph_article.py <文章URL> [--force]")
        sys.exit(1)

    article_url = sys.argv[1]
    force = "--force" in sys.argv

    print(f"📥 抓取文章：{article_url}")

    # 1. 抓取
    html = fetch_article(article_url)
    if not html:
        print("❌ 抓取失败")
        sys.exit(1)
    print("✅ 抓取成功")

    # 2. 解析
    article = extract_article_content(html, article_url)
    print(f"📰 标题：{article['title']}")
    if article["author"]:
        print(f"✍️  作者：{article['author']}")
    if article["publish_date"]:
        print(f"📅 发布：{article['publish_date']}")

    # 3. 生成文件名
    publish_date = article["publish_date"] or datetime.now().strftime("%Y-%m-%d")
    date_prefix = publish_date.replace("-", "")[:8]  # YYYYMMDD
    safe_title = safe_name(article["title"])
    md_filename = f"{date_prefix}-{safe_title}.md"
    md_path = os.path.join(BASE_DIR, md_filename)

    # 4. 保护：同名 md 已存在则跳过
    if os.path.exists(md_path) and not force:
        print(f"⚠️  目标文件已存在，跳过（传 --force 可覆盖）：{md_path}")
        sys.exit(0)

    # 5. 提取并下载图片到同级 images/
    print("🖼️  提取图片...")
    images = extract_images(article["raw_html"], article_url)
    print(f"📸 找到 {len(images)} 张图片")
    image_mapping = save_images_flat(images, article_url) if images else {}

    # 6. 转 Markdown
    print("📝 转换 Markdown...")
    markdown_content = html_to_markdown(article["content_html"], article_url, image_mapping)

    # 7. 元数据头部（与现有 AbutionGraph frontmatter 风格一致）
    frontmatter = [
        f"# {article['title']}",
        "",
    ]
    if article["author"]:
        frontmatter.append(f"**作者**: {article['author']}")
    if article["publish_date"]:
        frontmatter.append(f"**发布时间**: {article['publish_date']}")
    frontmatter.append(f"**原文链接**: {article_url}")
    frontmatter.append(f"**抓取时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    frontmatter += ["", "---", ""]

    final_content = "\n".join(frontmatter) + markdown_content

    # 8. 写入扁平 md
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(final_content)

    print(f"✅ 文档保存：{md_path}")
    print(f"📁 图片目录：{IMAGES_DIR}")


if __name__ == "__main__":
    main()
