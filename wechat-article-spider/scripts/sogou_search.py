#!/usr/bin/env python3
"""
用搜狗微信搜索找文章链接（免登录）

微信官方没有公开的历史文章列表接口（实测 /mp/profile_ext?action=getmsg 无登录态
返回 no session），搜狗微信搜索是目前唯一免登录的入口：按关键词搜文章，
结果里的 /link?url=... 页面用 JS 片段拼出真实的 mp.weixin.qq.com 地址。

限制：只支持关键词检索（跨公众号），不支持「某个号的全部历史文章」；
结果是搜狗索引到的部分文章；翻页太快会触发验证码。

用法:
    python sogou_search.py "关键词" [--pages 2] [--urls-only] [--out urls.txt]

选项:
    --pages N    抓取前 N 页（每页约 10 条，默认 1）
    --delay SEC  翻页间隔（默认 4 秒）
    --urls-only  只输出 URL，方便直接喂给 batch.py
    --out FILE   把 URL 追加写入文件
"""
import argparse
import json
import re
import sys
import time
import urllib.parse

import requests
from bs4 import BeautifulSoup

BASE = 'https://weixin.sogou.com'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')


def make_session():
    s = requests.Session()
    s.headers.update({
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': f'{BASE}/',
    })
    return s


def looks_like_captcha(text: str) -> bool:
    return any(k in text for k in ('请输入验证码', 'antispider', '用户您好，您的访问过于频繁'))


def resolve_real_url(sess, href: str):
    """把 /link?url=... 解析成真实的文章地址"""
    full = urllib.parse.urljoin(BASE, href)
    try:
        page = sess.get(full, timeout=15).text
    except requests.RequestException:
        return None
    if looks_like_captcha(page):
        return None

    # 直接跳转的情况
    m = re.search(r'(https?://mp\.weixin\.qq\.com/s[^"\'<>\s]*)', page)
    if m:
        return m.group(1).replace('&amp;', '&')

    # 常见情况：JS 把地址拆成片段逐个拼接
    pieces = re.findall(r"url\s*\+=\s*'([^']*)'", page)
    if not pieces:
        return None
    url = ''.join(pieces).replace('@', '')
    url = url.replace('&amp;', '&').replace('&amp%3B', '&')
    return url if 'mp.weixin.qq.com' in url else None


def search(sess, keyword: str, pages: int, delay: float):
    results = []
    for page in range(1, pages + 1):
        url = f"{BASE}/weixin?type=2&query={urllib.parse.quote(keyword)}&page={page}"
        r = sess.get(url, timeout=15)
        if looks_like_captcha(r.text):
            print('⚠️  搜狗触发了反爬验证，请降低频率或稍后再试', file=sys.stderr)
            break
        soup = BeautifulSoup(r.text, 'lxml')
        items = soup.select('ul.news-list li')
        if not items:
            break
        for li in items:
            a = li.select_one('h3 a')
            if not a:
                continue
            account_el = li.select_one('a.account') or li.select_one('.account')
            time_el = li.select_one('.s-p') or li.select_one('span.s2')
            results.append({
                'title': a.get_text(strip=True),
                'account': account_el.get_text(strip=True) if account_el else '',
                'date': time_el.get('t') if time_el and time_el.get('t') else (
                    time_el.get_text(strip=True) if time_el else ''),
                'link': urllib.parse.urljoin(BASE, a.get('href')),
            })
        if page < pages:
            time.sleep(delay)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('keyword')
    ap.add_argument('--pages', type=int, default=1)
    ap.add_argument('--delay', type=float, default=4)
    ap.add_argument('--urls-only', action='store_true')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    sess = make_session()
    found = search(sess, args.keyword, args.pages, args.delay)
    if not found:
        print('没搜到结果（可能关键词太窄，或已被搜狗限流）')
        sys.exit(1)

    print(f"🔍 「{args.keyword}」共 {len(found)} 条，正在解析真实地址...\n")
    resolved, urls = [], []
    for item in found:
        real = resolve_real_url(sess, item['link'])
        item['url'] = real
        resolved.append(item)
        if real:
            urls.append(real)
        if not args.urls_only:
            flag = '✅' if real else '⚠️ 解析失败'
            print(f"{flag} {item['title'][:46]}")
            print(f"    {item['account']}  {item['date']}")
            if real:
                print(f"    {real[:110]}")
        time.sleep(args.delay)

    if args.urls_only:
        print('\n'.join(urls))
    else:
        print(f"\n解析成功 {len(urls)}/{len(found)}")

    if args.out:
        with open(args.out, 'a', encoding='utf-8') as f:
            f.write('\n'.join(urls) + '\n')
        print(f"📝 已追加写入 {args.out}")

    if not urls:
        sys.exit(1)


if __name__ == '__main__':
    main()
