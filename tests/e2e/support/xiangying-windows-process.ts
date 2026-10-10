import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const modernPowerShell = path.join(
  process.env.ProgramFiles || "C:/Program Files",
  "PowerShell/7/pwsh.exe",
);

export interface WindowsProcessIdentity {
  pid: number;
  creationFileTime: string;
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Windows process identity checks require Windows");
  }
}

async function runPowerShell(
  script: string,
  timeoutMs = 10_000,
): Promise<string> {
  const { stdout } = await execFileAsync(
    existsSync(modernPowerShell) ? modernPowerShell : "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
  );
  return stdout.trim();
}

const NATIVE_PROCESS_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;
public static class XiangyingOwnedProcess {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  private static long FileTimeValue(FILETIME value) { return ((long)value.High << 32) | value.Low; }
  private static IntPtr OpenAndVerify(int pid, long creationFileTime, bool terminate = false) {
    IntPtr process = OpenProcess(0x1000 | 0x00100000 | (terminate ? 0x0001u : 0u), false, pid);
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 87 || error == 1168) return IntPtr.Zero;
      throw new InvalidOperationException("OpenProcess failed: " + error);
    }
    FILETIME creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(process);
      throw new InvalidOperationException("GetProcessTimes failed: " + error);
    }
    if (FileTimeValue(creation) != creationFileTime) { CloseHandle(process); return IntPtr.Zero; }
    return process;
  }
  public static string Identity(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 87 || error == 1168) return "missing";
      throw new InvalidOperationException("OpenProcess for identity failed: " + error);
    }
    try {
      FILETIME creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
        throw new InvalidOperationException("GetProcessTimes failed: " + Marshal.GetLastWin32Error());
      return FileTimeValue(creation).ToString(System.Globalization.CultureInfo.InvariantCulture);
    } finally { CloseHandle(process); }
  }
  public static string Wait(int pid, long creationFileTime, uint milliseconds) {
    IntPtr process = OpenAndVerify(pid, creationFileTime);
    if (process == IntPtr.Zero) return "identity-gone";
    try {
      uint result = WaitForSingleObject(process, milliseconds);
      if (result == 0) return "exited";
      if (result == 258) return "timeout";
      throw new InvalidOperationException("WaitForSingleObject failed: " + Marshal.GetLastWin32Error());
    } finally { CloseHandle(process); }
  }
  public static string Terminate(int pid, long creationFileTime) {
    IntPtr process = OpenAndVerify(pid, creationFileTime, true);
    if (process == IntPtr.Zero) return "identity-gone";
    try {
      if (!TerminateProcess(process, 1)) throw new InvalidOperationException("TerminateProcess failed: " + Marshal.GetLastWin32Error());
      return "terminated";
    } finally { CloseHandle(process); }
  }
}`;

async function nativeProcessCall(
  method: "Identity" | "Wait" | "Terminate",
  pid: number,
  creationFileTime = "0",
  timeoutMs = 10_000,
): Promise<string> {
  assertWindows();
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Windows process PID is invalid");
  }
  if (method !== "Identity" && !/^\d{1,19}$/.test(creationFileTime)) {
    throw new Error("Owned Windows process identity is malformed");
  }
  const timeoutArgument = method === "Wait" ? `, [uint32]${timeoutMs}` : "";
  const methodArguments =
    method === "Identity"
      ? `${pid}`
      : `${pid}, [long]${creationFileTime}${timeoutArgument}`;
  const script = `$ErrorActionPreference = 'Stop'\n$source = @'\n${NATIVE_PROCESS_HELPER}\n'@\nAdd-Type -TypeDefinition $source\n$result = [XiangyingOwnedProcess]::${method}(${methodArguments})\n[Console]::Out.Write($result)`;
  // Cold PowerShell/C# startup is separate from the kernel's bounded wait.
  return runPowerShell(script, Math.max(timeoutMs + 10_000, 60_000));
}

export async function readWindowsProcessIdentity(
  pid: number,
): Promise<WindowsProcessIdentity | undefined> {
  const creationFileTime = await nativeProcessCall("Identity", pid);
  if (creationFileTime === "missing") return undefined;
  if (!/^\d{1,19}$/.test(creationFileTime)) {
    throw new Error("GetProcessTimes returned an invalid creation FILETIME");
  }
  return { pid, creationFileTime };
}

export async function waitForWindowsProcessExit(
  identity: WindowsProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const state = await nativeProcessCall(
    "Wait",
    identity.pid,
    identity.creationFileTime,
    timeoutMs,
  );
  if (state === "timeout") return false;
  if (state === "exited" || state === "identity-gone") return true;
  throw new Error(`Unexpected Windows process wait result: ${state}`);
}

export async function terminateOwnedWindowsProcess(
  identity: WindowsProcessIdentity,
): Promise<void> {
  const state = await nativeProcessCall(
    "Terminate",
    identity.pid,
    identity.creationFileTime,
  );
  if (state !== "terminated" && state !== "identity-gone") {
    throw new Error(`Unexpected Windows process termination result: ${state}`);
  }
}
