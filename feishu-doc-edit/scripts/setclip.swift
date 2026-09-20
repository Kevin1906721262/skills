// 把 HTML / 图片写进 macOS 系统剪贴板。
//
// 为什么必须用 Swift 而不是 osascript:
//   `set the clipboard to {«class HTML»:h, string:t}` 在 macOS 上并不会真的写入
//   text/html flavor,结果网页只拿到纯文本,粘贴出来是 <h2>标题</h2> 这样的裸标签。
//   NSPasteboard 写 .html 才是真正可用的路径。
//
// 用法:
//   setclip html <htmlFile> [textFile]   写入 text/html + text/plain(纯文本省略时自动从 HTML 剥离)
//   setclip png  <imgFile>               写入图片(PNG 直接透传;JPG 等经 NSImage 转成 PNG)
//   setclip info                         打印当前剪贴板里的类型与大小
import AppKit

let args = CommandLine.arguments

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func readText(_ path: String) -> String {
    if path == "-" {   // 从 stdin 读,方便传内联 HTML
        let data = FileHandle.standardInput.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
    guard let s = try? String(contentsOfFile: path, encoding: .utf8) else {
        fail("读不到文件(需要 UTF-8 文本): \(path)")
    }
    return s
}

/// 从 HTML 里剥出纯文本,作为 text/plain fallback flavor
func stripTags(_ s: String) -> String {
    var out = ""
    var inTag = false
    var pendingNewline = false
    for ch in s {
        if ch == "<" { inTag = true; pendingNewline = true; continue }
        if ch == ">" {
            inTag = false
            if pendingNewline { out.append("\n"); pendingNewline = false }
            continue
        }
        if !inTag { out.append(ch) }
    }
    return out
        .replacingOccurrences(of: "\n\n\n", with: "\n\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

guard args.count >= 2 else { fail("usage: setclip html <htmlFile> [textFile] | png <file> | info") }

let pb = NSPasteboard.general

switch args[1] {
case "html":
    guard args.count >= 3 else { fail("usage: setclip html <htmlFile> [textFile]") }
    let html = readText(args[2])
    let text = args.count >= 4 ? readText(args[3]) : stripTags(html)
    pb.clearContents()
    pb.setString(text, forType: .string)
    pb.setString(html, forType: .html)
    print("clipboard: html \(html.count) chars, text \(text.count) chars")

case "png":
    guard args.count >= 3 else { fail("usage: setclip png <file>") }
    let path = args[2]
    guard let data = FileManager.default.contents(atPath: path) else { fail("读不到图片: \(path)") }
    pb.clearContents()
    if path.lowercased().hasSuffix(".png") {
        pb.setData(data, forType: .png)          // 原字节透传,不做重编码
    } else {
        guard let img = NSImage(data: data),
              let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            fail("无法把图片转成 PNG: \(path)")
        }
        pb.setData(png, forType: .png)
    }
    print("clipboard: png \(data.count) bytes from \(path)")

case "info":
    for type in pb.types ?? [] {
        let n = pb.data(forType: type)?.count ?? 0
        print("\(type.rawValue)  \(n) bytes")
    }

default:
    fail("未知子命令: \(args[1])")
}
