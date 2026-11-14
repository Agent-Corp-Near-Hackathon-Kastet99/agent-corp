import SwiftUI
import AppKit

@MainActor final class Model: ObservableObject {
    @Published var credential = ""
    @Published var cap = "100000"
    @Published var providers = "claude"
    @Published var capUsd = "2.00"
    @Published var allowUnverified = false
    @Published var providerStatus = "Check providers for installed CLIs and sign-in instructions."
    private var discovery: Process?
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
    func checkProviders() {
        guard discovery == nil else { return }
        providerStatus = ""
        do { discovery = try launch("pnpm", args: ["exec", "agent-corp-worker", "providers"], output: { [weak self] text in self?.providerStatus += text }) { [weak self] code in
            self?.discovery = nil
            if code != 0 { self?.providerStatus += "Provider discovery failed (exit \(code))." }
        } } catch { providerStatus = error.localizedDescription }
    }
    func toggleWorker() {
        if workerRunning { worker?.terminate(); status = "Stopping…"; return }
        guard FileManager.default.fileExists(atPath: credential) else { error = "Choose a valid testnet credential file."; return }
        guard let amount = Int(cap), amount >= 0 else { error = "Enter a valid daily cap."; return }
        guard let dollars = Double(capUsd), dollars.isFinite, dollars >= 0 else { error = "Enter a valid daily USD cap."; return }
        guard !providers.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Choose at least one provider ID."; return }
        guard let u = URL(string: server), let host = u.host, ["http", "https"].contains(u.scheme ?? "") else { error = "Enter a valid server address."; return }
        let scheme = u.scheme == "https" ? "wss" : "ws"; let endpoint = "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")/api/worker"
        error = ""; status = "Starting worker…"
        do { worker = try launch("pnpm", args: ["exec", "agent-corp-worker", "--credential", credential, "--cap-tokens", cap, "--cap-usd", capUsd, "--providers", providers, "--server", endpoint] + (allowUnverified ? ["--allow-unverified"] : [])) { [weak self] code in self?.workerRunning = false; self?.worker = nil; self?.status = code == 0 ? "Worker stopped" : "Worker stopped (exit \(code))"; if code != 0 { self?.error = "Worker could not start or disconnected. Check the server, credential, provider sign-in, and any existing worker lock." } }; workerRunning = true; status = "Worker running · test connection to verify" }
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
                        if state == "done" { result = task["output"] as? String ?? "Test completed."; status = "Connected · test passed"; return }
                        if state == "failed" { result = task["output"] as? String ?? "Test failed."; status = "Test failed"; return }
                        result = state == "running" ? "Claude is working on the test…" : "Waiting for worker…"
                    }
                }
                result = "Still waiting. Check worker, server, and remaining daily cap."
            } catch { self.error = "Test failed: \(error.localizedDescription)"; result = "Test could not be completed." }
        }
    }
    deinit { worker?.terminate(); serverProcess?.terminate(); discovery?.terminate() }
}

struct Content: View {
    @StateObject private var model = Model()
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) { VStack(alignment: .leading, spacing: 7) { Text("AGENT CORP / LOCAL").font(.system(size: 11, weight: .bold, design: .monospaced)).tracking(1.5).foregroundStyle(.secondary); Text("Your AI connections").font(.system(size: 29, weight: .bold)); Text("Connect your Mac and check that tasks get through.").foregroundStyle(.secondary) }; Spacer(); Image(systemName: "sparkle.square.filled.on.square").font(.system(size: 28)).foregroundStyle(.indigo) }.padding(.bottom, 26)
            HStack(spacing: 9) { Circle().fill(model.workerRunning ? .green : .gray).frame(width: 9, height: 9); Text(model.status).fontWeight(.medium); Spacer(); Text("MAC WORKER").font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(.secondary) }.padding(15).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 15) {
                HStack { Text("Connection").font(.headline); Spacer(); Button("Check server") { Task { await model.refreshServer() } }.buttonStyle(.borderless); Text(model.serverRunning ? "Server available" : "Server unavailable").font(.caption).foregroundStyle(model.serverRunning ? .green : .secondary) }
                HStack { TextField("Server address", text: $model.server).textFieldStyle(.roundedBorder); if !model.serverRunning { Button("Start local server") { model.startServer() } } }
                HStack { TextField("Testnet credential file", text: $model.credential).textFieldStyle(.roundedBorder); Button("Choose…") { model.chooseCredential() } }
                HStack { TextField("Provider IDs, comma separated", text: $model.providers).textFieldStyle(.roundedBorder).disabled(model.workerRunning); Button("Check providers") { model.checkProviders() } }
                ScrollView([.horizontal, .vertical]) { Text(model.providerStatus).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 80)
                Toggle("Enable experimental adapters", isOn: $model.allowUnverified).disabled(model.workerRunning)
                HStack { Text("Daily USD cap"); TextField("2.00", text: $model.capUsd).textFieldStyle(.roundedBorder).frame(width: 85); Spacer() }
                HStack { Text("Daily token limit"); TextField("100000", text: $model.cap).textFieldStyle(.roundedBorder).frame(width: 85); Spacer(); Button(model.workerRunning ? "Stop worker" : "Start worker") { model.toggleWorker() }.buttonStyle(.borderedProminent).tint(.indigo) }
            }.padding(.vertical, 24)
            Divider()
            HStack(alignment: .top, spacing: 16) { VStack(alignment: .leading, spacing: 6) { Text("Connection test").font(.headline); Text(model.result).foregroundStyle(.secondary).textSelection(.enabled) }; Spacer(); Button("Run test") { model.test() }.disabled(!model.workerRunning) }.padding(.vertical, 22)
            if !model.error.isEmpty { Text(model.error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            Spacer(minLength: 12)
            Text("Limit counts input, output and cached tokens. Usage can exceed the limit before provider reports it.").font(.caption).foregroundStyle(.secondary)
        }.padding(30).frame(minWidth: 600, minHeight: 460)
    }
}
@main struct AgentCorpApp: App { var body: some Scene { WindowGroup { Content() }.windowResizability(.contentMinSize) } }
