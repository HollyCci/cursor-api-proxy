import Foundation

struct Config {
    let host: String
    let port: Int
    let cliPath: String
    let pollIntervalSeconds: TimeInterval

    var statusURL: URL { URL(string: "http://\(host):\(port)/api/status")! }
    var dashboardURL: URL { URL(string: "http://\(host):\(port)/")! }

    static func load() -> Config {
        let env = ProcessInfo.processInfo.environment
        let host = env["CURSOR_BRIDGE_HOST"] ?? "127.0.0.1"
        let port = Int(env["CURSOR_BRIDGE_PORT"] ?? "") ?? 8765
        let defaultCli = "\(NSHomeDirectory())/.local/bin/cursor-api-proxy"
        let cli = env["CURSOR_PROXY_WIDGET_CLI"] ?? defaultCli
        let interval = TimeInterval(env["CURSOR_PROXY_WIDGET_INTERVAL"] ?? "") ?? 15
        return Config(
            host: host,
            port: port,
            cliPath: cli,
            pollIntervalSeconds: max(3, interval)
        )
    }
}
