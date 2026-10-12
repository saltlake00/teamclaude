import Foundation

// 상태바 앱이 TeamClaude 프록시를 다루는 방식의 판정 로직(순수 함수).
//
// supervisor 강제 재시작(launchctl kickstart의 -k 옵션)은 진행 중인 Claude Code 요청을 모두 끊는다.
// 그래서 앱은 다음 원칙을 지킨다.
//  - 계정 설정 변경: CLI가 이미 worker에 SIGHUP으로 무중단 반영한다. 남은 불일치만
//    검증된 worker에 SIGHUP을 한 번 더 보내고, 그래도 남으면 경고만 한다.
//  - 서버 연결 실패: 프로세스가 살아 있으면 응답 지연으로 보고 아무것도 하지 않는다.
//    launchd 프로세스도 없고 포트도 닫혀 있을 때만 `-k` 없는 kickstart로 멈춘 서비스를 시작한다.
//  - `-k` 재시작은 사용자가 확인 대화상자에서 명시적으로 고른 경우뿐이다.

/// `launchctl print gui/<uid>/<label>` 결과.
enum TeamClaudeLaunchdProbe: Equatable {
    case running(pid: Int32)
    case loadedNotRunning
    case notLoaded
    case unknown
}

/// 프록시 포트 TCP 연결 시도 결과.
enum TeamClaudePortProbe: Equatable {
    case listening
    case refused
    /// 타임아웃 등으로 판별하지 못함. 살아 있는 것으로 취급한다(죽이지 않는 쪽).
    case unknown
}

enum TeamClaudeOutageVerdict: Equatable {
    /// 프로세스가 살아 있거나 포트를 누가 잡고 있다. 재시작하지 않는다.
    case responseDelayed(pid: Int32?)
    /// launchd 프로세스도 없고 포트도 닫혔다. `-k` 없는 kickstart로 시작만 한다.
    case startStoppedService
    /// launchd에 서비스가 등록돼 있지 않다. kickstart로는 살릴 수 없으므로 경고만 한다.
    case serviceNotLoaded
    /// launchd 상태를 읽지 못했다. 증거 없이 조치하지 않는다.
    case undetermined
}

enum TeamClaudeSyncPlan: Equatable {
    /// 서버가 응답하고 불일치도 없다(CLI가 이미 라이브 반영함).
    case nothing
    /// 서버는 응답하지만 계정 불일치가 남았다. worker SIGHUP으로 무중단 재로딩.
    case reloadAccounts
    /// 서버가 응답하지 않는다. 프로세스 생존부터 확인한다.
    case checkLiveness
}

struct TeamClaudeProcessIdentity: Equatable {
    let pid: Int32
    let ppid: Int32
    let startedAt: String
    let command: String
}

struct TeamClaudeServerStateSnapshot: Equatable {
    let supervisorPid: Int32?
    let workerPid: Int32?
    let configPath: String?
    let recordedWorker: TeamClaudeProcessIdentity?
}

enum TeamClaudeWorkerSignalDecision: Equatable {
    case signal(pid: Int32)
    case refuse(String)
}

struct TeamClaudeRestartConfirmation: Equatable {
    let title: String
    let message: String
    let confirmTitle: String
    let cancelTitle: String
}

/// `launchctl print`의 최상위(탭 한 개 들여쓰기) `pid = N` 줄만 서비스 pid로 읽는다.
/// 중첩 블록 안의 pid는 무시한다. exit 113은 서비스 미등록이다.
func parseTeamClaudeLaunchdPrint(output: String, exitStatus: Int32) -> TeamClaudeLaunchdProbe {
    if exitStatus == 113 { return .notLoaded }
    guard exitStatus == 0 else { return .unknown }
    var sawTopLevelField = false
    for rawLine in output.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(rawLine)
        guard line.hasPrefix("\t"), !line.hasPrefix("\t\t") else { continue }
        let field = line.dropFirst()
        sawTopLevelField = true
        guard field.hasPrefix("pid = ") else { continue }
        let value = field.dropFirst("pid = ".count).trimmingCharacters(in: .whitespaces)
        if let pid = Int32(value), pid > 0 { return .running(pid: pid) }
    }
    return sawTopLevelField ? .loadedNotRunning : .unknown
}

func teamClaudeOutageVerdict(
    launchd: TeamClaudeLaunchdProbe,
    launchdPidAlive: Bool,
    port: TeamClaudePortProbe
) -> TeamClaudeOutageVerdict {
    if case .running(let pid) = launchd, launchdPidAlive {
        return .responseDelayed(pid: pid)
    }
    if port != .refused { return .responseDelayed(pid: nil) }
    switch launchd {
    case .running, .loadedNotRunning: return .startStoppedService
    case .notLoaded: return .serviceNotLoaded
    case .unknown: return .undetermined
    }
}

func teamClaudeSyncPlan(serverReachable: Bool, accountConfigDrift: Int) -> TeamClaudeSyncPlan {
    guard serverReachable else { return .checkLiveness }
    return accountConfigDrift > 0 ? .reloadAccounts : .nothing
}

/// `ps -o ppid= -o lstart= -o command= -p <pid>`(LC_TIME=C) 한 줄을 읽는다.
/// 프록시의 readProcessIdentity와 같은 형식(lstart 24자)이다.
func parseTeamClaudePsIdentity(pid: Int32, output: String) -> TeamClaudeProcessIdentity? {
    let line = output.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let regex = try? NSRegularExpression(pattern: "^(\\d+)\\s+(.{24})\\s+([\\s\\S]+)$"),
          let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
          let ppidRange = Range(match.range(at: 1), in: line),
          let startedRange = Range(match.range(at: 2), in: line),
          let commandRange = Range(match.range(at: 3), in: line),
          let ppid = Int32(line[ppidRange]) else {
        return nil
    }
    return TeamClaudeProcessIdentity(
        pid: pid,
        ppid: ppid,
        startedAt: line[startedRange].trimmingCharacters(in: .whitespaces),
        command: line[commandRange].trimmingCharacters(in: .whitespacesAndNewlines)
    )
}

private func teamClaudeInt32(_ value: Any?) -> Int32? {
    if let number = value as? NSNumber {
        let double = number.doubleValue
        guard double.isFinite, double == double.rounded(),
              double >= Double(Int32.min), double <= Double(Int32.max) else { return nil }
        return Int32(double)
    }
    if let string = value as? String { return Int32(string) }
    return nil
}

/// `<config>.server.json` 상태 파일에서 worker 검증에 필요한 값만 읽는다.
func parseTeamClaudeServerState(_ json: [String: Any]?) -> TeamClaudeServerStateSnapshot? {
    guard let json else { return nil }
    let lifecycle = json["lifecycle"] as? [String: Any]
    let worker = lifecycle?["worker"] as? [String: Any]
    var recordedWorker: TeamClaudeProcessIdentity?
    if let worker,
       let pid = teamClaudeInt32(worker["pid"]),
       let ppid = teamClaudeInt32(worker["ppid"]),
       let startedAt = worker["startedAt"] as? String,
       let command = worker["command"] as? String {
        recordedWorker = TeamClaudeProcessIdentity(pid: pid, ppid: ppid, startedAt: startedAt, command: command)
    }
    return TeamClaudeServerStateSnapshot(
        supervisorPid: teamClaudeInt32(json["pid"]),
        workerPid: teamClaudeInt32(json["workerPid"]),
        configPath: json["config"] as? String,
        recordedWorker: recordedWorker
    )
}

/// Anthropic 모드 `teamclaude server` 프로세스 명령인가. codex 서버(`... codex server`)는 아니다.
func teamClaudeIsServerCommand(_ command: String) -> Bool {
    let tokens = command.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
    guard let serverIndex = tokens.lastIndex(of: "server"), serverIndex == tokens.count - 1 else { return false }
    guard let entryIndex = tokens.firstIndex(where: { token in
        token.hasSuffix("/src/teamclaude.js")
            || token.hasSuffix("/src/index.js")
            || (token as NSString).lastPathComponent == "teamclaude"
    }) else { return false }
    // 진입점과 server 사이에 다른 인자(codex 등)가 있으면 다른 모드다.
    return entryIndex + 1 == serverIndex
}

/// worker에 SIGHUP을 보내도 되는가. 프록시 CLI의 verifyWorkerIdentity와 같은 기준으로,
/// 상태 파일 기록과 현재 프로세스(부모·시작 시각·명령)가 모두 일치할 때만 허용한다.
func teamClaudeWorkerSignalDecision(
    state: TeamClaudeServerStateSnapshot?,
    expectedConfigPath: String,
    launchd: TeamClaudeLaunchdProbe,
    observedWorker: TeamClaudeProcessIdentity?
) -> TeamClaudeWorkerSignalDecision {
    guard let state else { return .refuse("상태 파일 없음") }
    guard state.configPath == expectedConfigPath else { return .refuse("다른 설정 파일의 서버") }
    guard let supervisorPid = state.supervisorPid, supervisorPid > 1,
          let workerPid = state.workerPid, workerPid > 1, workerPid != supervisorPid else {
        return .refuse("상태 파일 pid 이상")
    }
    guard case .running(let launchdPid) = launchd, launchdPid == supervisorPid else {
        return .refuse("launchd 서비스 pid와 supervisor 불일치")
    }
    guard let recorded = state.recordedWorker, recorded.pid == workerPid, recorded.ppid == supervisorPid else {
        return .refuse("worker 기록 없음")
    }
    guard teamClaudeIsServerCommand(recorded.command) else { return .refuse("teamclaude server 명령 아님") }
    guard let observedWorker else { return .refuse("worker 프로세스 없음") }
    guard observedWorker == recorded else { return .refuse("worker 프로세스가 기록과 다름") }
    return .signal(pid: workerPid)
}

/// 사용자가 "서버 재시작"을 눌렀을 때의 확인 대화상자 문구.
func teamClaudeRestartConfirmation(inflight: Int?, serverReachable: Bool) -> TeamClaudeRestartConfirmation {
    let impact: String
    if serverReachable, let inflight, inflight >= 0 {
        impact = inflight > 0
            ? "진행 중 요청 \(inflight)건이 끊깁니다."
            : "진행 중 요청은 없습니다."
    } else {
        impact = "서버 상태를 읽지 못해 진행 중 요청 수를 확인하지 못했습니다. 진행 중인 요청이 있으면 모두 끊깁니다."
    }
    return TeamClaudeRestartConfirmation(
        title: "TeamClaude 서버를 재시작할까요?",
        message: impact + "\n계정 추가·재인증·켜기/끄기는 재시작 없이 자동 반영되므로 보통은 필요하지 않습니다.",
        confirmTitle: "재시작",
        cancelTitle: "취소"
    )
}

func teamClaudeServerPillLabel(serverReachable: Bool, responseDelayed: Bool) -> String {
    if serverReachable { return "실행중" }
    return responseDelayed ? "응답 지연" : "오프라인"
}

func teamClaudeDriftActionDetail(persistsAfterReload: Bool) -> String {
    persistsAfterReload
        ? "재로딩 후에도 남음 · 재시작하지 않음"
        : "자동 동기화 중 · 서버 반영 확인"
}
