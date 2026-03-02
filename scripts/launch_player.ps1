# launch_player.ps1
# Launches an application and forces it to foreground using Win32 API
# This bypasses Windows' foreground lock restriction

param(
    [Parameter(Mandatory)][string]$ExePath,
    [Parameter(Mandatory)][string]$FilePath
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinFocus {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    public static void ForceForeground(IntPtr targetHwnd) {
        const int SW_SHOW = 5;
        const byte VK_MENU = 0x12;
        const uint KEYEVENTF_KEYUP = 0x0002;

        IntPtr foregroundHwnd = GetForegroundWindow();
        if (foregroundHwnd == targetHwnd) return;

        uint foregroundPid, targetPid;
        uint foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out foregroundPid);
        uint targetThread = GetWindowThreadProcessId(targetHwnd, out targetPid);

        // Simulate Alt key press/release to bypass foreground lock
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

        if (foregroundThread != targetThread) {
            AttachThreadInput(targetThread, foregroundThread, true);
            SetForegroundWindow(targetHwnd);
            BringWindowToTop(targetHwnd);
            ShowWindow(targetHwnd, SW_SHOW);
            AttachThreadInput(targetThread, foregroundThread, false);
        } else {
            SetForegroundWindow(targetHwnd);
            BringWindowToTop(targetHwnd);
            ShowWindow(targetHwnd, SW_SHOW);
        }
    }
}
"@

# Set working directory to exe's folder
$workDir = Split-Path $ExePath -Parent

# Launch the player process
$proc = Start-Process -FilePath $ExePath -ArgumentList "`"$FilePath`"" -PassThru -WorkingDirectory $workDir

# Wait for window to appear (up to 5 seconds)
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 100
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        break
    }
}

# Force it to foreground
if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
    [WinFocus]::ForceForeground($proc.MainWindowHandle)
}
