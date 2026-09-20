"""微信文章抓取和解析模块"""
import re
import json
from typing import Optional, Dict
from bs4 import BeautifulSoup
import requests
from urllib.parse import unquote


def fetch_article(url: str) -> Optional[str]:
    """抓取文章 HTML 内容"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        response.encoding = response.apparent_encoding
        return response.text
    except Exception as e:
        print(f"❌ 抓取失败：{e}")
        return None


def extract_article_content(html: str, url: str) -> Dict:
    """提取文章标题、正文等核心内容"""
    soup = BeautifulSoup(html, 'lxml')
    
    title = ""
    title_tag = soup.find('h1', class_='rich_media_title') or soup.find('h2', class_='rich_media_title')
    if title_tag:
        title = title_tag.get_text(strip=True)
    else:
        meta_title = soup.find('meta', property='og:title')
        if meta_title:
            title = meta_title.get('content', '')
    
    if not title:
        title = f"微信文章 - {url}"
    
    content_html = ""
    content_div = soup.find('div', id='js_content') or soup.find('div', class_='rich_media_content')
    
    if content_div:
        content_html = str(content_div)
    else:
        for div in soup.find_all('div', class_='rich_media_area_primary'):
            content_div = div.find('section')
            if content_div:
                content_html = str(content_div)
                break
    
    author = ""
    author_tag = soup.find('span', class_='rich_media_meta_nickname')
    if author_tag:
        author = author_tag.get_text(strip=True)
    
    publish_date = ""
    date_tag = soup.find('em', class_='rich_media_meta_text')
    if date_tag:
        date_text = date_tag.get_text(strip=True)
        if date_text:
            publish_date = date_text
    
    # Fallback: extract publish time from script (URL-encoded)
    # 微信文章时间字段可能是 publish_time / createTime / update_time / oriCreateTime
    # 形态可能是 JSON 数字时间戳、JSON 字符串日期、或 JS 变量赋值
    if not publish_date:
        time_keys = ('publish_time', 'createTime', 'update_time', 'oriCreateTime')
        date_str_patterns = [
            # JS 变量字符串日期: var createTime = '2025-07-10 08:48';
            r"{key}\s*=\s*'(\d{{4}}-\d{{2}}-\d{{2}})[^']*'",
            r"{key}\s*=\s*\"(\d{{4}}-\d{{2}}-\d{{2}})[^\"]*\"",
            # JSON 字符串日期: "createTime": "2025-07-10 08:48"
            r'"{key}"\s*:\s*"(\d{{4}}-\d{{2}}-\d{{2}})[^"]*"',
            # JSON 数字时间戳: "createTime": 1752108480
            r'"{key}"\s*:\s*"?(\d{{10}})"?',
            # JS 变量数字时间戳: var createTime = 1752108480
            r"{key}\s*=\s*(\d{{10}})\b",
        ]
        for script in soup.find_all('script'):
            if not script.string:
                continue
            if not any(k in script.string for k in time_keys):
                continue
            decoded = unquote(script.string)
            for key in time_keys:
                for pat_tpl in date_str_patterns:
                    pat = pat_tpl.format(key=key)
                    match = re.search(pat, decoded) or re.search(pat, script.string)
                    if not match:
                        continue
                    val = match.group(1)
                    if len(val) == 10 and val.isdigit():
                        # 时间戳
                        from datetime import datetime
                        publish_date = datetime.fromtimestamp(int(val)).strftime('%Y-%m-%d')
                    else:
                        # YYYY-MM-DD 字符串
                        publish_date = val
                    break
                if publish_date:
                    break
            if publish_date:
                break
    
    return {
        'title': title,
        'author': author,
        'publish_date': publish_date,
        'content_html': content_html,
        'raw_html': html
    }


def html_to_markdown(content_html: str, url: str, image_mapping: dict) -> str:
    """将 HTML 内容转换为 Markdown，替换图片链接"""
    if not content_html:
        return ""
    
    soup = BeautifulSoup(content_html, 'lxml')
    markdown_parts = []
    
    def process_element(element):
        if isinstance(element, str):
            text = element.strip()
            if text:
                return text
            return None
        
        if element.name == 'img':
            src = element.get('src') or element.get('data-src')
            if src:
                from urllib.parse import urljoin
                full_url = urljoin(url, src)
                if full_url in image_mapping:
                    alt = element.get('alt', '')
                    return f"![{alt}]({image_mapping[full_url]})"
            return None
        
        if element.name == 'p':
            parts = []
            for child in element.children:
                result = process_element(child)
                if result:
                    parts.append(result)
            if parts:
                return ' '.join(parts)
            return None
        
        if element.name == 'section':
            parts = []
            for child in element.children:
                result = process_element(child)
                if result:
                    parts.append(result)
            if parts:
                return '\n\n'.join(parts)
            return None
        
        if element.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
            level = int(element.name[1])
            text = element.get_text(strip=True)
            # Extract images nested inside heading (common in WeChat articles
            # where <h2> wraps <span><img></span>)
            img_parts = []
            for img_tag in element.find_all('img'):
                src = img_tag.get('src') or img_tag.get('data-src')
                if src:
                    from urllib.parse import urljoin
                    full_url = urljoin(url, src)
                    if full_url in image_mapping:
                        alt = img_tag.get('alt', '')
                        img_parts.append(f"![{alt}]({image_mapping[full_url]})")

            result_parts = []
            if text:
                result_parts.append(f"\n{'#' * level} {text}\n")
            if img_parts:
                result_parts.append("\n" + "\n\n".join(img_parts) + "\n")
            if result_parts:
                return '\n'.join(result_parts)
            return None
        
        if element.name in ['ul', 'ol']:
            return process_list(element)
        
        if element.name == 'blockquote':
            parts = []
            for child in element.children:
                result = process_element(child)
                if result:
                    for line in result.split('\n'):
                        if line.strip():
                            parts.append(f"> {line.strip()}")
                        else:
                            parts.append(">")
            if parts:
                return '\n'.join(parts)
            return None
        
        if element.name == 'br':
            return "\n"
        
        if element.name == 'table':
            return process_table(element)
        
        # 代码块：<pre> 标签 — 提取纯文本，用 ``` 包裹
        if element.name == 'pre':
            code_text = element.get_text()
            if code_text.strip():
                # 尝试检测语言（微信公号代码块通常无 language class）
                return f"```\n{code_text.strip()}\n```"
            return None
        
        # 行内代码：<code> 标签（不在 <pre> 内的）
        if element.name == 'code':
            code_text = element.get_text()
            if code_text.strip():
                return f"`{code_text.strip()}`"
            return None
        
        if element.name in ['strong', 'b']:
            text = element.get_text(strip=True)
            if text:
                return f"**{text}**"
            return None
        
        if element.name in ['em', 'i']:
            text = element.get_text(strip=True)
            if text:
                return f"*{text}*"
            return None
        
        if element.name == 'span':
            # Check for LaTeX formula in data-formula attribute
            data_formula = element.get('data-formula')
            if data_formula:
                # Check if it's a display formula (typically longer or standalone)
                # Shorter formulas are inline
                formula = data_formula.strip()
                if '\n' in formula or len(formula) > 40:
                    return f"$$\n{formula}\n$$"
                else:
                    return f"${formula}$"
            
            parts = []
            for child in element.children:
                result = process_element(child)
                if result:
                    parts.append(result)
            if parts:
                return ' '.join(parts)
            return None
        
        # 默认：处理所有子元素
        parts = []
        for child in element.children:
            result = process_element(child)
            if result:
                parts.append(result)
        
        if parts:
            return '\n\n'.join(parts)
        return None
    
    # 处理所有顶级元素
    for element in soup.children:
        result = process_element(element)
        if result:
            markdown_parts.append(result)
    
    # 合并结果
    result = '\n\n'.join(markdown_parts)
    
    # 清理多余空白
    result = re.sub(r'\n{3,}', '\n\n', result)
    result = result.strip()
    
    return result


def process_list(list_tag) -> str:
    """处理列表元素"""
    items = []
    is_ordered = list_tag.name == 'ol'
    
    for idx, li in enumerate(list_tag.find_all('li', recursive=False), 1):
        text = li.get_text(strip=True)
        if is_ordered:
            items.append(f"{idx}. {text}")
        else:
            items.append(f"- {text}")
    
    return '\n'.join(items) if items else ""


def process_table(table_tag) -> str:
    """将 HTML 表格转换为 Markdown 表格"""
    rows = table_tag.find_all('tr')
    if not rows:
        return ""
    
    table_lines = []
    
    # 处理表头（第一行）
    first_row = rows[0]
    headers = []
    for cell in first_row.find_all(['th', 'td']):
        headers.append(cell.get_text(strip=True))
    
    if headers:
        table_lines.append('| ' + ' | '.join(headers) + ' |')
        table_lines.append('| ' + ' | '.join(['---'] * len(headers)) + ' |')
    
    # 处理数据行
    start_idx = 1 if headers else 0
    for row in rows[start_idx:]:
        cells = []
        for cell in row.find_all(['td', 'th']):
            cells.append(cell.get_text(strip=True))
        if cells:
            # 确保列数一致
            while len(cells) < len(headers):
                cells.append('')
            table_lines.append('| ' + ' | '.join(cells[:len(headers)]) + ' |')
    
    return '\n'.join(table_lines) if len(table_lines) > 2 else ""
