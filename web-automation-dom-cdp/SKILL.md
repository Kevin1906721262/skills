---
name: web-automation-dom-cdp
description: 用 Playwright / Selenium / CDP 自动化网页(尤其票务、购物、H5 站点)时使用。遇到「按钮点不到/没反应」「提交訂單/立即支付/購買 找不到元素」「按钮其实是 DIV 不是 <button>」「选择器匹配到外层容器或隐藏按钮」「页面自动关闭 TargetClosedError / ERR_CONNECTION_CLOSED」「同一账号只能有一张购物车」等场景必读。含按钮选择器、最小面积元素、CDP 页面容错清单。
---

# 网页自动化 DOM / CDP 踩坑结晶

针对用 Playwright + CDP(命令行启动普通 Chrome → `connect_over_cdp`)驱动网页时的坑,规律通用。

## 1. "按钮"不一定是 `<button>`(最常见的翻车点)

- **现象**:页面上有「提交訂單」「立即支付」「購買」按钮,但 `page.query_selector_all('button:has-text("...")')` 匹配不到;或点到了外层容器导致没触发。
- **真相**:这些"按钮"是 `DIV`(如 `class="button submit active"`),标签根本不是 `<button>`。且常有一个外层容器 `submit-wrapper` 文本里也含按钮文案,点击它不会触发事件。
- **正确做法**:选元素条件三连——
  ```js
  const b = [...document.querySelectorAll('div,button,[role="button"]')].find(e =>
    (e.textContent||'').trim() === '提交訂單' &&          // 文本精确匹配(别用 includes)
    String(e.className||'').includes('submit') &&          // class 命中
    e.getBoundingClientRect().width > 10 && e.getBoundingClientRect().height > 10); // 可见/非隐藏
  ```
- **定位技巧**:先 `page.evaluate` 把含目标文案的所有元素 tag/class/可见尺寸 dump 出来,看清结构再写选择器。

## 2. 选票档/列表项要挑"面积最小"的叶子元素

- **现象**:页面有票档列表(如 `SVIP $1688 VIP $1188 A $788`),按价格文本选择时点到了**整个容器**,档位没被选中,后续按钮不激活。
- **正解**:在含目标价位文本的所有元素里,**按 `width*height` 排序取最小**那个(最内层/叶子),scrollIntoView 后 click。
- 同理适用于任何"点某项"的场景(菜单、tab、列表项)。

## 3. 按钮要点"可见"的那个,别点隐藏/移动端的

- 同一文案常有多个实例:桌面版(可见)、移动端/禁用版(`no-buy-more-btn` 之类,width=0 或 hidden)。
- 用 `is_visible()` 或 `offsetWidth||offsetHeight` 过滤;滚动到可视再点;点了没跳转就重试。

## 4. CDP 连接下页面会"自动关闭"(TargetClosedError / ERR_CONNECTION_CLOSED)

- **现象**:页面加载几秒后被掐断,`page.wait_for_timeout` 抛 `TargetClosedError`,或 `goto` 抛 `net::ERR_CONNECTION_CLOSED`。**反复出现、偶发**。
- **正解**:做页面容错——
  - 每次拿页面先探测存活(访问 `page.url`),死了就 `ctx.new_page()` 换新的;
  - 导航/等待包 try/except,TargetClosedError 时重试;
  - 连接后**清掉初始 tab**(start_chrome 会带一个登录页 tab),用全新空白页跑,减少干扰。
- **响应处理器里 `resp.text()` 会因页面关闭抛 `asyncio.CancelledError`**,Python 3.8+ 它是 `BaseException` 子类,`except Exception` 抓不住,会把整个脚本崩掉(连带 `Future exception was never retrieved` 噪音)。拦截响应做副产物读取(如抓请求体/响应体)时,要么整体 `except BaseException`,要么单独把 `resp.text()` 包一层防御。
- 例:
  ```python
  def alive_page(browser):
      ctx = browser.contexts[0]
      for pg in ctx.pages:
          try:
              pg.url; return pg
          except Exception:
              continue
      return ctx.new_page()
  ```

## 5. 单账号单"待支付"购物车/订单

- 票务/抢购类站点:同一账号同时只允许一张待支付购物车(约 5 分钟过期)。已有时重复下单返回业务错误(如 `40010004 請求出錯`)。
- **下单前先查** `pendingPay` 类接口,有旧购物车先调 `shoppingCart/cancel` 取消,再下新单。
- 测试节奏克制,别连续快速下单——会触发风控冷却(报"人多"/"网络不稳定")。

## 6. 其他零散

- 广告/弹窗浮层异步延迟加载,会挡住按钮:轮询点掉 `.advert-modal-close` 一类关闭元素。
- 填 Vue/React 输入框要用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` 赋值 + 派发 `input` 事件,否则框架感知不到。
- 页面内联动状态(如票档选中后按钮才激活):点击后小等 1~2 秒再点下一步。
