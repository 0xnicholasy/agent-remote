import Foundation

#if canImport(Darwin)
import Darwin
#endif

/// One bridge found by a LAN sweep, answering `GET /v1/health` with `ok: true`.
struct FoundBridge: Sendable, Equatable, Identifiable {
    var id: String { "\(host):\(port)" }
    var host: String
    var port: Int
    var bridgeId: String
    /// Display name, when the bridge's health body carries one; falls back to the host:port.
    var name: String
}

/// docs/networking.md: Bonjour browsing is blocked for ordinary apps on a real Watch (TN3135),
/// so discovery instead sweeps the Watch's own /24 on the well-known bridge port plus whatever
/// port it last connected to. Kept free of any view/state-store type so `select(_:)` is testable
/// as a pure function.
enum HealthSweepFinder {
    /// The bridge's documented default port (BridgeClient.defaultBaseURL).
    static let defaultPort = 8787

    private struct HealthBody: Decodable {
        var ok: Bool
        var bridgeId: String
        var name: String?
    }

    /// Per-probe timeout during the /24 sweep. Short, since a home /24 has 254 addresses and
    /// almost none of them run a bridge -- most probes are a connection refusal or a silent
    /// timeout, and the sweep's worst case is dominated by however long each one is allowed to
    /// hang.
    private static let sweepProbeTimeout: TimeInterval = 1.0
    /// Requests in flight at once during the /24 sweep.
    private static let sweepConcurrency = 64
    /// How much longer to keep listening for a second/third bridge once the first one answers,
    /// before returning what has been found so far. Keeps the none/one/many selection semantics
    /// (a genuinely "many" LAN is still detected) without paying the full sweep's worst-case
    /// duration once at least one bridge is already known to be up.
    private static let manyDetectionWindow: TimeInterval = 3.0
    /// Timeout for the saved-host fast path: one probe, so it can afford to be a little more
    /// patient than a single slot in the /24 sweep.
    private static let savedHostProbeTimeout: TimeInterval = 1.5

    /// Sweeps the Watch's own /24 on `defaultPort` and `lastKnownPort` (when different) at
    /// `/v1/health`. Returns every address that answered with `ok: true` and a `bridgeId`; a
    /// timeout, connection refusal or malformed body is silently excluded rather than treated as
    /// an error.
    ///
    /// Two speedups over a plain full sweep:
    /// 1. `lastKnownHost` (the last address the Watch actually connected to, e.g. `store.hostText`)
    ///    is probed directly first. On an unchanged home network this answers in well under a
    ///    second and the full /24 sweep never runs at all -- the previous version always paid the
    ///    full sweep's worst case (up to ~24s: 254 addresses x up to 2 ports / 32 in flight x
    ///    1.5s) even when the Watch was reconnecting to the exact same Mac it paired with.
    /// 2. Once the sweep does run, it no longer waits for every one of the (up to 508) targets to
    ///    resolve or time out: it returns `manyDetectionWindow` after the first hit, so a
    ///    single-bridge LAN (the overwhelmingly common case) finishes in roughly
    ///    one-probe-latency + 3s instead of the full sweep's worst case, while a genuinely
    ///    multi-bridge LAN still gets a window to surface the others.
    static func sweep(lastKnownHost: String?, lastKnownPort: Int?, session: URLSession = .shared) async -> [FoundBridge] {
        var ports = [defaultPort]
        if let lastKnownPort, lastKnownPort != defaultPort {
            ports.append(lastKnownPort)
        }

        if let lastKnownHost, !lastKnownHost.isEmpty {
            for port in ports {
                if let hit = await probe(host: lastKnownHost, port: port, session: session, timeout: savedHostProbeTimeout) {
                    return [hit]
                }
            }
        }

        guard let (baseAddress, hostBase) = localIPv4Prefix() else { return [] }

        var targets: [(host: String, port: Int)] = []
        for hostOctet in 1 ... 254 where hostOctet != hostBase {
            let host = "\(baseAddress).\(hostOctet)"
            guard host != lastKnownHost else { continue } // already probed above.
            for port in ports {
                targets.append((host: host, port: port))
            }
        }

        let probeSession = session

        return await withTaskGroup(of: FoundBridge?.self) { group in
            var results: [FoundBridge] = []
            var index = 0
            var deadline: Date?

            func addNext() {
                guard index < targets.count else { return }
                let target = targets[index]
                index += 1
                group.addTask {
                    await probe(host: target.host, port: target.port, session: probeSession, timeout: sweepProbeTimeout)
                }
            }

            for _ in 0 ..< min(sweepConcurrency, targets.count) { addNext() }
            while let outcome = await group.next() {
                if let outcome {
                    results.append(outcome)
                    if deadline == nil {
                        deadline = Date().addingTimeInterval(manyDetectionWindow)
                    }
                }
                if let deadline, Date() >= deadline {
                    break
                }
                addNext()
            }
            group.cancelAll() // Stop any still-running probes rather than waiting out their timeout.
            return results
        }
    }

    private static func probe(host: String, port: Int, session: URLSession, timeout: TimeInterval) async -> FoundBridge? {
        guard let url = URL(string: "http://\(host):\(port)/v1/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        guard
            let (data, response) = try? await session.data(for: request),
            let http = response as? HTTPURLResponse, http.statusCode == 200,
            let body = try? JSONDecoder().decode(HealthBody.self, from: data),
            body.ok
        else { return nil }
        return FoundBridge(host: host, port: port, bridgeId: body.bridgeId, name: body.name ?? "\(host):\(port)")
    }

    /// The Watch's own IPv4 address and netmask, preferring `en0`, via `getifaddrs`. Returns the
    /// address's /24 prefix ("192.168.1") and its own last octet (excluded from the sweep), or
    /// `nil` when no usable non-loopback IPv4 interface is up.
    private static func localIPv4Prefix() -> (prefix: String, hostOctet: Int)? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }

        var candidates: [(name: String, address: String)] = []
        var pointer: UnsafeMutablePointer<ifaddrs>? = first
        while let current = pointer {
            defer { pointer = current.pointee.ifa_next }
            let flags = Int32(current.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            guard let addr = current.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                addr, socklen_t(addr.pointee.sa_len),
                &host, socklen_t(host.count),
                nil, 0, NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let name = String(cString: current.pointee.ifa_name)
            let address = String(cString: host)
            candidates.append((name: name, address: address))
        }

        guard !candidates.isEmpty else { return nil }
        let chosen = candidates.first { $0.name == "en0" } ?? candidates[0]
        let parts = chosen.address.split(separator: ".")
        guard parts.count == 4, let lastOctet = Int(parts[3]) else { return nil }
        return (prefix: parts[0 ..< 3].joined(separator: "."), hostOctet: lastOctet)
    }
}

/// The result of one sweep, as the onboarding flow needs to branch on it. A pure classification
/// kept separate from `sweep(...)` so it is testable without any networking.
enum BridgeSelection: Equatable {
    case none
    case one(FoundBridge)
    case many([FoundBridge])

    static func select(_ found: [FoundBridge]) -> BridgeSelection {
        switch found.count {
        case 0: .none
        case 1: .one(found[0])
        default: .many(found)
        }
    }
}
