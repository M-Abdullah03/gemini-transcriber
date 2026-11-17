// systap: streams all macOS system audio to stdout as 16 kHz mono Int16 little-endian PCM.
// Uses a Core Audio process tap (macOS 14.2+). Playback is not affected (tap is unmuted).
// Stops on SIGINT/SIGTERM or when stdout closes.

import AVFoundation
import CoreAudio
import Foundation

var childPID: pid_t = 0  // set by the relaunch wrapper below; read from its signal handler

// macOS grants "System Audio Recording" to the *responsible* process, which would be the Python
// server (and so every script run by that Python). Relaunch ourselves with responsibility
// disclaimed so the permission belongs to this helper alone. This is the same private libSystem
// call Chromium and LLDB use for their helpers.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

if getenv("SYSTAP_DISCLAIMED") == nil, let exe = Bundle.main.executablePath {
    setenv("SYSTAP_DISCLAIMED", "1", 1)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
    var pid: pid_t = 0
    let argv = CommandLine.arguments.map { strdup($0) } + [nil]
    // stdin/stdout/stderr are inherited, so the child writes straight to our caller's pipes.
    let rc = posix_spawn(&pid, exe, nil, &attr, argv, environ)
    posix_spawnattr_destroy(&attr)
    guard rc == 0 else {
        FileHandle.standardError.write("systap: relaunch failed (\(rc))\n".data(using: .utf8)!)
        exit(1)
    }
    // Forward stop signals to the child, then exit with its status.
    for sig in [SIGINT, SIGTERM, SIGHUP] {
        signal(sig) { s in kill(childPID, s) }
    }
    childPID = pid
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    let termSig = status & 0x7f
    exit(termSig == 0 ? (status >> 8) & 0xff : 128 + termSig)
}

func fail(_ msg: String, _ status: OSStatus = 0) -> Never {
    FileHandle.standardError.write("systap: \(msg) (status \(status))\n".data(using: .utf8)!)
    exit(1)
}

func getProp<T>(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) -> OSStatus {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value)
}

// Without "System Audio Recording" permission a tap silently returns zeros, so check it first.
// TCC has no public API for this; these are the private calls Apple's own tools use.
func audioCapturePermission(request: Bool) -> String {
    guard let h = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
          let pre = dlsym(h, "TCCAccessPreflight") else { return "unknown" }
    typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    let service = "kTCCServiceAudioCapture" as CFString
    let state = unsafeBitCast(pre, to: Preflight.self)(service, nil)
    if state == 0 { return "granted" }
    if state == 1 && !request { return "denied" }
    guard request, let req = dlsym(h, "TCCAccessRequest") else { return state == 1 ? "denied" : "unknown" }
    typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
    let done = DispatchSemaphore(value: 0)
    var ok = false
    unsafeBitCast(req, to: Request.self)(service, nil) { granted in ok = granted; done.signal() }
    done.wait()
    return ok ? "granted" : "denied"
}

if CommandLine.arguments.contains("--check") {
    print(audioCapturePermission(request: CommandLine.arguments.contains("--request")))
    exit(0)
}
if audioCapturePermission(request: true) == "denied" {
    FileHandle.standardError.write("systap: PERMISSION_DENIED\n".data(using: .utf8)!)
    exit(2)
}

// Default output device UID (the aggregate device clocks off it).
var outputID = AudioObjectID(kAudioObjectUnknown)
var st = getProp(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, &outputID)
guard st == noErr else { fail("no default output device", st) }
var outputUID: CFString = "" as CFString
st = getProp(outputID, kAudioDevicePropertyDeviceUID, &outputUID)
guard st == noErr else { fail("could not read output device UID", st) }

// Global stereo tap of every process, audio keeps playing normally.
let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDesc.uuid = UUID()
tapDesc.name = "gemini-transcriber-tap"
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateProcessTap(tapDesc, &tapID)
guard st == noErr else { fail("could not create process tap", st) }

var tapFormat = AudioStreamBasicDescription()
st = getProp(tapID, kAudioTapPropertyFormat, &tapFormat)
guard st == noErr else { fail("could not read tap format", st) }

let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "gemini-transcriber-aggregate",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID as String,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID as String]],
    kAudioAggregateDeviceTapListKey: [[
        kAudioSubTapDriftCompensationKey: true,
        kAudioSubTapUIDKey: tapDesc.uuid.uuidString,
    ]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
guard st == noErr else { AudioHardwareDestroyProcessTap(tapID); fail("could not create aggregate device", st) }

guard let inFormat = AVAudioFormat(streamDescription: &tapFormat),
      let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inFormat, to: outFormat)
else { fail("unsupported tap format \(tapFormat)") }

let writeQueue = DispatchQueue(label: "systap.write")
let stdout = FileHandle.standardOutput
signal(SIGPIPE, SIG_IGN)

var procID: AudioDeviceIOProcID?

func cleanup() {
    if let procID {
        AudioDeviceStop(aggID, procID)
        AudioDeviceDestroyIOProcID(aggID, procID)
    }
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
}

let ioQueue = DispatchQueue(label: "systap.io", qos: .userInteractive)
st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, ioQueue) { _, inInputData, _, _, _ in
    guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, bufferListNoCopy: inInputData, deallocator: nil) else { return }
    let cap = AVAudioFrameCount(Double(inBuf.frameLength) * 16000 / inFormat.sampleRate) + 32
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
    var fed = false
    var err: NSError?
    converter.convert(to: outBuf, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true
        status.pointee = .haveData
        return inBuf
    }
    guard err == nil, outBuf.frameLength > 0, let ptr = outBuf.int16ChannelData?[0] else { return }
    let data = Data(bytes: ptr, count: Int(outBuf.frameLength) * 2)
    writeQueue.async {
        do { try stdout.write(contentsOf: data) } catch { cleanup(); exit(0) }
    }
}
guard st == noErr, procID != nil else { fail("could not create IO proc", st) }

st = AudioDeviceStart(aggID, procID)
guard st == noErr else { cleanup(); fail("could not start capture", st) }
FileHandle.standardError.write("systap: capturing system audio at \(Int(inFormat.sampleRate)) Hz\n".data(using: .utf8)!)

for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { cleanup(); exit(0) }
    src.resume()
    _ = Unmanaged.passRetained(src)
}
dispatchMain()
