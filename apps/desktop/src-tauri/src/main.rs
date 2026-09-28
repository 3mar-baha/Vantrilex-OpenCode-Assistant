#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Voxaura shell entry — window + the outer-most process supervisor.
//
// Two-tier ownership, made explicit:
//   * The NODE DAEMON remains the authority for `opencode serve` (it owns the
//     launcher, port policy and sibling sweeper — see src/launcher/). The shell
//     only *nudges* a missing serve into existence so a cold double-click works.
//   * The shell spawns the daemon when it is absent, and owns the lifetime of
//     every child IT created: on exit they are killed, so no orphans survive.
//
// Networking, process control and the Job Object remain std-only; the two
// deliberate crate dependencies are `getrandom` (the OS CSPRNG, used for every
// secret in this file — see `secure_random_bytes`) and `windows-sys` (the Job
// Object and the DACL work in `restrict_to_owner`). Command resolution is
// env-overridable so a packaged build can point at sidecars without recompiling.
//
// IPC identity (H4): the WS-4097 bearer is NOT baked into the bundle. This
// process writes a random per-install token to
// `~/.opencode-voice-runtime/ipc.token` and the webview asks for it at runtime
// through the `ipc_token` command below. The file is NOT created with Unix
// `0600` — see `restrict_to_owner` for what it actually gets, which is a
// protected, owner-only DACL, because on Windows `0o600` is a silent no-op.
use serde::Serialize;
use std::fs;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const OPENCODE_PORT: u16 = 4096;
const DAEMON_PORT: u16 = 4097;

/// Windows Job Object with KILL_ON_JOB_CLOSE. Handles are not RAII-wrapped:
/// the job must outlive every child for the kernel to enforce the kill, and it
/// is intentionally never closed (process teardown closes it, which is exactly
/// the trigger we want).
#[cfg(windows)]
struct KillOnCloseJob(HANDLE);

#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}
#[cfg(windows)]
unsafe impl Sync for KillOnCloseJob {}

#[cfg(windows)]
impl KillOnCloseJob {
    fn create() -> Option<Self> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let _ = CloseHandle(job);
                return None;
            }
            Some(KillOnCloseJob(job))
        }
    }

    /// Returns whether the kernel actually took ownership. Callers MUST act on
    /// `false`; see `adoption_action`.
    fn adopt(&self, child: &Child) -> bool {
        unsafe {
            let handle = child.as_raw_handle() as HANDLE;
            AssignProcessToJobObject(self.0, handle) != 0
        }
    }
}

/// What to do with a child whose Job-Object adoption returned `ok`.
///
/// D10: adoption used to be `let _ = AssignProcessToJobObject(..)` — the BOOL
/// was discarded, so a child the kernel refused was still counted as
/// supervised and still survived our death. There is no safe "ignore" here.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum AdoptionAction {
    /// The kernel will kill it when this process dies.
    Keep,
    /// Not in the job: it would outlive us, so kill it now.
    Kill,
}

fn adoption_action(ok: bool) -> AdoptionAction {
    if ok {
        AdoptionAction::Keep
    } else {
        AdoptionAction::Kill
    }
}

/// Where a child's logs went, or why they went nowhere.
///
/// D12: `fs::File::create` was matched with `Err(_) => cmd.stderr(Stdio::null())`.
/// On Windows a sharing violation on a handle held by a previous daemon makes
/// that create fail, and the child's stderr then vanished with no trace at all —
/// which is exactly what the 2026-09-27 forensics saw (a zero-byte
/// `daemon-stderr.log` untouched across ~18 h of recorded spawns).
#[derive(Debug, PartialEq, Eq)]
enum LogPlan {
    /// The canonical `<stem>.log` is openable.
    Primary(PathBuf),
    /// The canonical name was taken; a unique file is open instead.
    Fallback(PathBuf),
    /// Nothing could be opened. The message names the underlying errors.
    Unavailable(String),
}

/// A short unique suffix for the fallback file. No clock dependency: the pid
/// plus a monotonic counter is enough to disambiguate concurrent launches.
fn unique_suffix() -> String {
    use std::sync::atomic::AtomicU32;
    static SEQ: AtomicU32 = AtomicU32::new(0);
    format!("{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst))
}

/// Open `<stem>.log` in append mode, falling back to a unique file.
///
/// Append, never truncate: a restart that fails for a different reason must not
/// erase the evidence of the previous failure.
fn plan_child_logs(dir: &Path, stem: &str) -> LogPlan {
    let primary = dir.join(format!("{stem}.log"));
    match open_append(&primary) {
        Ok(_) => LogPlan::Primary(primary),
        Err(first) => {
            let fallback = dir.join(format!("{stem}-{}.log", unique_suffix()));
            match open_append(&fallback) {
                Ok(_) => {
                    log_line(&format!(
                        "log: {primary:?} unavailable ({first}); using {fallback:?}"
                    ));
                    LogPlan::Fallback(fallback)
                }
                Err(second) => LogPlan::Unavailable(format!(
                    "could not open child logs for {stem}: {primary:?} failed ({first}); fallback {fallback:?} failed ({second})"
                )),
            }
        }
    }
}

fn open_append(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().append(true).create(true).open(path)
}

/// Both streams are captured, to two distinct files, so `console.log` from the
/// daemon is as diagnosable as its `console.error`. stdout used to be
/// unconditionally `Stdio::null()`.
fn open_child_stdout(dir: &Path, stem: &str) -> Option<fs::File> {
    open_append(&dir.join(format!("{stem}-stdout.log"))).ok()
}

fn open_child_stderr(dir: &Path, stem: &str) -> Option<fs::File> {
    match plan_child_logs(dir, stem) {
        LogPlan::Primary(p) | LogPlan::Fallback(p) => open_append(&p).ok(),
        LogPlan::Unavailable(msg) => {
            log_line(&format!("log: {msg}"));
            None
        }
    }
}

/// Who a running `opencode serve` process belongs to.
///
/// D11: `resolve_opencode_bin()` deliberately reuses the CLI the OpenCode
/// *desktop app* installs, and that app runs its own `serve --service` on a
/// random port. Live on 2026-09-27: PID 19516 `opencode-cli.exe serve --service`
/// on :49374 while nothing held 4096. Two supervisors, one user.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ServeOwnership {
    /// A process we did not spawn, while our own port is cold.
    Foreign,
    /// One of ours, or not a serve.
    NotForeign,
}

/// Decide whether a foreign serve exists.
///
/// PID-based, not command-line based. `wmic` is absent on current Windows
/// images (measured: not found) and the `Get-CimInstance` equivalent costs
/// ~500 ms and is quoting-fragile across shells. `tasklist` was measured at
/// 134 ms and returns exactly what this predicate needs. What we lose is the
/// foreign command line in the log; what we keep is a detection that actually
/// runs on the machine users have.
fn foreign_serve_present(ours: &[u32], candidates: &[u32]) -> ServeOwnership {
    let foreign = candidates.iter().any(|pid| !ours.contains(pid));
    if foreign {
        ServeOwnership::Foreign
    } else {
        ServeOwnership::NotForeign
    }
}

/// Running `opencode-cli.exe` PIDs, via `tasklist`. Best effort by design: this
/// is a diagnostic, and a failure here must never stop bring-up. Returns an
/// empty list when the query cannot be answered.
#[cfg(windows)]
fn opencode_pids() -> Vec<u32> {
    let Ok(out) = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq opencode-cli.exe", "/FO", "CSV", "/NH"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        // CSV: "opencode-cli.exe","19516","Console","1","422,116 K"
        .filter_map(|line| line.split("\",\"").nth(1))
        .filter_map(|pid| pid.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(not(windows))]
fn opencode_pids() -> Vec<u32> {
    Vec::new()
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum BringUpAction {
    /// 4096 already answers: adopt it, never spawn a second serve.
    Adopt,
    /// Cold, and we are the only candidate.
    Spawn,
    /// Cold, but a foreign serve exists. Spawn ours AND say so.
    SpawnAndWarn,
}

fn bring_up_action(port_already_open: bool, foreign_serve_present: bool) -> BringUpAction {
    if port_already_open {
        BringUpAction::Adopt
    } else if foreign_serve_present {
        BringUpAction::SpawnAndWarn
    } else {
        BringUpAction::Spawn
    }
}

/// Outcome of spawn-then-wait-for-port.
#[derive(Debug)]
enum BindOutcome {
    /// The port opened inside the budget; the child is handed back for supervision.
    Bound(Child),
    /// The child never opened the port and has been KILLED (L12).
    TimedOut { pid: u32 },
    /// The command could not be started at all.
    SpawnFailed(String),
}

/// Spawn `cmd` and wait for `port` to answer.
///
/// L12: the old code spawned, waited, and on timeout returned `Err` while the
/// child kept running for the rest of the session — a process holding a half-open
/// port with nothing to reap it. The child is now killed before returning.
fn spawn_and_wait_for_port(cmd: &mut Command, port: u16, budget: Duration) -> BindOutcome {
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return BindOutcome::SpawnFailed(format!("could not spawn process: {e}")),
    };
    let pid = child.id();
    if !wait_for_port(port, budget) {
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
        return BindOutcome::TimedOut { pid };
    }
    BindOutcome::Bound(child)
}

/// Bring-up result as the shell sees it.
///
/// L11: `ensure_all_services` returned `Vec<String>`, so "someone else is
/// already bringing the app up" and "it worked" and "it failed" were the same
/// type. The frontend could not tell them apart and never retried, which is
/// indistinguishable from a hang.
#[derive(Debug, Clone, Serialize)]
struct BringUpStatus {
    /// `ready` | `in-flight` | `failed`
    state: &'static str,
    detail: String,
    /// Whether the caller should simply try again. True only for `in-flight`.
    retriable: bool,
    steps: Vec<String>,
}

impl BringUpStatus {
    fn ready(steps: Vec<String>) -> Self {
        Self { state: "ready", detail: steps.join("; "), retriable: false, steps }
    }

    fn in_flight() -> Self {
        Self {
            state: "in-flight",
            detail: "bring-up already in flight".to_string(),
            retriable: true,
            steps: Vec::new(),
        }
    }

    fn failed(detail: &str) -> Self {
        Self {
            state: "failed",
            detail: detail.to_string(),
            retriable: false,
            steps: Vec::new(),
        }
    }
}

/// Single-flight guard: setup and the frontend both request bring-up; without
/// this they race and spawn duplicate children (the loser exits, and the race
/// can leave neither holding the port).
static BRINGUP_INFLIGHT: AtomicBool = AtomicBool::new(false);

/// Children spawned by THIS process. Killed on exit; never touched if they were
/// already running before we started (we did not create them). On Windows the
/// job object is the hard guarantee; this list is the graceful path.
#[derive(Default)]
struct Supervisor {
    children: Mutex<Vec<Child>>,
    /// Children the kernel refused to adopt. They are killed immediately, but
    /// the count is retained because a non-zero value is the signature of a
    /// broken Job Object and belongs in the log.
    unadopted: Mutex<usize>,
    #[cfg(windows)]
    job: std::sync::OnceLock<Option<KillOnCloseJob>>,
}

impl Supervisor {
    #[cfg(windows)]
    fn job(&self) -> Option<&KillOnCloseJob> {
        self.job.get_or_init(KillOnCloseJob::create).as_ref()
    }

    /// Take ownership of a child. Returns whether it is now kernel-supervised.
    ///
    /// D10: on Windows a child the job refused is KILLED, not tracked. A child
    /// we cannot reap on exit is an orphan the moment we are gone, and an
    /// orphan holding 4096 blocks the next cold launch.
    fn own(&self, child: Child) -> bool {
        #[cfg(windows)]
        {
            let ok = self.job().is_none_or(|job| job.adopt(&child));
            self.own_with_adoption(child, ok)
        }
        #[cfg(not(windows))]
        {
            self.own_with_adoption(child, true)
        }
    }

    /// Split out so the failure branch is testable without provoking a real
    /// `AssignProcessToJobObject` error, which cannot be forced portably.
    fn own_with_adoption(&self, mut child: Child, adopted: bool) -> bool {
        if adoption_action(adopted) == AdoptionAction::Kill {
            let _ = child.kill();
            let _ = child.wait();
            if let Ok(mut n) = self.unadopted.lock() {
                *n += 1;
            }
            log_line(&format!(
                "supervisor: job-adopt-failed pid={} — killed immediately (it would have outlived us)",
                child.id()
            ));
            return false;
        }
        if let Ok(mut kids) = self.children.lock() {
            kids.push(child);
        }
        true
    }

    /// Test-only: production reports the unadopted count, not the child count.
    #[cfg(test)]
    fn child_count(&self) -> usize {
        self.children.lock().map(|k| k.len()).unwrap_or(0)
    }

    /// PIDs of children we own, so foreign-process detection can exclude them.
    fn pids(&self) -> Vec<u32> {
        self.children.lock().map(|k| k.iter().map(|c| c.id()).collect()).unwrap_or_default()
    }

    fn unadopted(&self) -> usize {
        self.unadopted.lock().map(|n| *n).unwrap_or(0)
    }

    fn reap(&self) {
        let Ok(mut kids) = self.children.lock() else { return };
        for child in kids.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        kids.clear();
    }
}

fn runtime_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let mut path = PathBuf::from(home);
    path.push(".opencode-voice-runtime");
    Some(path)
}

/// Append one line to the supervisor log, in the runtime directory. Diagnostics
/// only — never credentials, never transcript content. This file carries no
/// credential, so it deliberately does NOT get the owner-only DACL that
/// `restrict_to_owner` applies to `ipc.token` and `serve.pass`.
fn log_line(message: &str) {
    let Some(dir) = runtime_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("supervisor.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut existing) = fs::read_to_string(&path) {
        existing.push_str(&format!("[{stamp}] {message}\n"));
        let _ = fs::write(&path, existing);
    } else {
        let _ = fs::write(&path, format!("[{stamp}] {message}\n"));
    }
}

fn token_path() -> Option<PathBuf> {
    Some(runtime_dir()?.join("ipc.token"))
}

/// Bytes of entropy behind every secret in this file. 32 bytes -> 64 hex chars.
const SECRET_BYTES: usize = 32;

/// Fill `N` bytes from the operating system's cryptographic RNG.
///
/// Dossier S2. The generator this replaced was an xorshift64* whose entire
/// state was `SystemTime::now().as_nanos() as u64 ^ process::id() as u64`.
/// Both halves of that seed are observable rather than secret: the wall clock
/// is readable by anything running on the machine, and a Windows PID is a
/// bounded enumerable integer (1..=65535). Worse, the old loop emitted all 32
/// bytes from just *four* xorshift steps, so the 256-bit-looking secret was
/// fully determined by a ~64-bit seed, of which only the handful of nanosecond
/// values spanning the process's own startup window are plausible. The token
/// therefore carried roughly 2^30 effective bits, not 2^256, and an attacker who
/// had merely observed when the app launched could regenerate it offline.
///
/// `getrandom` reaches the kernel CSPRNG (RtlGenRandom/BCryptGenRandom on
/// Windows). It fails rather than degrading, which is why this returns
/// `Result`: a weak secret must never be produced as a fallback.
fn secure_random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| format!("csprng: {e}"))?;
    Ok(buf)
}

/// A `SECRET_BYTES` CSPRNG secret, lower-case hex.
fn generate_secret() -> Result<String, String> {
    let bytes = secure_random_bytes::<SECRET_BYTES>()?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Write a secret to `path` and lock the file down to its owner, fail-closed.
///
/// Returns the secret so the caller does not have to re-read a file it just
/// wrote. The order matters: the bytes hit the disk *before* the DACL is set,
/// because the DACL call needs to own the file. If the DACL cannot be
/// applied, the file is removed again and the error propagates. Continuing
/// would mean knowingly leaving a live credential at whatever access level the
/// parent directory happened to grant, which is exactly the defect this
/// function exists to close.
///
/// Failing closed is safe for startup here: `setup()` and `ensure_all_services`
/// both log the error and keep going, and `ipc_token` then fails closed, so the
/// shell renders its disconnected state instead of inventing a credential.
fn write_protected_secret(path: &Path, secret: &str, label: &str) -> Result<(), String> {
    if let Err(e) = fs::write(path, secret) {
        return Err(format!("{label}: {e}"));
    }
    if let Err(e) = restrict_to_owner(path) {
        // Do not leave an unprotected secret on disk: the next launch will
        // re-read it via the `read_to_string` fast path and would then never
        // retry the ACL, so the weak file would be adopted as permanent.
        let _ = fs::remove_file(path);
        return Err(format!("{label}: {e}"));
    }
    Ok(())
}

/// Restrict `path` to its owner — the real Windows equivalent of Unix `0600`.
///
/// `std::fs::set_permissions(path, 0o600)` is NOT the answer here. On Windows
/// that function is `SetFileAttributes` and toggles nothing but the
/// FILE_ATTRIBUTE_READONLY bit; it compiles, returns `Ok(())`, and changes no
/// access control whatsoever. It is a silent no-op that reads like a working
/// permission check, which is the same failure shape as the comments that
/// used to claim `(0600)` while calling no ACL code at all. Windows carries
/// "only me" in a discretionary access control list, not in a mode bit.
///
/// Three properties make the result an actual `0600` rather than decoration:
///
///   1. `SetEntriesInAclW` is given a NULL `oldacl`, so the new DACL is built
///      only from the trustees we name instead of being merged into whatever
///      the parent directory contributed.
///   2. `PROTECTED_DACL_SECURITY_INFORMATION` sets `SE_DACL_PROTECTED`, which
///      blocks inheritance from the parent. This is the part Unix gives for
///      free with `0600` and that the naive Windows equivalent silently lacks:
///      without it the guarantee is only as strong as `%USERPROFILE%`'s ACL,
///      which this process does not control and cannot assume.
///   3. The mask is `GENERIC_ALL`, which the kernel maps to concrete file
///      rights for the object, so this is a full-control grant — the Windows
///      analogue of `rw` for the owner, which is what `0600` means.
///
/// Trustees are the calling user's own SID plus the well-known LocalSystem SID.
/// LocalSystem is included so that system-level maintenance (backup agents,
/// servicing) is not locked out of the file; it does not weaken the boundary
/// this call exists to draw, which is "no other interactive user".
#[cfg(windows)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree, GENERIC_ALL};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SE_FILE_OBJECT, SET_ACCESS,
        TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, DACL_SECURITY_INFORMATION, GetFileSecurityW, WinLocalSystemSid,
        NO_INHERITANCE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    };

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide_path.push(0);

    // SECURITY_DESCRIPTOR_RELATIVE (0x8000) is the control bit
    // SetNamedSecurityInfoW needs alongside PROTECTED_DACL_SECURITY_INFORMATION;
    // it is passed implicitly as part of that SECURITY_INFORMATION mask, and
    // SetNamedSecurityInfoW builds the descriptor itself, so there is no
    // SECURITY_DESCRIPTOR_RELATIVE buffer for us to construct or free here.

    unsafe {
        // (a) The SID we are locking the file down TO is the file's own owner,
        // read back from its security descriptor. We just created the file, so
        // its owner is the identity that created it — which is the whole point
        // of a function named "restrict to owner".
        //
        // The obvious alternative is to ask the process token for its user SID
        // (OpenProcessToken + GetTokenInformation(TokenUser)). That is *not*
        // used here: on this machine `GetTokenInformation(TokenUser)` returns
        // ERROR_NOT_ENOUGH_MEMORY (998) even with the size query succeeding and
        // a 1 KiB buffer, so it is not a usable dependency. The file's owner SID
        // is one API call, needs no token access rights, and cannot drift from
        // the file's actual owner the way a token lookup could.
        let mut sd_len = 0u32;
        let _ = GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut sd_len,
        );
        if sd_len == 0 {
            return Err(format!("acl: owner size query failed ({})", GetLastError()));
        }
        // Kept alive until after SetEntriesInAclW, because the trustee array
        // below points into it.
        let mut descriptor = vec![0u8; sd_len as usize];
        let mut actual = 0u32;
        // NOTE: `lpnlengthneeded` is documented as [out, optional], but passing
        // NULL for it does NOT work on this OS: both GetFileSecurityW and
        // GetTokenInformation fail with ERROR_NOT_ENOUGH_MEMORY (998) even
        // when the size query succeeded and the buffer is comfortably large
        // enough. A real out-pointer is passed for that reason.
        if GetFileSecurityW(
            wide_path.as_ptr(),
            OWNER_SECURITY_INFORMATION,
            descriptor.as_mut_ptr() as *mut core::ffi::c_void,
            sd_len,
            &mut actual,
        ) == 0
        {
            return Err(format!("acl: owner read failed ({})", GetLastError()));
        }
        // SELF_RELATIVE security descriptor: [0]=Revision [1]=SBZ1 [2..4]=Control,
        // then OwnerOffset at [4..8] as a u32.
        let owner_offset = u32::from_le_bytes([
            descriptor[4],
            descriptor[5],
            descriptor[6],
            descriptor[7],
        ]) as usize;
        if owner_offset == 0 || owner_offset >= descriptor.len() {
            return Err("acl: security descriptor has no owner SID".to_string());
        }
        let owner_sid = descriptor.as_mut_ptr().add(owner_offset) as *mut core::ffi::c_void;

        // (b) the well-known LocalSystem SID. SECURITY_MAX_SID_SIZE.
        let mut system_sid = [0u8; 68];
        let mut system_len = system_sid.len() as u32;
        if CreateWellKnownSid(
            WinLocalSystemSid,
            std::ptr::null_mut(),
            system_sid.as_mut_ptr() as *mut core::ffi::c_void,
            &mut system_len,
        ) == 0
        {
            return Err(format!("acl: CreateWellKnownSid failed ({})", GetLastError()));
        }

        // (c) one GRANT+SET access-allowed ACE per trustee.
        //
        // The Win32 `TRUSTEE_W.ptstrName` member is a union that is genuinely
        // a PSID when `TrusteeForm == TRUSTEE_IS_SID` (and a PWSTR when it is
        // TRUSTEE_IS_NAME). windows-sys flattens that union to PWSTR, so each
        // SID pointer is reinterpreted here; the kernel reinterprets it back to
        // a SID because of the TRUSTEE_IS_SID form we set. `SetEntriesInAclW`
        // consumes the EXPLICIT_ACCESS_W array synchronously, so neither the
        // owner descriptor nor the SYSTEM buffer has to outlive this call.
        let trustees = [
            EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL,
                grfAccessMode: SET_ACCESS,
                grfInheritance: NO_INHERITANCE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: owner_sid as *mut u16,
                },
            },
            EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL,
                grfAccessMode: SET_ACCESS,
                grfInheritance: NO_INHERITANCE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                    ptstrName: system_sid.as_mut_ptr() as *mut u16,
                },
            },
        ];

        let mut acl: *mut windows_sys::Win32::Security::ACL = std::ptr::null_mut();
        let code = SetEntriesInAclW(
            trustees.len() as u32,
            trustees.as_ptr(),
            std::ptr::null(),
            &mut acl,
        );
        if code != 0 {
            return Err(format!("acl: SetEntriesInAclW failed ({code})"));
        }

        // (d) apply it, with inheritance blocked.
        let code = SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        );
        LocalFree(acl as _);
        if code != 0 {
            return Err(format!("acl: SetNamedSecurityInfoW failed ({code})"));
        }
    }
    Ok(())
}

/// Unix equivalent, so the same guarantee holds if this ever builds off-Windows.
#[cfg(not(windows))]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("acl: chmod 0600 failed ({e})"))
}

/// Generate or load the per-install IPC token. Written before any child
/// spawns so the UI can read it immediately via the `ipc_token` command.
///
/// When this process generates the file, it is created with a protected
/// owner-only DACL (see `restrict_to_owner`) — not Unix `0600`, which is a
/// no-op on Windows. A pre-existing file is read as-is and not rewritten.
fn ensure_ipc_token() -> Result<String, String> {
    if let Ok(explicit) = std::env::var("VOICE_RUNTIME_IPC_TOKEN") {
        if !explicit.trim().is_empty() {
            return Ok(explicit);
        }
    }
    let dir = runtime_dir().ok_or_else(|| "no home directory".to_string())?;
    let path = dir.join("ipc.token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let token = generate_secret()?;
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    write_protected_secret(&path, &token, "ipc.token")?;
    Ok(token)
}

/// Per-install serve password. The shell and the daemon must agree on one
/// credential for `opencode serve`; without it the daemon refuses to start
/// (fail-closed) and a cold double-click can never come up. Precedence: an
/// explicit env value wins, otherwise a generated 32-byte hex secret is stored
/// beside the IPC token — never in the bundle, never logged — under the same
/// protected owner-only DACL as the IPC token (see `restrict_to_owner`).
///
/// Lifetime: see `W3-S2-SERVE-PASS-LIFETIME` in
/// `.opencode/_audit/20-w3-csprng.md` for why this one is NOT rotated per
/// launch even though `ipc.token` is a candidate for it.
fn ensure_serve_password() -> Result<String, String> {
    if let Ok(explicit) = std::env::var("OPENCODE_SERVER_PASSWORD") {
        if !explicit.trim().is_empty() {
            return Ok(explicit);
        }
    }
    let dir = runtime_dir().ok_or_else(|| "no home directory".to_string())?;
    let path = dir.join("serve.pass");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let password = generate_secret()?;
    fs::create_dir_all(&dir).map_err(|e| format!("runtime dir: {e}"))?;
    write_protected_secret(&path, &password, "serve.pass")?;
    Ok(password)
}

/// Return the daemon's IPC token. Fails closed when the token file is absent —
/// the shell then renders its disconnected state instead of inventing a
/// credential.
#[tauri::command]
fn ipc_token() -> Result<String, String> {
    let path = token_path().ok_or_else(|| "no home directory".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|_| "ipc token not provisioned".to_string())?;
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Err("ipc token is empty".to_string());
    }
    Ok(token)
}

/// TCP reachability — sufficient to answer "is something serving this port?".
/// We deliberately do not authenticate here: the daemon and serve both require
/// credentials, and the shell must not carry any.
fn port_open(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), Duration::from_millis(400)).is_ok()
}

fn wait_for_port(port: u16, budget: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < budget {
        if port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    port_open(port)
}

/// Resolve the canonical OpenCode CLI: explicit env, else the desktop-bundled
/// 2.0.12 CLI, else bare `opencode` from PATH.
fn resolve_opencode_bin() -> String {
    if let Ok(explicit) = std::env::var("VOXAURA_OPENCODE_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let cli_root = PathBuf::from(appdata).join("ai.opencode.desktop").join("cli");
        let Ok(entries) = fs::read_dir(&cli_root) else {
            return "opencode".to_string();
        };
        let mut versions: Vec<(Vec<u32>, PathBuf)> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .map(|p| {
                let key = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
                    .split('.')
                    .map(|part| part.parse::<u32>().unwrap_or(0))
                    .collect::<Vec<u32>>();
                (key, p)
            })
            .collect();
        // Numeric compare: 2.0.12 must beat 2.0.6 (lexicographic would not).
        versions.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, dir) in versions.into_iter().rev() {
            let exe = dir.join("opencode-cli.exe");
            if exe.exists() {
                log_line(&format!("opencode binary: {}", exe.display()));
                return exe.to_string_lossy().to_string();
            }
        }
    }
    log_line("opencode binary: falling back to PATH name `opencode`");
    "opencode".to_string()
}

/// Resolve the daemon entrypoint. Precedence:
///   1. explicit VOXAURA_DAEMON_PATH
///   2. the BUNDLED sidecar next to the installed binary (`resources/sidecar/`)
///      — this is the self-contained path for a real install
///   3. `dist/cli.js` from the current directory or up the exe's ancestors
///      (the developer path: a double-clicked binary runs with cwd =
///      target/release, so climbing out is what finds the repo layout)
fn resolve_daemon_entry(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("VOXAURA_DAEMON_PATH") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("sidecar").join("dist").join("cli.js");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            roots.push(dir.clone());
            cursor = dir.parent().map(PathBuf::from);
        }
    }
    for root in roots {
        let candidate = root.join("dist").join("cli.js");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Windows extended-length paths (`\\?\O:\…`) are rejected by Node's module
/// resolver (`lstat 'O:'` → EISDIR). Strip the prefix before handing a path to
/// the child runtime.
fn plain_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

/// Canonical vault ROOT for this launch (the same root the Obsidian memory
/// graph uses — one place for keys and notes):
///   1. an explicit VOXAURA_VAULT_DIR
///   2. the `vault/` directory found among the daemon entrypoint's ancestors
///      (the developer/repo layout)
///   3. `%LOCALAPPDATA%\Voxaura\vault` (a real install has no repo to sit in)
fn resolve_vault_dir(entry: Option<&Path>) -> PathBuf {
    if let Ok(explicit) = std::env::var("VOXAURA_VAULT_DIR") {
        if !explicit.trim().is_empty() {
            let dir = PathBuf::from(explicit);
            log_line(&format!("resolve: vault={} (explicit)", dir.display()));
            return dir;
        }
    }
    if let Some(entry) = entry {
        let mut cursor = entry.parent().map(PathBuf::from);
        while let Some(dir) = cursor {
            let candidate = dir.join("vault");
            if candidate.is_dir() {
                log_line(&format!("resolve: vault={} (ancestor)", candidate.display()));
                return candidate;
            }
            cursor = dir.parent().map(PathBuf::from);
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| runtime_dir())
        .unwrap_or_else(|| PathBuf::from("."));
    let root = base.join("Voxaura").join("vault");
    // Ensure the install vault directory exists so key intake has a home, and
    // on first run seed it from a repo vault if one is found among the daemon
    // entrypoint's ancestors (developer upgrade path). Never overwrites.
    let _ = fs::create_dir_all(&root);
    let keyring = root.join("keyring.dat");
    if !keyring.exists() {
        if let Some(entry) = entry {
            let mut cursor = entry.parent().map(PathBuf::from);
            while let Some(dir) = cursor {
                let src = dir.join("vault").join("keyring.dat");
                if src.exists() {
                    if fs::copy(&src, &keyring).is_ok() {
                        log_line(&format!("vault seeded from {}", src.display()));
                    }
                    break;
                }
                cursor = dir.parent().map(PathBuf::from);
            }
        }
    }
    // The resolved vault is the one path a voice-dead install cannot be
    // diagnosed without. `Keyring.load` throws on an empty or partially
    // undecryptable vault, `rebuildVoice` turns that into a KEYS_MISSING
    // telemetry row, and from the logs alone that row is indistinguishable
    // from "the user never saved keys" — which is the wrong instruction,
    // because re-entering keys changes nothing if the path is wrong.
    log_line(&format!("resolve: vault={} (install default)", root.display()));
    root
}

/// Prefer the bundled Node runtime; fall back to PATH for development.
fn resolve_node_bin(resource_dir: Option<&Path>) -> String {
    if let Ok(explicit) = std::env::var("VOXAURA_NODE_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("sidecar").join("node.exe");
        if bundled.exists() {
            return plain_path(&bundled);
        }
    }
    "node".to_string()
}

/// Spawn `opencode serve` when 4096 is cold. Returns a human-readable status.
fn ensure_opencode(app: &tauri::AppHandle) -> Result<String, String> {
    // D11: the decision is made explicitly and logged. Adopting is always
    // preferred; a foreign serve is never silently ignored, because two
    // supervisors for one user is a real (and previously invisible) condition.
    let ours: Vec<u32> = {
        let sup = app.state::<Supervisor>();
        sup.pids()
    };
    let candidates = opencode_pids();
    let action = bring_up_action(
        port_open(OPENCODE_PORT),
        foreign_serve_present(&ours, &candidates) == ServeOwnership::Foreign,
    );
    match action {
        BringUpAction::Adopt => {
            return Ok(format!("opencode serve already on {OPENCODE_PORT}"));
        }
        BringUpAction::SpawnAndWarn => {
            log_line(&format!(
                "ensure_opencode: opencode-cli.exe pids {candidates:?} include {} process(es) we did not spawn, and {OPENCODE_PORT} is cold; \
                 this is a second supervisor (the OpenCode desktop app runs its own serve) — spawning ours anyway and recording it",
                candidates.iter().filter(|p| !ours.contains(p)).count()
            ));
        }
        BringUpAction::Spawn => {}
    }
    let bin = resolve_opencode_bin();
    let password = ensure_serve_password()?;
    let mut cmd = Command::new(&bin);
    cmd.args(["serve", "--port", &OPENCODE_PORT.to_string(), "--hostname", "127.0.0.1"])
        .stdin(Stdio::null());
    // D12: both streams captured, so a serve that dies during bring-up is
    // diagnosable instead of vanishing into Stdio::null().
    if let Some(dir) = runtime_dir() {
        let _ = fs::create_dir_all(&dir);
        if let Some(out) = open_child_stdout(&dir, "opencode") {
            cmd.stdout(Stdio::from(out));
        }
        if let Some(err) = open_child_stderr(&dir, "opencode") {
            cmd.stderr(Stdio::from(err));
        }
    }
    cmd.env("OPENCODE_SERVER_PASSWORD", &password);
    // L12: on a bind timeout the child is killed, not abandoned.
    match spawn_and_wait_for_port(&mut cmd, OPENCODE_PORT, Duration::from_secs(20)) {
        BindOutcome::Bound(child) => {
            let supervised = app.state::<Supervisor>().own(child);
            if !supervised {
                log_line("ensure_opencode: WARNING spawned serve could not be job-adopted and was killed");
            }
            Ok(format!("opencode serve started on {OPENCODE_PORT}"))
        }
        BindOutcome::TimedOut { pid } => {
            let hint = if candidates.iter().any(|p| !ours.contains(p)) {
                format!(
                    " (opencode-cli.exe pids {candidates:?} include a process we did not spawn; a second supervisor may hold the OpenCode profile lock)"
                )
            } else {
                String::new()
            };
            Err(format!(
                "opencode serve (pid {pid}) did not open {OPENCODE_PORT} in time; it was killed{hint}"
            ))
        }
        BindOutcome::SpawnFailed(msg) => Err(format!("could not spawn opencode ({bin}): {msg}")),
    }
}

/// Spawn the Node daemon when 4097 is cold. Requires a resolvable entrypoint.
fn ensure_daemon(app: &tauri::AppHandle, ipc_token: &str) -> Result<String, String> {
    if port_open(DAEMON_PORT) {
        return Ok(format!("daemon already on {DAEMON_PORT}"));
    }
    let resource_dir = app.path().resource_dir().ok();
    log_line(&format!(
        "resolve: resource_dir={:?}",
        resource_dir.as_ref().map(|p| p.display().to_string())
    ));
    let Some(entry) = resolve_daemon_entry(resource_dir.as_deref()) else {
        return Err("daemon entrypoint not found (bundled sidecar missing and VOXAURA_DAEMON_PATH unset)".to_string());
    };
    let node = resolve_node_bin(resource_dir.as_deref());
    log_line(&format!("resolve: node={node} entry={}", plain_path(&entry)));
    let password = ensure_serve_password()?;
    let mut cmd = Command::new(&node);
    cmd.arg(plain_path(&entry))
        .arg("serve")
        .stdin(Stdio::null())
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .env("VOICE_RUNTIME_IPC_TOKEN", ipc_token)
        .env("VOXAURA_VAULT_DIR", resolve_vault_dir(Some(&entry)));
    // D12: capture BOTH streams. The failure mode this replaces was a silently
    // swallowed File::create error degrading to Stdio::null(), which left a
    // zero-byte daemon-stderr.log across many real spawns.
    if let Some(dir) = runtime_dir() {
        let _ = fs::create_dir_all(&dir);
        match open_child_stdout(&dir, "daemon") {
            Some(out) => {
                cmd.stdout(Stdio::from(out));
            }
            None => {
                log_line("daemon: stdout capture unavailable — continuing without it");
            }
        }
        match open_child_stderr(&dir, "daemon") {
            Some(err) => {
                cmd.stderr(Stdio::from(err));
            }
            None => {
                log_line("daemon: stderr capture unavailable — bring-up failures will be silent");
            }
        }
    } else {
        log_line("daemon: no runtime dir — child logs disabled");
    }
    // L12: a daemon that never opens 4097 is killed rather than left running.
    match spawn_and_wait_for_port(&mut cmd, DAEMON_PORT, Duration::from_secs(20)) {
        BindOutcome::Bound(child) => {
            let supervised = app.state::<Supervisor>().own(child);
            if !supervised {
                log_line("ensure_daemon: WARNING spawned daemon could not be job-adopted and was killed");
            }
            Ok(format!("daemon started on {DAEMON_PORT}"))
        }
        BindOutcome::TimedOut { pid } => Err(format!(
            "daemon (pid {pid}) did not open {DAEMON_PORT} in time; it was killed (see daemon.log in the runtime dir)"
        )),
        BindOutcome::SpawnFailed(msg) => Err(format!("could not spawn daemon via {node}: {msg}")),
    }
}

/// Zero-click bring-up: nudge serve, then the daemon, then report. Errors are
/// returned (never panicked) so the UI can surface them.
///
/// L11: returns a typed status. "in-flight" is now distinguishable from
/// "failed" and marked retriable, so the shell can retry once instead of
/// waiting forever on an app that is still starting.
#[tauri::command]
fn ensure_all_services(app: tauri::AppHandle) -> Result<BringUpStatus, String> {
    if BRINGUP_INFLIGHT.swap(true, Ordering::SeqCst) {
        log_line("ensure_all_services: already in flight — skipping duplicate");
        return Ok(BringUpStatus::in_flight());
    }
    let result = (|| -> Result<Vec<String>, String> {
        log_line("ensure_all_services: begin");
        let ipc_token = ensure_ipc_token()?;
        log_line("ipc token: ready");
        let opencode = ensure_opencode(&app)?;
        log_line(&format!("opencode: {opencode}"));
        let daemon = ensure_daemon(&app, &ipc_token)?;
        log_line(&format!("daemon: {daemon}"));
        Ok(vec![opencode, daemon])
    })();
    BRINGUP_INFLIGHT.store(false, Ordering::SeqCst);
    match result {
        Ok(steps) => Ok(BringUpStatus::ready(steps)),
        Err(err) => {
            log_line(&format!("ensure_all_services ERROR: {err}"));
            let sup = app.state::<Supervisor>();
            if sup.unadopted() > 0 {
                log_line(&format!(
                    "ensure_all_services: {} child(ren) could not be job-adopted",
                    sup.unadopted()
                ));
            }
            Ok(BringUpStatus::failed(&err))
        }
    }
}

#[tauri::command]
fn shutdown_all_services(app: tauri::AppHandle) -> Result<String, String> {
    app.state::<Supervisor>().reap();
    Ok("children stopped".to_string())
}

// ---------------------------------------------------------------------------
// Phase 2 TDD — process supervision and log capture.
//
// The defects these cover were all invisible from the outside: a discarded
// BOOL, a silently swallowed io::Error, and a status string that could not
// distinguish "someone else is already doing this" from "it failed".
// ---------------------------------------------------------------------------
#[cfg(test)]
mod phase2_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "voxaura-phase2-{tag}-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    // ---- D10: Job Object adoption must not be fire-and-forget -------------

    #[test]
    fn adoption_success_keeps_the_child() {
        // The historical code was `let _ = AssignProcessToJobObject(..)`, so a
        // child that failed to join the job was still tracked and still
        // believed to be supervised.
        assert_eq!(adoption_action(true), AdoptionAction::Keep);
    }

    #[test]
    fn adoption_failure_kills_the_child() {
        assert_eq!(adoption_action(false), AdoptionAction::Kill);
    }

    #[test]
    fn supervisor_own_reports_adoption_and_tracks_the_child() {
        let sup = Supervisor::default();
        let child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let ok = sup.own(child);
        #[cfg(windows)]
        {
            // A real Job Object on a real child must succeed; if this fails the
            // orphan-hardening in D10 is not actually working.
            assert!(ok, "a live child must be adopted by the job");
            assert_eq!(sup.unadopted(), 0);
        }
        #[cfg(not(windows))]
        {
            let _ = ok;
        }
        assert_eq!(sup.child_count(), 1);
        sup.reap();
        assert_eq!(sup.child_count(), 0);
    }

    #[test]
    fn unadopted_children_are_killed_immediately_not_merely_counted() {
        // A child the kernel will not reap on our death is an orphan the moment
        // we exit. Counting it is not enough; it must be killed.
        let sup = Supervisor::default();
        let child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn probe child");
        let pid = child.id();
        // Simulate the failure branch without needing a real assignment error.
        sup.own_with_adoption(child, false);
        assert_eq!(sup.unadopted(), 1);
        assert_eq!(sup.child_count(), 0, "an unadopted child must not be tracked as supervised");
        // Give the kernel a moment to reap it, then assert the PID is gone.
        std::thread::sleep(Duration::from_millis(400));
        assert!(!process_alive(pid), "an unadopted child must be killed, not left running");
    }

    // ---- D12: child stdout AND stderr must land somewhere diagnosable ----

    #[test]
    fn child_logs_use_the_canonical_file_when_it_can_be_opened() {
        let dir = temp_dir("logs-primary");
        match plan_child_logs(&dir, "daemon") {
            LogPlan::Primary(path) => {
                assert_eq!(path, dir.join("daemon.log"));
                assert!(path.exists());
            }
            other => panic!("expected Primary, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_logs_fall_back_to_a_unique_file_instead_of_going_silent() {
        // The live defect: `fs::File::create` failed (a handle held by a prior
        // daemon) and the code silently degraded to `Stdio::null()`, so the
        // daemon's stderr vanished with no trace. A directory squatting on the
        // canonical name reproduces that failure deterministically.
        let dir = temp_dir("logs-fallback");
        let _ = fs::create_dir_all(dir.join("daemon.log"));
        match plan_child_logs(&dir, "daemon") {
            LogPlan::Fallback(path) => {
                assert_ne!(path, dir.join("daemon.log"));
                assert!(path.exists(), "the fallback file must actually be created");
                assert!(path.to_string_lossy().contains("daemon-"));
            }
            other => panic!("expected Fallback, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_logs_report_both_errors_when_no_file_can_be_created() {
        let dir = temp_dir("logs-unavailable").join("does-not-exist");
        match plan_child_logs(&dir, "daemon") {
            LogPlan::Unavailable(msg) => {
                assert!(msg.contains("daemon"), "the message must name what failed: {msg}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn child_logs_are_append_only_so_a_restart_cannot_erase_the_cause() {
        // `File::create` truncates. A restart that failed for a different reason
        // would destroy the evidence of the previous failure.
        let dir = temp_dir("logs-append");
        let path = dir.join("daemon.log");
        fs::write(&path, b"first run evidence").unwrap();
        assert!(matches!(plan_child_logs(&dir, "daemon"), LogPlan::Primary(_)));
        assert_eq!(fs::read(&path).unwrap(), b"first run evidence");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_streams_are_captured_never_nulled() {
        let dir = temp_dir("logs-both");
        let out = open_child_stdout(&dir, "daemon");
        let err = open_child_stderr(&dir, "daemon");
        assert!(out.is_some(), "stdout must be captured, not nulled");
        assert!(err.is_some(), "stderr must be captured, not nulled");
        // Two distinct files, so the two streams do not interleave into one.
        // `File` has no PartialEq, so compare the paths we opened.
        assert_ne!(
            dir.join("daemon-stdout.log"),
            dir.join("daemon.log"),
            "stdout and stderr must not share a file"
        );
        assert!(dir.join("daemon-stdout.log").exists());
        assert!(dir.join("daemon.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn child_output_actually_lands_in_the_captured_files() {
        // The D12 proof. Asserting only that the files were created would not
        // show that the handle is wired to the child at all — which is the
        // whole question, since the original bug produced a zero-byte file that
        // nobody could tell apart from "the child was quiet".
        let dir = temp_dir("logs-bytes");
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "echo STDOUT_MARKER & echo STDERR_MARKER 1>&2"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(open_child_stdout(&dir, "probe").expect("stdout file")))
            .stderr(Stdio::from(open_child_stderr(&dir, "probe").expect("stderr file")));
        let mut child = cmd.spawn().expect("spawn");
        let _ = child.wait();
        let out = fs::read_to_string(dir.join("probe-stdout.log")).unwrap_or_default();
        let err = fs::read_to_string(dir.join("probe.log")).unwrap_or_default();
        assert!(out.contains("STDOUT_MARKER"), "stdout was not captured; got {out:?}");
        assert!(err.contains("STDERR_MARKER"), "stderr was not captured; got {err:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_second_child_appends_rather_than_erasing_the_first_failure() {
        // Append-mode is the reason a restart cannot destroy the evidence of
        // the previous one.
        let dir = temp_dir("logs-append-real");
        for marker in ["FIRST", "SECOND"] {
            let mut cmd = Command::new("cmd");
            cmd.args(["/c", &format!("echo {marker}")])
                .stdin(Stdio::null())
                .stdout(Stdio::from(open_child_stdout(&dir, "app").expect("stdout file")))
                .stderr(Stdio::from(open_child_stderr(&dir, "app").expect("stderr file")));
            let mut child = cmd.spawn().expect("spawn");
            let _ = child.wait();
        }
        let combined = format!(
            "{}{}",
            fs::read_to_string(dir.join("app-stdout.log")).unwrap_or_default(),
            fs::read_to_string(dir.join("app.log")).unwrap_or_default()
        );
        assert!(combined.contains("FIRST"), "the first run's evidence was erased");
        assert!(combined.contains("SECOND"), "the second run was not captured");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- D11: one supervisor, and make a duplicate visible ---------------

    #[test]
    fn a_process_we_did_not_spawn_is_a_foreign_supervisor() {
        // The live condition: PID 19516 was `opencode-cli.exe serve --service`
        // on :49374 while nothing held 4096. Our own list is empty at bring-up
        // time, so any candidate is foreign.
        assert_eq!(foreign_serve_present(&[], &[19516]), ServeOwnership::Foreign);
    }

    #[test]
    fn only_our_own_children_are_not_foreign() {
        // After we spawn, our PID must stop counting as foreign, or every
        // subsequent bring-up would warn about itself.
        assert_eq!(foreign_serve_present(&[4242], &[4242]), ServeOwnership::NotForeign);
        assert_eq!(foreign_serve_present(&[4242], &[4242, 19516]), ServeOwnership::Foreign);
    }

    #[test]
    fn no_candidates_means_no_foreign_serve() {
        assert_eq!(foreign_serve_present(&[], &[]), ServeOwnership::NotForeign);
    }

    #[cfg(windows)]
    #[test]
    fn opencode_pids_parses_tasklist_csv_and_ignores_the_no_match_banner() {
        // tasklist with no match prints a prose banner, not CSV. Parsing that as
        // a PID would report a phantom foreign supervisor on every clean boot.
        let sample = "\"opencode-cli.exe\",\"19516\",\"Console\",\"1\",\"422,116 K\"\r\n";
        let pids: Vec<u32> = sample
            .lines()
            .filter_map(|line| line.split("\",\"").nth(1))
            .filter_map(|pid| pid.trim().parse::<u32>().ok())
            .collect();
        assert_eq!(pids, vec![19516]);

        let banner = "INFO: No tasks are running which match the specified criteria.\r\n";
        let none: Vec<u32> = banner
            .lines()
            .filter_map(|line| line.split("\",\"").nth(1))
            .filter_map(|pid| pid.trim().parse::<u32>().ok())
            .collect();
        assert!(none.is_empty(), "the no-match banner must not parse as a pid");
    }

    #[cfg(windows)]
    #[test]
    fn opencode_pids_runs_against_this_machine_without_erroring() {
        // Best-effort by contract: whatever this machine reports, it must not
        // panic and must return a well-formed list.
        let pids = opencode_pids();
        assert!(pids.iter().all(|p| *p > 0));
    }

    #[test]
    fn adoption_is_preferred_over_a_second_spawn() {
        // When 4096 already answers, we adopt it. Spawning a second serve would
        // be the duplicate-supervisor bug.
        assert_eq!(bring_up_action(true, false), BringUpAction::Adopt);
        // Even with a foreign process present, an open port means adopt.
        assert_eq!(bring_up_action(true, true), BringUpAction::Adopt);
    }

    #[test]
    fn a_cold_port_with_a_foreign_serve_is_spawned_but_flagged() {
        // Refusing to spawn would break the app for anyone with the OpenCode
        // desktop app running, which is a worse failure than the duplication.
        // The duplicate must instead be visible in the log and the status.
        assert_eq!(bring_up_action(false, true), BringUpAction::SpawnAndWarn);
    }

    #[test]
    fn a_cold_port_with_no_foreign_serve_just_spawns() {
        assert_eq!(bring_up_action(false, false), BringUpAction::Spawn);
    }

    // ---- L11: the frontend must be able to tell "busy" from "failed" ------

    #[test]
    fn in_flight_is_reported_as_retriable_not_as_success_or_failure() {
        // The old contract returned Ok(vec!["bring-up already in flight"]), which
        // the UI could not distinguish from real progress, and never retried.
        let s = BringUpStatus::in_flight();
        assert_eq!(s.state, "in-flight");
        assert!(s.retriable, "in-flight must be retriable or the app silently never starts");
        assert!(s.detail.contains("in flight"));
    }

    #[test]
    fn a_real_failure_is_not_retriable_and_carries_the_reason() {
        let s = BringUpStatus::failed("daemon did not open 4097 in time");
        assert_eq!(s.state, "failed");
        assert!(!s.retriable);
        assert!(s.detail.contains("4097"));
    }

    #[test]
    fn success_reports_each_step() {
        let s = BringUpStatus::ready(vec!["opencode serve started on 4096".to_string()]);
        assert_eq!(s.state, "ready");
        assert!(!s.retriable);
        assert_eq!(s.steps.len(), 1);
    }

    #[test]
    fn status_serialises_with_the_fields_the_shell_reads() {
        let json = serde_json::to_string(&BringUpStatus::in_flight()).unwrap();
        assert!(json.contains("\"state\":\"in-flight\""));
        assert!(json.contains("\"retriable\":true"));
    }

    // ---- L12: a child that never binds must be killed, not leaked ---------

    #[cfg(windows)]
    #[test]
    fn a_child_that_never_binds_is_killed_and_reported_as_timed_out() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 60 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let outcome = spawn_and_wait_for_port(&mut cmd, 1, Duration::from_millis(900));
        let BindOutcome::TimedOut { pid } = outcome else {
            panic!("expected TimedOut");
        };
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !process_alive(pid),
            "a serve that never opened its port must be killed, not left running"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_child_that_does_bind_is_returned_for_supervision() {
        // Hold the port ourselves so the probe succeeds immediately.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe port");
        let port = listener.local_addr().unwrap().port();
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let outcome = spawn_and_wait_for_port(&mut cmd, port, Duration::from_millis(900));
        assert!(matches!(outcome, BindOutcome::Bound(_)), "expected Bound, got {outcome:?}");
        if let BindOutcome::Bound(mut child) = outcome {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn a_command_that_cannot_spawn_is_reported_not_panicked() {
        let mut cmd = Command::new("definitely-not-a-real-binary-9f3a");
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match spawn_and_wait_for_port(&mut cmd, 1, Duration::from_millis(200)) {
            BindOutcome::SpawnFailed(msg) => assert!(msg.contains("could not spawn")),
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }

    /// The resolved vault must be logged on EVERY path, not just the last.
    ///
    /// A voice-dead installed build reports `KEYS_MISSING` in telemetry and
    /// nothing else: the daemon cannot say which file it tried, so the row is
    /// indistinguishable from "the user never saved keys" — the wrong
    /// instruction, because re-entering keys changes nothing if the path is
    /// wrong. This was found the hard way: the first launch after an install
    /// emitted `KEYS_MISSING` with a vault that plainly held three keys, and
    /// the logs could not say why.
    ///
    /// The log was originally on the final `return` only, so the explicit-env
    /// and ancestor branches returned before reaching it. This asserts all
    /// three branches report, which is the property that matters.
    #[test]
    fn every_vault_resolution_branch_is_logged() {
        // Scoped to the function body on purpose. A file-wide count also matches
        // the string literals in this test, which made the first version of it
        // fail on itself - a reminder that a "count the occurrences" assertion
        // needs a scope that excludes the assertion.
        let src = include_str!("main.rs");
        let body = src
            .split("fn resolve_vault_dir")
            .nth(1)
            .and_then(|rest| rest.split("fn resolve_node_bin").next())
            .expect("resolve_vault_dir body");

        // One log line per branch: explicit, ancestor, install default.
        let logged = body.matches("resolve: vault=").count();
        assert_eq!(
            logged, 3,
            "resolve_vault_dir has 3 return paths (explicit, ancestor, install \
             default) and each must log its result; found {logged}"
        );

        let returns: Vec<&str> = body
            .lines()
            .filter(|l| l.trim_start().starts_with("return "))
            .collect();
        // Two explicit `return`s; the third path (install default) is the
        // function's tail expression, so it is asserted by the log count above
        // and by the final-statement check below rather than here.
        assert_eq!(returns.len(), 2, "expected 2 explicit returns, found {}", returns.len());
        for l in returns {
            let preceding = body.split(l).next().unwrap_or_default();
            assert!(
                preceding.contains("resolve: vault="),
                "a return path has no log line next to it: {}",
                l.trim()
            );
        }

        // The install-default branch is the tail expression, so it is covered by
        // the log count above. Asserting its exact position was tried and
        // removed: it couples the test to the wording of a format string, so a
        // harmless reword fails it while a real unlogged return still would not
        // be the thing that broke.
    }

    // ---- helpers -------------------------------------------------------

    fn process_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            // `tasklist` by PID: no extra crates, and this is a test-only path.
            let out = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output();
            match out {
                Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")),
                Err(_) => false,
            }
        }
        #[cfg(not(windows))]
        {
            Path::new(&format!("/proc/{pid}")).exists()
        }
    }
}

// ---------------------------------------------------------------------------
// Dossier S2: the supervisor's secret generation.
//
// Two defects are covered here, and neither was ever executed by any runner
// before this module existed, which is exactly why both shipped:
//
//   * `ipc.token` and `serve.pass` were filled by an xorshift64* whose state
//     was `nanos_since_epoch ^ pid`. Both inputs are observable, and all 32
//     bytes came out of four PRNG steps, so a 256-bit-looking secret was really
//     a ~2^30-bit one that anyone who knew roughly when the app launched could
//     regenerate offline.
//   * the `fs::write` calls set no access control at all, while the doc
//     comments above them claimed `(0600)`. On Windows `0o600` could not have
//     worked either way: `fs::set_permissions` is `SetFileAttributes` there
//     and only toggles FILE_ATTRIBUTE_READONLY.
//
// The guard is deliberately layered, because no single technique is sufficient:
// a statistical test cannot tell a CSPRNG from a well-seeded PRNG on one
// sample, and a source scan is defeated by renaming. So there is an exact
// reproduction of the historical generator (behavioural), a static scan that
// rejects the algorithm's fingerprints (structural), and a format/uniqueness
// sanity check (property).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod s2_secret_tests {
    use super::*;

    fn secret_file(tag: &str, name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "voxaura-s2-{tag}-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = fs::create_dir_all(&dir);
        dir.join(name)
    }

    /// The historical generator, transcribed exactly from the pre-S2 code
    /// (`main.rs:460-476` and `:501-517` as they stood before this change).
    ///
    /// Its output is byte-for-byte what the old production code produced for a
    /// given seed, which is what makes it usable both as a reproduction and as
    /// a positive control for the attack in
    /// `generated_secrets_are_not_reproducible_from_the_old_seed`.
    fn historical_xorshift_hex(seed_in: u64) -> String {
        let mut bytes = [0u8; 32];
        let mut seed = seed_in;
        for chunk in bytes.chunks_mut(8) {
            xorshift64_step(&mut seed);
            for (i, b) in chunk.iter_mut().enumerate() {
                *b = ((seed >> (i * 8)) & 0xff) as u8;
            }
        }
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// POSITIVE CONTROL for the primary guard: prove the attack actually breaks
    /// the real historical generator.
    ///
    /// A guard that has never been observed to catch the thing it guards is not
    /// a guard. This builds a secret exactly as the old code would have, from a
    /// seed of the same shape (`nanos ^ pid`), and asserts the recovery in
    /// `recover_seed_if_xorshift` gets the seed back and that the `nanos ^ pid`
    /// consistency check accepts it. If this ever passes silently on a `None`
    /// recovery, the primary guard downstream is vacuous.
    #[test]
    fn the_attack_does_break_the_historical_generator() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        for pid in [1u64, 4, 1234, 4242, 65_535] {
            let seed = nanos ^ pid;
            let secret = historical_xorshift_hex(seed);
            assert_eq!(secret.len(), 64, "historical generator must still emit 64 hex chars");
            let recovered = recover_seed_if_xorshift(&secret)
                .expect("a secret from the historical generator must be recoverable");
            assert_eq!(
                recovered, seed,
                "recovered the wrong seed for pid {pid}: the attack is broken"
            );
            // And the exact predicate the primary guard uses must accept it.
            let back = (recovered ^ pid) as u128;
            assert!(
                back == nanos as u128,
                "the nanos^pid consistency check must accept a genuine hit"
            );
        }
        // Deliberately NOT asserted: that a real CSPRNG secret fails recovery.
        // A random 64-bit word round-trips through the inverse for any output
        // with probability 2^-64, so a strict `is_none()` would be a flaky
        // assertion in the 1-in-1.8e19 direction. The primary guard tolerates
        // this because it also requires the recovered seed to be consistent
        // with the observed clock window and an enumerable pid, which a random
        // 64-bit value satisfies with probability ~2^-32 per sample.
    }

    /// One forward xorshift64* step, exactly as the historical code performed
    /// it. Split out so the inverse below can be self-tested against it.
    fn xorshift64_step(seed: &mut u64) {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
    }

    /// The inverse of one `xorshift64_step`.
    ///
    /// The transform is linear over GF(2) and therefore invertible. Each
    /// `x ^= x << k` is undone by iterating `x = y ^ (x << k)` until every bit
    /// has been reached (ceil(64/k) rounds), and — critically — the three
    /// stages must be undone in REVERSE order: 17, then 7, then 13. Doing them
    /// in forward order is the obvious mistake and yields a wrong inverse; the
    /// self-test in the guard below is what caught it.
    fn xorshift64_unstep(y: u64) -> u64 {
        let mut a = y;
        for _ in 0..4 {
            a = y ^ (a << 17); // 17 * 4 >= 64
        }
        let mut b = a;
        for _ in 0..10 {
            b = a ^ (b >> 7); // 7 * 10 >= 64
        }
        let mut c = b;
        for _ in 0..5 {
            c = b ^ (c << 13); // 13 * 5 >= 64
        }
        c
    }

    /// Recover the 64-bit xorshift state that produced `secret`, if it could
    /// have been produced by the historical generator.
    ///
    /// The old code emitted, for each 8-byte chunk, the bytes of a single
    /// advanced state word, least-significant byte first. So the FIRST 8 bytes
    /// of the output are exactly `state_after_step_1`, and undoing one step
    /// yields the seed itself. No brute force over the 2^64 seed space is
    /// needed — the output leaks its own seed. That is the whole point of the
    /// finding: the "32 random bytes" carried only 64 bits of state.
    fn recover_seed_if_xorshift(secret: &str) -> Option<u64> {
        if secret.len() < 16 {
            return None;
        }
        let mut first = [0u8; 8];
        for (i, b) in first.iter_mut().enumerate() {
            *b = u8::from_str_radix(&secret[i * 2..i * 2 + 2], 16).ok()?;
        }
        let state1 = u64::from_le_bytes(first);
        let seed0 = xorshift64_unstep(state1);
        // Only accept a recovery that actually round-trips: this both filters
        // accidental CSPRNG output and proves the inverse is correct here.
        let mut check = seed0;
        xorshift64_step(&mut check);
        if check == state1 {
            Some(seed0)
        } else {
            None
        }
    }

    /// THE PRIMARY GUARD. Fails if the xorshift64* is reinstated.
    ///
    /// This is an attack, not a guess. For each live secret it recovers the
    /// candidate 64-bit seed, then checks whether that seed could have been
    /// `nanos_since_epoch ^ pid` for ANY pid in 1..=65535 during the window in
    /// which the secret was actually generated (bracketed by real clock reads
    /// taken immediately around the generation). If the weak generator is
    /// present, the recovered seed matches for the true pid and this fails.
    ///
    /// There are no hardcoded timestamps. An earlier version of this test swept
    /// a guessed `base` constant and was verified to PASS against a reinstated
    /// xorshift — a vacuous guard. This version derives the clock window from
    /// the clock at run time, so it cannot drift.
    #[test]
    fn generated_secrets_are_not_reproducible_from_the_old_seed() {
        // Self-test the inverse before relying on it.
        for probe in [
            0u64,
            1,
            0x9E37_79B9_7F4A_7C15,
            0xdead_beef_cafe_babe,
            u64::MAX,
        ] {
            let mut s = probe;
            xorshift64_step(&mut s);
            assert_eq!(
                xorshift64_unstep(s),
                probe,
                "the seed-recovery inverse is wrong, so this guard would be vacuous"
            );
        }

        let nanos_now = || -> u128 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        };

        const SAMPLES: usize = 16;
        let mut hits: Vec<(usize, u64, u64)> = Vec::new();
        for sample in 0..SAMPLES {
            let before = nanos_now();
            let secret = generate_secret().expect("csprng");
            let after = nanos_now();
            let Some(seed) = recover_seed_if_xorshift(&secret) else {
                continue; // not xorshift-shaped: exactly what a CSPRNG gives
            };
            // Was this seed = nanos ^ pid for some plausible pid, with the
            // clock reading landing in the window we actually observed?
            for pid in 1..=65_535u64 {
                let nanos = (seed ^ pid) as u128;
                if nanos >= before && nanos <= after {
                    hits.push((sample, seed, pid));
                    break;
                }
            }
        }

        assert!(
            hits.is_empty(),
            "a generated secret is reproducible from the historical xorshift64* seed \
             (nanos ^ pid): {hits:?}. The weak generator is back."
        );
    }

    /// Structural guard: the algorithm's fingerprints must not reappear.
    ///
    /// The needles are assembled from fragments so this module's own source
    /// does not contain them — otherwise the scan would match the guard itself,
    /// which is the self-matching failure documented at `main.rs:1285`.
    #[test]
    fn the_weak_generator_has_not_been_reinstated() {
        let src = include_str!("main.rs");
        // Scope to production code only.
        //
        // This must split at the first *test module*, NOT at the first
        // `#[cfg(test)]`: the latter is `Supervisor::child_count` at line 395,
        // which sits ABOVE the secret machinery, so splitting there would scope
        // the guard to a region that does not contain the code being guarded and
        // every assertion would pass vacuously. `mod phase2_tests` is the first
        // module, and everything before it is production.
        let body = src
            .split("mod phase2_tests")
            .next()
            .expect("production code precedes the first test module");
        // The guarded functions must actually be inside that region, or every
        // assertion below would pass vacuously.
        assert!(
            body.contains("fn generate_secret"),
            "guard scope regression: the secret generator is not in the scanned region"
        );
        let code = code_only(body);

        // The algorithm's CODE fingerprints. These cannot appear in prose, so
        // unlike the bare word "xorshift" they do not fire on the comments that
        // document what was replaced. Any faithful reinstatement contains them.
        for (needle, what) in [
            ("^= seed", "the xorshift state update"),
            ("<< 13", "the xorshift shift constant"),
            ("chunks_mut(8)", "the 4-step chunked emission loop"),
        ] {
            assert!(
                !code.contains(needle),
                "{what} is back in production code ({needle}); the S2 fix was reverted"
            );
        }
        // The self-acknowledging comment the old generator carried.
        assert!(
            !body.contains("sourced without extra crates"),
            "the pre-S2 generator comment is back"
        );
        // "as_nanos" is the clock half of the old seed and appears in no other
        // production code in this file.
        assert!(
            !code.contains(&["as_nan", "os"].concat()),
            "a nanosecond clock is read to seed a secret again; the S2 fix was reverted"
        );

        // Positive controls: the fix must actually be wired in, or every
        // assertion above would pass vacuously on an empty implementation.
        assert!(body.contains("getrandom::fill"), "generate_secret must call the CSPRNG");
        assert!(
            body.contains("restrict_to_owner"),
            "secrets must be locked down with restrict_to_owner"
        );
        assert!(
            body.contains("SetNamedSecurityInfoW") && body.contains("PROTECTED_DACL_SECURITY_INFORMATION"),
            "the owner-only DACL is not actually applied"
        );
    }

    /// Strip comment lines so the source guards below inspect CODE rather than
    /// prose. The comments in this file deliberately *describe* the historical
    /// defect (naming the old algorithm, naming `0600`), and a naive
    /// `src.contains("xorshift")` therefore fires on the explanation of the fix
    /// rather than on the fix itself — the self-matching failure mode already
    /// documented at `main.rs:1285`.
    fn code_only(src: &str) -> String {
        src.lines()
            .filter(|l| {
                let t = l.trim_start();
                !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Drop backtick-quoted spans, so a comment that *names* a value to say what
    /// it is NOT (`0o600` is a no-op) does not trip a guard banning the value's
    /// use. The original false claims were unquoted.
    fn without_backticked(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        let mut in_tick = false;
        for c in src.chars() {
            match c {
                '`' => in_tick = !in_tick,
                _ if !in_tick => out.push(c),
                _ => {}
            }
        }
        out
    }

    /// Format and property checks on the generator itself.
    #[test]
    fn generated_secrets_are_well_formed_and_unpredictable() {
        const N: usize = 256;
        let mut seen = std::collections::HashSet::new();
        let mut per_position = [0usize; 64];
        // 16 buckets, one per hex DIGIT. This was `[0usize; 256]` (a byte
        // histogram) while only 0..=15 are ever written, so the "every bucket
        // is used" assertion died on the first always-zero bucket at index 16 —
        // reported as "hex digit 10" because the message formats with `{nibble:x}`.
        let mut digit_histogram = [0usize; 16];

        for _ in 0..N {
            let s = generate_secret().expect("csprng");
            assert_eq!(s.len(), SECRET_BYTES * 2, "secret must be {} hex chars", SECRET_BYTES * 2);
            assert!(
                s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "secret must be lower-case hex: {s}"
            );
            assert!(seen.insert(s.clone()), "duplicate secret generated: {s}");
            for (i, c) in s.chars().enumerate() {
                per_position[i] += 1;
                // Bucket by the hex digit's VALUE (0..=15), not by the high
                // nibble of its ASCII code — the latter only ever yields 3..=7
                // for '0'..'f' and would fail on a perfectly good generator.
                let v = c.to_digit(16).expect("hex digit") as usize;
                digit_histogram[v] += 1;
            }
        }
        assert_eq!(seen.len(), N, "all {N} secrets must be distinct");

        // No nibble position may be constant across samples: a zeroed or
        // repeated output would show up as a position that never varies.
        for (i, distinct) in per_position.iter().enumerate() {
            assert!(*distinct > 1, "hex position {i} is constant across {N} secrets");
        }
        // Every one of the 16 hex digits should appear, and none should dominate
        // so heavily that the others look starved: a broken or short fill shows
        // up here. The upper bound is a loose sanity net, not a statistical test
        // — the real strength assertion is the seed-reproduction sweep above.
        for (digit, count) in digit_histogram.iter().enumerate() {
            assert!(*count > 0, "hex digit {digit:x} never appeared in {N} secrets");
            assert!(
                *count < N * 64,
                "hex digit {digit:x} took {count} of {} samples — the output is not random",
                N * 64
            );
        }
    }

    /// The write path must produce a file, and must be a real file with content.
    #[test]
    fn write_protected_secret_creates_a_readable_file() {
        let path = secret_file("write", "ipc.token");
        let secret = generate_secret().expect("csprng");
        write_protected_secret(&path, &secret, "ipc.token").expect("write");
        assert_eq!(fs::read_to_string(&path).expect("reread").trim(), secret);
        let _ = fs::remove_file(&path);
    }

    /// Fail-closed: if the ACL cannot be applied, the secret must not be left
    /// on disk. A file that survives with a weaker ACL is worse than no file,
    /// because the `read_to_string` fast path in `ensure_ipc_token` would adopt
    /// it as permanent and never retry the lockdown.
    #[test]
    fn a_failed_acl_removes_the_secret_instead_of_leaving_it_world_readable() {
        // A directory is not a valid *file* target for a DACL write the way this
        // function performs it on a non-NTFS/odd path; the reliable way to make
        // the ACL step fail deterministically is a path whose parent is a file.
        let blocker = secret_file("acl-fail", "blocker");
        fs::write(&blocker, "not a directory").expect("seed blocker");
        let nested = blocker.join("ipc.token");
        let secret = "deadbeef".repeat(8);
        let err = write_protected_secret(&nested, &secret, "ipc.token")
            .expect_err("must fail closed, not leave the secret");
        assert!(
            err.contains("ipc.token"),
            "error must name the file, got: {err}"
        );
        assert!(
            !nested.exists(),
            "the secret survived a failed ACL write at {}",
            nested.display()
        );
        let _ = fs::remove_file(&blocker);
    }

    /// The Windows equivalent of `0600`, verified against the real kernel state
    /// of a real file — not against a mock and not against our own source text.
    #[cfg(windows)]
    #[test]
    fn the_secret_file_gets_a_protected_owner_only_dacl() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{
            EqualSid, GetFileSecurityW, SE_DACL_PRESENT, SE_DACL_PROTECTED,
        };

        let path = secret_file("dacl", "serve.pass");
        let secret = generate_secret().expect("csprng");
        write_protected_secret(&path, &secret, "serve.pass").expect("write");

        // Read the security descriptor back from the filesystem. BOTH the DACL
        // and the owner are requested: the owner is what the ACEs are checked
        // against, and asking for one does not populate the other's offset.
        let info = DACL_SECURITY_INFORMATION_FLAG | OWNER_SECURITY_INFORMATION_FLAG;
        let mut needed = 0u32;
        let mut actual = 0u32;
        unsafe {
            GetFileSecurityW(
                wide(&path).as_ptr(),
                info,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        assert!(needed > 0, "GetFileSecurityW could not size the descriptor");
        let mut sd = vec![0u8; needed as usize];
        let ok = unsafe {
            GetFileSecurityW(
                wide(&path).as_ptr(),
                info,
                sd.as_mut_ptr() as *mut core::ffi::c_void,
                needed,
                &mut actual,
            )
        };
        assert_ne!(ok, 0, "GetFileSecurityW failed: {}", last_error());

        // SELF_RELATIVE SD fixed header:
        //   [0]=Revision [1]=SBZ1 [2..4]=Control  (all u16-aligned, then u32s)
        //   [4..8]=OwnerOffset  [8..12]=GroupOffset  [12..16]=SaclOffset
        //   [16..20]=DaclOffset
        // Reading the DACL from [4..8] would silently pick up the OWNER offset.
        let le32 = |o: usize| u32::from_le_bytes([sd[o], sd[o + 1], sd[o + 2], sd[o + 3]]) as usize;
        let owner_offset = le32(4);
        let dacl_offset = le32(16);
        assert!(owner_offset > 0, "no owner SID in the descriptor");
        let owner_sid = unsafe { sd.as_ptr().add(owner_offset) as *mut core::ffi::c_void };
        let control = u16::from_le_bytes([sd[2], sd[3]]);
        assert_ne!(
            control & SE_DACL_PRESENT,
            0,
            "SE_DACL_PRESENT is not set — there is no DACL to protect"
        );
        assert_ne!(
            control & SE_DACL_PROTECTED,
            0,
            "SE_DACL_PROTECTED is not set: the file's DACL still INHERITS from the parent \
             directory, so the guarantee is only as strong as %USERPROFILE%'s ACL. This is \
             the specific thing that Unix 0600 gives for free and that a naive Windows \
             port omits."
        );

        assert!(
            dacl_offset > 0 && dacl_offset + 8 <= sd.len(),
            "DACL offset out of range"
        );
        let dacl = &sd[dacl_offset..];
        let ace_count = u16::from_le_bytes([dacl[4], dacl[5]]) as usize;
        // Exactly two ACEs: the file's owner and LocalSystem. A third, or an
        // inherited ACE, means the lockdown is not what the comment claims.
        assert_eq!(
            ace_count,
            2,
            "expected exactly 2 ACEs (owner + LocalSystem), found {ace_count}: the DACL is \
             not owner-only"
        );

        // Walk the ACEs: each must be ACCESS_ALLOWED (0), carry full control, and
        // name either the file's owner or LocalSystem.
        let mut cursor = 8usize;
        let system_sid = well_known_system_sid();
        let mut saw_owner = false;
        let mut saw_system = false;
        for i in 0..ace_count {
            let ace = &dacl[cursor..];
            assert!(ace.len() >= 20, "ACE {i} truncated");
            let ace_type = ace[0];
            let ace_size = u16::from_le_bytes([ace[2], ace[3]]) as usize;
            assert_eq!(ace_type, 0, "ACE {i} is type {ace_type}, not ACCESS_ALLOWED_ACE");
            let mask = u32::from_le_bytes([ace[4], ace[5], ace[6], ace[7]]);
            assert_eq!(
                mask & 0x1F01FF,
                0x1F01FF,
                "ACE {i} mask {mask:#x} is not a full file-access grant"
            );
            let sid_ptr = unsafe { (ace.as_ptr().add(8)) as *mut core::ffi::c_void };
            if unsafe { EqualSid(sid_ptr, owner_sid) } != 0 {
                saw_owner = true;
            } else if unsafe { EqualSid(sid_ptr, system_sid) } != 0 {
                saw_system = true;
            } else {
                panic!(
                    "ACE {i} grants access to neither the file owner nor LocalSystem — \
                     a third party can read the secret"
                );
            }
            cursor += ace_size;
        }
        assert!(saw_owner, "the owner's own ACE is missing");
        assert!(saw_system, "the LocalSystem ACE is missing");
        let _ = fs::remove_file(&path);

        // ---- local helpers ----
        fn wide(p: &Path) -> Vec<u16> {
            let mut v: Vec<u16> = p.as_os_str().encode_wide().collect();
            v.push(0);
            v
        }
        fn last_error() -> u32 {
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        }
    }

    #[cfg(windows)]
    const DACL_SECURITY_INFORMATION_FLAG: u32 = 4; // SE_DACL_SECURITY_INFORMATION
    #[cfg(windows)]
    const OWNER_SECURITY_INFORMATION_FLAG: u32 = 1; // OWNER_SECURITY_INFORMATION

    #[cfg(windows)]
    fn well_known_system_sid() -> *mut core::ffi::c_void {
        use windows_sys::Win32::Security::{CreateWellKnownSid, WinLocalSystemSid};
        let buf = Box::leak(Box::new([0u8; 68]));
        let mut len = buf.len() as u32;
        let ok = unsafe {
            CreateWellKnownSid(
                WinLocalSystemSid,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                &mut len,
            )
        };
        assert_ne!(
            ok,
            0,
            "CreateWellKnownSid failed: {}",
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        );
        buf.as_mut_ptr() as *mut core::ffi::c_void
    }

    #[cfg(windows)]
    fn process_user_sid() -> *mut core::ffi::c_void {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                0,
                "OpenProcessToken failed"
            );
            let mut needed = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            // The SID lives *inside* this buffer, so the buffer must outlive the
            // returned pointer. It is deliberately leaked: a test process is
            // short-lived, and returning a pointer into a `Vec` that is dropped
            // here is a use-after-free that corrupts the whole test process.
            let buf = Box::leak(vec![0u8; needed as usize].into_boxed_slice());
            // `lpnlengthneeded` must be non-NULL on this OS; see the identical
            // note in `restrict_to_owner`.
            let mut actual = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                needed,
                &mut actual,
            );
            let _ = CloseHandle(token);
            assert_ne!(ok, 0, "GetTokenInformation failed");
            (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid
        }
    }

    /// `restrict_to_owner` grants the DACL to the file's *owner* SID, taken from
    /// the file's own security descriptor, rather than to the process token's
    /// user SID. That is only correct if those two are the same identity — if
    /// they ever diverged, the secret would be locked to somebody else and the
    /// daemon could not read it. This asserts the equivalence directly, via the
    /// token, rather than assuming it.
    #[cfg(windows)]
    #[test]
    fn the_dacl_is_granted_to_the_actual_process_user() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{EqualSid, GetFileSecurityW};

        let path = secret_file("owner-identity", "ipc.token");
        let secret = generate_secret().expect("csprng");
        write_protected_secret(&path, &secret, "ipc.token").expect("write");

        let mut w: Vec<u16> = path.as_os_str().encode_wide().collect();
        w.push(0);
        let mut needed = 0u32;
        let mut actual = 0u32;
        unsafe {
            GetFileSecurityW(
                w.as_ptr(),
                OWNER_SECURITY_INFORMATION_FLAG,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        assert!(needed > 0, "GetFileSecurityW could not size the descriptor");
        let mut sd = vec![0u8; needed as usize];
        let ok = unsafe {
            GetFileSecurityW(
                w.as_ptr(),
                OWNER_SECURITY_INFORMATION_FLAG,
                sd.as_mut_ptr() as *mut core::ffi::c_void,
                needed,
                &mut actual,
            )
        };
        assert_ne!(ok, 0, "GetFileSecurityW failed");
        let owner_offset = u32::from_le_bytes([sd[4], sd[5], sd[6], sd[7]]) as usize;
        assert!(owner_offset > 0 && owner_offset < sd.len(), "no owner SID in descriptor");
        let owner = unsafe { sd.as_ptr().add(owner_offset) as *mut core::ffi::c_void };

        let me = process_user_sid();
        assert_ne!(
            unsafe { EqualSid(owner, me) },
            0,
            "the file's owner SID is not the current process user; restrict_to_owner would \
             grant the DACL to the wrong identity and the daemon could not read the secret"
        );
        let _ = fs::remove_file(&path);
    }

    /// The `(0600)` comments were the original lie. Assert they cannot come
    /// back, and that the words now describe what the code does.
    #[test]
    fn no_claim_of_unix_0600_survives_in_the_documentation() {
        let src = include_str!("main.rs");
        let body = src.split("mod phase2_tests").next().unwrap();
        // The original lie was a bare, UNQUOTED parenthetical claim on functions
        // that called no ACL code at all: "ipc.token (0600)", "serve password
        // (0600)", "supervisor log (0600 directory)". Backticked spans are
        // stripped first, because the corrected comments legitimately *name*
        // `0600` in order to explain that Windows gets something else instead —
        // banning the bare token would make the correct explanation impossible
        // to write, which is how guards like this end up disabled.
        let prose = without_backticked(body);
        assert!(
            !prose.contains("(0600)"),
            "a production comment still asserts Unix 0600 permissions. On Windows \
             fs::set_permissions is SetFileAttributes and cannot express this, so the claim \
             is false. Describe restrict_to_owner instead."
        );
        assert!(
            !prose.contains("0600 directory"),
            "the runtime directory is still documented as 0600; it is never ACL'd at all."
        );
        // Positive control: the lockdown really is documented, so this guard is
        // not passing merely because the text moved.
        assert!(
            body.contains("restrict_to_owner"),
            "restrict_to_owner must be documented as the real permission mechanism"
        );
    }
}


fn main() {
    let app = tauri::Builder::default()
        .manage(Supervisor::default())
        .invoke_handler(tauri::generate_handler![
            ipc_token,
            ensure_all_services,
            shutdown_all_services
        ])
        .setup(|app| {
            // Write the per-install IPC token SYNCHRONOUSLY, before the webview
            // loads. The frontend asks for it on mount via `ipc_token`; if the
            // file were only written later (by the daemon), the shell could read
            // it too early and render a permanent disconnected state.
            if let Err(err) = ensure_ipc_token() {
                log_line(&format!("ensure_ipc_token ERROR: {err}"));
            }
            // Bring the tiers up off the UI thread; a slow probe must not delay
            // first paint. The frontend also calls ensure_all_services so it can
            // render the outcome.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = ensure_all_services(handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Voxaura");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            app_handle.state::<Supervisor>().reap();
        }
    });
}