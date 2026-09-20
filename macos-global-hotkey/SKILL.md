---
name: macos-global-hotkey
description: 在 macOS 上开发全局快捷键监听 / 菜单栏应用（menu bar app、NSStatusItem）时使用。覆盖 CGEventTap 键盘钩子、辅助功能（Accessibility / AXIsProcessTrusted）授权、覆盖其他 App 快捷键、ad-hoc 签名导致授权反复失效、菜单栏应用激活/启动其他 App、Swift 桥接坑等避坑经验。
---

# macOS 全局快捷键开发避坑

开发「全局监听快捷键、且能覆盖其他 App 同键位快捷键」的 macOS 工具（菜单栏应用）时，按下面做。

## 核心机制（正确做法）

全局快捷键只有一种可靠实现：**`CGEventTap` 挂 HID 级钩子 + 吞事件**（Karabiner-Elements / Hammerspoon 同款）。

```swift
let tap = CGEvent.tapCreate(
    tap: CGEventTapLocation(rawValue: 0)!,   // 0 = kCGHIDEventTap，系统最早拿按键的位置
    place: .headInsertEventTap,              // 插到本层级钩子队列最前
    options: .defaultTap,                    // 允许吞事件（.listenOnly 只能旁观）
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: callback, userInfo: ...)
```

命中目标快捷键后在回调里 **`return nil`** 吞掉事件，前台应用就收不到 → 实现「覆盖」。

- macOS 没有「优先级字段」，事件钩子按注册顺序（FIFO）调用。「最高」来自三点叠加：HID 级（最早）+ `headInsertEventTap`（队列最前）+ 吞事件（下游都收不到）。
- 修饰键/键码用物理键码 `kVK_ANSI_*`（`1`=0x12、`A`=0x00 等，与键盘布局无关），从 `event.getIntegerValueField(.keyboardEventKeycode)` 和 `event.flags` 取。
- **无法覆盖的例外**：安全输入框（密码框启用 Secure Input 时系统绕过钩子）、直接读底层 HID 设备的程序（如 Karabiner 自身）。

## 避坑清单

### 1. 辅助功能授权是强制的，且绑定「签名身份」
全局键盘监听必须授权「辅助功能」（`AXIsProcessTrusted()`），这是系统强制、绕不过。但更大的坑在后面：

**ad-hoc 签名每次编译指纹（cdhash）都变**，macOS 的辅助功能授权绑定签名身份，变一次就当「另一个程序」——用户授权后一重新编译，授权就失效（系统设置里开关还显示「开」，实际对新二进制无效）。

**正确做法**：用**固定自签名证书**签名，让授权绑定到 `identifier + 证书`（而非指纹），重新编译不失效：

```bash
# 生成一次固定证书（含 code signing EKU），导入 login keychain
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=MyApp Signing" \
  -addext "extendedKeyUsage=codeSigning" -addext "keyUsage=digitalSignature"
openssl pkcs12 -export -out cert.p12 -inkey key.pem -in cert.pem -passout pass:xxx -name "MyApp Signing"
security import cert.p12 -k ~/Library/Keychains/login.keychain-db -P xxx -T /usr/bin/codesign
codesign --force --deep --sign "MyApp Signing" MyApp.app
```

验证 designated requirement 应形如 `identifier "xxx" and certificate leaf = H"..."`（绑定证书而非 cdhash）：`codesign -d -r- MyApp.app`。换机器/重装系统要重新生成证书并重新授权。

### 2. 菜单栏应用激活/启动别的 App：用 `open -a`，别用 `NSRunningApplication.activate`
菜单栏应用（`LSUIElement` / accessory）**从不成为前台应用**，从它里面调用 `running.activate(options:)` 会被系统前台切换策略拒绝——目标 App 不跳前台，且不报错。

**正确做法**：统一用独立进程的 `open -a`：

```swift
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
p.arguments = ["-a", "Google Chrome"]   // 已运行则激活，未运行则启动
try? p.run()
```

### 3. 判断某 App 的辅助功能权限，用「它自己的日志」，别用独立探针
辅助功能授权是**按二进制**区分的。写个 `/tmp/probe` 独立程序去测 `AXIsProcessTrusted()` 返回 false，**不代表目标 App 没授权**（probe 是另一个二进制）。要判断某 App 的真实权限状态，让它自己记录（比如写文件日志），或看它运行时的实际行为（事件钩子是否创建成功）。

### 4. Swift 桥接（SDK 版本差异）
- `CGEventTapLocation` 可能没有 `.cgHIDEventTap` 成员（取决于 SDK 版本），用 `CGEventTapLocation(rawValue: 0)!`（0 = HID 级，必有效）。
- `kAXTrustedCheckOptionPrompt` 是 `Unmanaged` 常量，要 `.takeUnretainedValue() as String` 再用。

### 5. 授权后事件钩子不会自动重建
应用运行时才授权辅助功能，已失败的 `tapCreate` 不会自动重试。给菜单加一个「重新加载/重建监听」入口，授权后手动触发 `start()` 重建钩子（无需重启应用）。

## 检查清单（开工前扫一眼）

- [ ] 用 `CGEventTap` HID 级 + `headInsertEventTap` + 命中 `return nil`
- [ ] 用固定自签名证书签名（不是 ad-hoc），授权才不随编译失效
- [ ] 激活/启动别的 App 用 `open -a`，不用 `NSRunningApplication.activate`
- [ ] 物理键码 + 显式 `excludedFlags`（区分 `Cmd+1` 与 `Cmd+Shift+1`，避免误吞组合键）
- [ ] 提醒用户：Secure Input（密码框）和 Karabiner 之类无法覆盖
