// Recording guard. It never activates a window or requests OS permission.
// A live Start control establishes idle. Resume Session is accepted only for the
// reviewed app build: its renderer omits that button whenever sharedState.session
// is non-null, even when the dashboard displays a different/older meeting.
import AppKit
import ApplicationServices
import Foundation
import CryptoKit

func result(_ state: String, _ reason: String, _ pid: pid_t? = nil) -> Never {
    var row: [String: Any] = ["state": state, "reason": reason, "observed_at": ISO8601DateFormatter().string(from: Date())]
    if let pid = pid { row["pid"] = pid }
    let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(state == "idle" || state == "not_running" ? 0 : state == "active" ? 2 : 3)
}
let quitWhenIdle = CommandLine.arguments.contains("--quit-if-idle")
let bundlePath = "/Applications/Cluely (New).app/Contents/Resources/app.asar"
// 2.0.200 reviewed Nov 16: dashboard Start disabled for session/non-null or creating;
// Resume omitted whenever the shared session is non-null. Unknown builds still fail closed.
let reviewedHashes: Set<String> = ["8ae5d5fde024090daaf5075510c7e837897025bc4cdb6e0088b08c96462d93df", "4870af190fce75bb899d8fcfdb22611625d8b85587d80248843e5b58498a9c52"]
let installedHash = (try? Data(contentsOf: URL(fileURLWithPath: bundlePath))).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }
guard let installedHash = installedHash, reviewedHashes.contains(installedHash) else { result("unknown", "app_version_needs_review") }
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.cluely.app.april22")
guard apps.count == 1, let app = apps.first else {
    result(apps.isEmpty ? "not_running" : "unknown", apps.isEmpty ? "app_not_running" : "multiple_instances")
}
guard AXIsProcessTrusted() else { result("unknown", "accessibility_unavailable", app.processIdentifier) }
let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root, 1)
// Electron may not expose its tree until an assistive client requests it.
// This is its documented in-app accessibility handshake, not a permission grant
// or a window/recording action. Do not depend on another inspector warming it.
AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
func attribute(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success ? value : nil
}
func string(_ node: AXUIElement, _ key: String) -> String { return attribute(node, key) as? String ?? "" }
var liveWindows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
for _ in 0..<5 where liveWindows.isEmpty {
    Thread.sleep(forTimeInterval: 0.2)
    liveWindows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
}
guard !liveWindows.isEmpty else {
    result("unknown", "no_live_windows", app.processIdentifier)
}
var stack = liveWindows, visited = Set<CFHashCode>(), count = 0, idle = false, active = false, incomplete = false
// The dashboard Start Cluely control is disabled whenever sharedState.session
// exists. Require its dashboard markers and exactly one such button: a separate
// empty-history view has the same caption without the same global-state guard.
var dashboardStartCount = 0, dashboardStartEnabled = false, dashboardStartDisabled = false
var dashboardRefresh = false, dashboardVisibility = false
let deadline = Date().addingTimeInterval(8)
while let node = stack.popLast() {
    if count > 15000 || Date() > deadline { incomplete = true; break }
    let key = CFHash(node)
    if visited.contains(key) { continue }
    visited.insert(key); count += 1
    let role = string(node, kAXRoleAttribute)
    if role == kAXButtonRole {
        let labels = [string(node, kAXTitleAttribute), string(node, kAXDescriptionAttribute), string(node, kAXHelpAttribute)]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        if labels.contains("start cluely") {
            dashboardStartCount += 1
            dashboardStartEnabled = attribute(node, kAXEnabledAttribute) as? Bool == true
            if !dashboardStartEnabled { dashboardStartDisabled = true }
        }
        if labels.contains("refresh meetings") { dashboardRefresh = true }
        if labels.contains("detectable") || labels.contains("undetectable") { dashboardVisibility = true }
        if labels.contains(where: { ["stop session", "end session", "stop recording", "pause recording"].contains($0) }) { active = true }
        if labels.contains(where: { ["start session", "start recording", "resume session"].contains($0) }) && (attribute(node, kAXEnabledAttribute) as? Bool == true) { idle = true }
    }
    var raw: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &raw)
    if status == .success { stack.append(contentsOf: raw as? [AXUIElement] ?? []) }
    else if status != .noValue && status != .attributeUnsupported { incomplete = true }
}
if active { result("active", "live_stop_control", app.processIdentifier) }
if incomplete { result("unknown", "incomplete_live_state", app.processIdentifier) }
if dashboardRefresh && dashboardVisibility && dashboardStartDisabled { result("unknown", "session_busy_or_starting", app.processIdentifier) }
if dashboardRefresh && dashboardVisibility && dashboardStartCount == 1 && dashboardStartEnabled { idle = true }
if idle {
    if quitWhenIdle {
        // This process reads all controls immediately before graceful termination.
        // The controller obtained an independent idle observation beforehand.
        guard app.terminate() else { result("unknown", "graceful_quit_refused", app.processIdentifier) }
        result("idle", "idle_confirmed_graceful_quit_sent", app.processIdentifier)
    }
    result("idle", "live_idle_control_reviewed_build", app.processIdentifier)
}
result("unknown", "no_global_recording_control", app.processIdentifier)
