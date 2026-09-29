// Native, PID-bound AX evidence for VC-344. Never queries another app or
// toggles VoiceOver. System Events may re-resolve Electron windows by name,
// which is ambiguous when the owner has another Electron process open.
import ApplicationServices
import Foundation

let pid = pid_t(CommandLine.arguments[1])!
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 5)
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}
var rows: [[String: Any]] = []
var visited: [AXUIElement] = []
func walk(_ element: AXUIElement, _ depth: Int) {
    guard depth < 60, rows.count < 20000 else { return }
    guard !visited.contains(where: { CFEqual($0, element) }) else { return }
    visited.append(element)
    var row: [String: Any] = ["depth": depth]
    for name in ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXHelp"] {
        if let value = attribute(element, name) as? String, !value.isEmpty {
            row[name] = value
        }
    }
    rows.append(row)
    if let children = attribute(element, "AXChildren") as? [AXUIElement] {
        for child in children { walk(child, depth + 1) }
    }
}
walk(app, 0)
let report: [String: Any] = ["pid": pid, "trusted": AXIsProcessTrusted(), "nodes": rows]
let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
