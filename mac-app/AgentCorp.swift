import SwiftUI
import AppKit

@MainActor final class Model: ObservableObject {
    @Published var credential = ""
    @Published var cap = "100000"
    @Published var providers = "claude"
    @Published var capUsd = "2.00"
    private var workerOutput = ""
    @Published var server = "http://127.0.0.1:8787"
    @Published var status = "Ready to connect"
    @Published var result = "Run a test to check your connection."
    @Published var workerRunning = false
    @Published var serverRunning = false
    @Published var error = ""
    private var worker: Process?
    private var serverProcess: Process?
    let project: String
    init() {
        project = ProcessInfo.processInfo.environment["AGENT_CORP_PROJECT"] ?? "/Users/kastet/Agent Corp"
        let demo = project + "/.keys/workers/alice.json"
        if FileManager.default.fileExists(atPath: demo) { credential = demo }
        Task { await refreshServer() }
    }
    func chooseCredential() {
        let panel = NSOpenPanel(); panel.title = "Choose NEAR testnet credential"; panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowedContentTypes = [.json]
        if panel.runModal() == .OK { credential = panel.url?.path ?? credential }
    }
    func launch(_ command: String, args: [String], env: [String: String] = [:], output: ((String) -> Void)? = nil, terminated: @escaping (Int32) -> Void) throws -> Process {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = [command] + args; p.currentDirectoryURL = URL(fileURLWithPath: project)
        var e = ProcessInfo.processInfo.environment
        e["PATH"] = [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", e["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
        // Finder apps do not inherit shell's nvm PATH.
        let nvm = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm), let latest = versions.sorted().last { e["PATH"] = nvm + "/" + latest + "/bin:" + e["PATH"]! }
        env.forEach { e[$0.key] = $0.value }; p.environment = e
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { h in
            let data = h.availableData
            if let text = String(data: data, encoding: .utf8), !text.isEmpty { DispatchQueue.main.async { output?(text) } }
        }
        p.terminationHandler = { proc in pipe.fileHandleForReading.readabilityHandler = nil; DispatchQueue.main.async { terminated(proc.terminationStatus) } }
        try p.run(); return p
    }
    func refreshServer() async {
        guard let url = URL(string: server + "/api/tasks") else { return }
        serverRunning = (try? await URLSession.shared.data(from: url).1 as? HTTPURLResponse)?.statusCode == 200
    }
    func startServer() {
        error = ""
        do { serverProcess = try launch("pnpm", args: ["start"], env: ["AGENTS":"off", "GROWTH":"off", "DEMO_ACTIONS":"on"]) { [weak self] code in self?.serverProcess = nil; self?.serverRunning = false; if code != 0 { self?.error = "Server stopped (exit \(code)). Check that port 8787 is free and project dependencies are installed." } }
            Task { try? await Task.sleep(for: .seconds(2)); await refreshServer(); if !serverRunning { error = "Server did not start. Check the project and port 8787." } }
        } catch { self.error = "Could not start server: \(error.localizedDescription)" }
    }
    func toggleWorker() {
        if workerRunning { worker?.terminate(); status = "Stopping…"; return }
        guard FileManager.default.fileExists(atPath: credential) else { error = "Choose a credential file."; return }
        guard let amount = Int(cap), amount >= 0 else { error = "Enter a valid daily cap."; return }
        guard let dollars = Double(capUsd), dollars.isFinite, dollars >= 0 else { error = "Invalid limit."; return }
        guard !providers.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Choose at least one provider ID."; return }
        guard let u = URL(string: server), let host = u.host, ["http", "https"].contains(u.scheme ?? "") else { error = "Enter a valid server address."; return }
        let scheme = u.scheme == "https" ? "wss" : "ws"; let endpoint = "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")/api/worker"
        error = ""; workerOutput = ""; status = "Starting worker…"
        do { worker = try launch("pnpm", args: ["exec", "agent-corp-worker", "--credential", credential, "--cap-tokens", cap, "--cap-usd", capUsd, "--providers", providers, "--server", endpoint], output: { [weak self] text in self?.workerOutput += text }) { [weak self] code in
            guard let self else { return }
            self.workerRunning = false; self.worker = nil; self.status = code == 0 ? "Worker stopped" : "Worker stopped (exit \(code))"
            if code != 0 { self.error = self.workerOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Worker could not start. Check credential, provider sign-in, server, and worker lock." : self.workerOutput.trimmingCharacters(in: .whitespacesAndNewlines) }
        }; workerRunning = true; status = "Worker running · test connection to verify" }
        catch { status = "Worker stopped"; self.error = "Could not start worker: \(error.localizedDescription)" }
    }
    func test() {
        guard workerRunning else { error = "Start worker first."; return }
        guard let url = URL(string: server + "/api/demo/test-worker") else { return }
        error = ""; result = "Sending test task…"
        Task {
            do {
                var req = URLRequest(url: url); req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: req)
                guard (response as? HTTPURLResponse)?.statusCode == 200, let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let id = obj["id"] as? String else { throw NSError(domain: "Test endpoint unavailable. Start the local server with demo actions enabled.", code: 1) }
                for _ in 0..<45 {
                    try await Task.sleep(for: .seconds(1))
                    let (data, _) = try await URLSession.shared.data(from: URL(string: server + "/api/tasks")!)
                    if let tasks = try JSONSerialization.jsonObject(with: data) as? [[String: Any]], let task = tasks.first(where: { $0["id"] as? String == id }) {
                        let state = task["status"] as? String ?? "queued"
                        if state == "done" { result = "Test passed. Your tokens are now available to Foundry Stack."; status = "Connected · test passed"; return }
                        if state == "failed" { result = task["output"] as? String ?? "Test failed."; status = "Test failed"; return }
                        result = state == "running" ? "Claude is working on the test…" : "Waiting for worker…"
                    }
                }
                result = "Still waiting. Check worker, server, and remaining daily cap."
            } catch { self.error = "Test failed: \(error.localizedDescription)"; result = "Test could not be completed." }
        }
    }
    deinit { worker?.terminate(); serverProcess?.terminate() }
}

enum Theme {
    static let bg = Color(red: 0x12/255, green: 0x13/255, blue: 0x16/255)
    static let panel = Color(red: 0x18/255, green: 0x18/255, blue: 0x18/255)
    static let field = Color(red: 0x20/255, green: 0x20/255, blue: 0x20/255)
    static let line = Color(red: 0x2b/255, green: 0x2b/255, blue: 0x2b/255)
    static let text = Color(red: 0xfb/255, green: 0xf5/255, blue: 0xf1/255)
    static let muted = Color(red: 0x9a/255, green: 0x9a/255, blue: 0x9a/255)
    static let action = Color(red: 0xfe/255, green: 0x3e/255, blue: 0x01/255)
    static let ok = Color(red: 0x46/255, green: 0xc0/255, blue: 0x8a/255)
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

struct Cap: View { let t: String; init(_ t: String) { self.t = t }
    var body: some View { Text(t.uppercased()).font(Theme.mono(11)).tracking(1.4).foregroundStyle(Theme.muted) } }

struct Field: ViewModifier {
    func body(content: Content) -> some View {
        content.textFieldStyle(.plain).font(Theme.mono(13)).padding(.horizontal, 12).frame(height: 38)
            .background(Theme.field, in: RoundedRectangle(cornerRadius: 4)).overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.line))
    }
}
struct Solid: ButtonStyle {
    var primary = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Theme.mono(13, .semibold)).padding(.horizontal, 16).frame(height: 38)
            .foregroundStyle(primary ? Color.white : Theme.text)
            .background(primary ? Theme.action : Color.clear, in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(primary ? Theme.action : Theme.muted))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
struct Pick: View {
    let label: String; @Binding var value: String; let options: [(String, String)]; var disabled = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Cap(label)
            Picker("", selection: $value) { ForEach(options, id: \.0) { Text($0.1).tag($0.0) } }
                .labelsHidden().pickerStyle(.menu).disabled(disabled).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct MainView: View {
    @StateObject private var model = Model()
    static let providerOptions = [("claude", "Claude Code"), ("codex", "Codex"), ("opencode", "opencode"), ("cursor", "Cursor"), ("pi", "Pi")]
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Text("AGENT ").font(.system(size: 20, weight: .black)).foregroundStyle(Theme.text) + Text("CORP").font(.system(size: 20, weight: .black)).foregroundStyle(Theme.action)
                Spacer()
                Text("MAC WORKER").font(Theme.mono(11)).tracking(1.2).foregroundStyle(Theme.action).padding(.horizontal, 8).padding(.vertical, 2).overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.action))
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Connect your Mac").font(.system(size: 34, weight: .heavy)).foregroundStyle(Theme.text)
                HStack(spacing: 8) { Circle().fill(model.workerRunning ? Theme.ok : Theme.muted).frame(width: 8, height: 8); Text(model.status).font(Theme.mono(13)).foregroundStyle(Theme.muted) }
            }
            VStack(alignment: .leading, spacing: 16) {
                HStack { Cap("Server"); Spacer(); Text(model.serverRunning ? "● online" : "○ offline").font(Theme.mono(12)).foregroundStyle(model.serverRunning ? Theme.ok : Theme.muted)
                    Button("Check") { Task { await model.refreshServer() } }.buttonStyle(.plain).font(Theme.mono(12)).foregroundStyle(Theme.muted) }
                HStack { TextField("Server address", text: $model.server).modifier(Field()); if !model.serverRunning { Button("Start local") { model.startServer() }.buttonStyle(Solid()) } }
                Cap("Credential")
                HStack { TextField("Testnet credential file", text: $model.credential).modifier(Field()); Button("Choose…") { model.chooseCredential() }.buttonStyle(Solid()) }
                HStack(alignment: .bottom, spacing: 16) {
                    Pick(label: "Provider", value: $model.providers, options: Self.providerOptions, disabled: model.workerRunning)
                    VStack(alignment: .leading, spacing: 6) {
                        Cap("Daily token limit")
                        TextField("100000", text: $model.cap)
                            .modifier(Field())
                            .disabled(model.workerRunning)
                    }
                    Button(model.workerRunning ? "Stop" : "Start worker") { model.toggleWorker() }.buttonStyle(Solid(primary: !model.workerRunning))
                }
            }.padding(22).background(Theme.panel, in: RoundedRectangle(cornerRadius: 4)).overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.line))
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) { Cap("Test"); Text(model.result).font(Theme.mono(13)).foregroundStyle(Theme.text).textSelection(.enabled) }
                Spacer(); Button("Run test") { model.test() }.buttonStyle(Solid()).disabled(!model.workerRunning).opacity(model.workerRunning ? 1 : 0.4)
            }
            if !model.error.isEmpty { Text(model.error).font(Theme.mono(12)).foregroundStyle(Theme.action).textSelection(.enabled) }
        }.padding(30)
        }
        .background(Theme.bg).preferredColorScheme(.dark).frame(minWidth: 620, minHeight: 520)
    }
}
@main struct AgentCorpApp: App { var body: some Scene { WindowGroup { MainView() }.windowResizability(.contentMinSize) } }
