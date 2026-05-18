// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CursorProxyWidget",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CursorProxyWidget",
            path: "Sources/CursorProxyWidget"
        )
    ]
)
