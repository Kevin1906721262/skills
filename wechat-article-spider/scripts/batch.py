#!/usr/bin/env python3
"""
批量抓取微信公众号文章

在 main.py 单篇逻辑之上加了：串行限速、失败重试、已抓过则跳过、结果汇总。

用法:
    python batch.py <urls.txt> [输出目录] [选项]

urls.txt 每行一个地址，支持裸 URL 或 Markdown 链接语法 [标题](URL)，
空行和 # 开头的注释行会被忽略。

选项:
    --delay 8      每篇之间的间隔秒数（默认 8，微信有风控，别调太小）
    --retry 2      单篇失败后的重试次数（默认 2）
    --retry-wait 20 重试前的等待秒数（默认 20）
    --force        即使已抓过也重新抓
    --report FILE  把每篇的结果追加写入汇总文件（默认写到输出目录的 _batch-report.md）
"""
import argparse
import os
import re
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scraper import fetch_article, extract_article_content, html_to_markdown
from images import extract_images, save_images_and_update_html


def normalize_url(line: str):
    """从一行文本里取出微信文章 URL（兼容 Markdown 链接语法）"""
    line = line.strip()
    if not line or line.startswith('#'):
        return None
    if line.startswith('['):
        md = re.search(r'\]\((https?://[^)\s]+)\)', line)
        if md:
            return md.group(1)
    url = re.search(r'https?://[^\s)\]<>]+', line)
    return url.group(0) if url else None


def read_urls(path: str):
    with open(path, encoding='utf-8') as f:
        raw = f.read().splitlines()
    urls, seen = [], set()
    for line in raw:
        url = normalize_url(line)
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def already_saved(output_dir: str, url: str):
    """输出目录里已有同一篇（按原文链接判断）就跳过"""
    if not os.path.isdir(output_dir):
        return None
    for name in os.listdir(output_dir):
        if not name.endswith('.md'):
            continue
        path = os.path.join(output_dir, name)
        try:
            with open(path, encoding='utf-8') as f:
                head = f.read(2000)
        except OSError:
            continue
        if f'**原文链接**: {url}' in head:
            return path
    return None


def safe_filename(title: str, publish_date: str):
    safe_title = (title or 'wechat-article')[:80].replace('/', '_').replace('\\', '_')
    safe_title = "".join(c for c in safe_title if c.isalnum() or c in ' -_，。！？：；（）《》、+-').strip()
    if not safe_title:
        safe_title = 'wechat-article'
    if publish_date:
        return f"{publish_date.replace('-', '')}-{safe_title}.md"
    return f"{safe_title}.md"


def fetch_once(url: str, output_dir: str):
    """抓一篇并落盘，返回 (状态, 说明, 文件路径)"""
    html = fetch_article(url)
    if not html:
        return 'fail', '抓取失败（网络或被风控拦截）', None

    article = extract_article_content(html, url)
    if not article['content_html']:
        return 'fail', '未找到正文容器（文章可能已删除或需要登录）', None

    images = extract_images(article['raw_html'], url)
    image_mapping = save_images_and_update_html(images, output_dir, url) if images else {}
    markdown_content = html_to_markdown(article['content_html'], url, image_mapping)

    frontmatter = [f"# {article['title']}", ""]
    if article['author']:
        frontmatter.append(f"**作者**: {article['author']}")
    if article['publish_date']:
        frontmatter.append(f"**发布时间**: {article['publish_date']}")
    frontmatter.append(f"**原文链接**: {url}")
    frontmatter.append(f"**抓取时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    frontmatter.extend(["", "---", ""])

    md_path = os.path.join(output_dir, safe_filename(article['title'], article['publish_date']))
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(frontmatter) + markdown_content)

    note = f"{article['title']}｜作者 {article['author'] or '未知'}｜下载 {len(images)} 张图"
    return 'ok', note, md_path


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('urls_file')
    ap.add_argument('output_dir', nargs='?', default=None)
    ap.add_argument('--delay', type=float, default=8)
    ap.add_argument('--retry', type=int, default=2)
    ap.add_argument('--retry-wait', type=float, default=20)
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--report', default=None)
    args = ap.parse_args()

    output_dir = args.output_dir or os.path.join(os.getcwd(), 'wechat-articles')
    os.makedirs(output_dir, exist_ok=True)
    urls = read_urls(args.urls_file)
    if not urls:
        print('❌ 没从输入文件里读到任何 URL')
        sys.exit(1)

    print(f"📋 共 {len(urls)} 篇待处理，输出目录：{output_dir}\n")
    results = []
    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] {url}")

        if not args.force:
            existing = already_saved(output_dir, url)
            if existing:
                print(f"  ⏭️  已存在，跳过：{os.path.basename(existing)}\n")
                results.append(('skip', url, os.path.basename(existing)))
                continue

        status, note, path = 'fail', '', None
        for attempt in range(args.retry + 1):
            try:
                status, note, path = fetch_once(url, output_dir)
            except Exception as e:
                status, note = 'fail', f'异常：{e}'
            if status == 'ok':
                break
            if attempt < args.retry:
                print(f"  ⚠️  {note}，{args.retry_wait:.0f}s 后重试（{attempt + 1}/{args.retry}）")
                time.sleep(args.retry_wait)

        if status == 'ok':
            print(f"  ✅ {note}")
            print(f"     {path}\n")
        else:
            print(f"  ❌ {note}\n")
        results.append((status, url, note))

        if i < len(urls):
            time.sleep(args.delay)

    ok = sum(1 for s, _, _ in results if s == 'ok')
    skipped = sum(1 for s, _, _ in results if s == 'skip')
    failed = [(u, n) for s, u, n in results if s == 'fail']

    print('=' * 50)
    print(f"完成：成功 {ok}｜跳过 {skipped}｜失败 {len(failed)}（共 {len(results)}）")
    for u, n in failed:
        print(f"  ❌ {u}  —— {n}")

    report_path = args.report or os.path.join(output_dir, '_batch-report.md')
    stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with open(report_path, 'a', encoding='utf-8') as f:
        f.write(f"\n## 批量抓取 {stamp}\n\n")
        f.write(f"成功 {ok}｜跳过 {skipped}｜失败 {len(failed)}\n\n")
        for s, u, n in results:
            mark = {'ok': '✅', 'skip': '⏭️', 'fail': '❌'}[s]
            f.write(f"- {mark} {u}\n  - {n}\n")
    print(f"📝 汇总已写入：{report_path}")

    sys.exit(0 if not failed else 2)


if __name__ == '__main__':
    main()
