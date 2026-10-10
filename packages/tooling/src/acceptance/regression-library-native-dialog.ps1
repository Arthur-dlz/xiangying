param(
  [Parameter(Mandatory = $true)][ValidateSet('Describe', 'InspectTree', 'ChooseFile', 'ChooseFolder', 'Click', 'Observe')][string]$Action,
  [Parameter(Mandatory = $true)][int]$OwnerPid,
  [string]$Value,
  [string[]]$Names = @(),
  [string]$FileName
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Names = @($Names -split '\|')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if ($Action -ne 'Observe') {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class XiangyingOwnedDialogs {
  private delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr handle);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr handle);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder name, int capacity);
  [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int capacity);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, string lParam);
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] private static extern IntPtr ReadMessage(IntPtr handle, uint message, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  public static bool Choose(int mainPid, string target, bool folder) {
    foreach (var dialog in Find(mainPid)) {
      var input = GetDlgItem(dialog, 1148);
      var accept = GetDlgItem(dialog, 1);
      if (input == IntPtr.Zero || accept == IntPtr.Zero) continue;
      var caption = new StringBuilder(256);
      GetWindowText(accept, caption, caption.Capacity);
      string text = caption.ToString();
      bool supported = folder ? (text.Contains("选择") || text.Contains("Select") || text.Contains("确定") || text.Contains("OK")) : (text.Contains("打开") || text.Contains("Open"));
      if (!supported) continue;
      var editable = IntPtr.Zero;
      EnumChildWindows(input, (child, parameter) => {
        var childClass = new StringBuilder(256);
        GetClassName(child, childClass, childClass.Capacity);
        if (childClass.ToString() == "Edit") { editable = child; return false; }
        return true;
      }, IntPtr.Zero);
      if (editable != IntPtr.Zero) input = editable;
      Console.Error.WriteLine("NativeChoose stage=SET folder=" + folder);
      var sent = SendMessage(input, 12, IntPtr.Zero, target);
      Console.Error.WriteLine("NativeChoose stage=SET-complete");
      var setterError = Marshal.GetLastWin32Error();
      var actual = new StringBuilder(32768);
      Console.Error.WriteLine("NativeChoose stage=GET");
      ReadMessage(input, 13, new IntPtr(actual.Capacity), actual);
      Console.Error.WriteLine("NativeChoose stage=GET-complete");
      if (actual.ToString() != target) throw new InvalidOperationException("Native filename field did not accept the controlled target; setterError=" + setterError + "; sent=" + sent + "; childEdit=" + (editable != IntPtr.Zero));
      return PostMessage(accept, 245, IntPtr.Zero, IntPtr.Zero);
    }
    return false;
  }
  public static bool Click(int mainPid, string labels) {
    var expected = labels.Split('|');
    foreach (var dialog in Find(mainPid)) {
      bool clicked = false;
      EnumChildWindows(dialog, (child, parameter) => {
        var name = new StringBuilder(256);
        GetClassName(child, name, name.Capacity);
        if (name.ToString() != "Button") return true;
        var caption = new StringBuilder(1024);
        ReadMessage(child, 13, new IntPtr(caption.Capacity), caption);
        string text = caption.ToString().Replace("&", "");
        foreach (var label in expected) {
          if (text == label) { clicked = PostMessage(child, 245, IntPtr.Zero, IntPtr.Zero); return false; }
        }
        return true;
      }, IntPtr.Zero);
      if (clicked) return true;
    }
    return false;
  }
  public static int ControlId(IntPtr handle) { return GetDlgCtrlID(handle); }
  public static IntPtr ParentHandle(IntPtr handle) { return GetParent(handle); }
  public static int ProcessId(IntPtr handle) {
    uint pid;
    GetWindowThreadProcessId(handle, out pid);
    return (int)pid;
  }
  public static IntPtr[] Find(int mainPid) {
    var result = new List<IntPtr>();
    EnumWindows((handle, parameter) => {
      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      bool owned = pid == mainPid;
      var owner = GetWindow(handle, 4);
      for (int depth=0; !owned && owner != IntPtr.Zero && depth<8; depth++) {
        GetWindowThreadProcessId(owner, out pid);
        owned = pid == mainPid;
        owner = GetWindow(owner, 4);
      }
      if (owned) {
        var name = new StringBuilder(256);
        GetClassName(handle, name, name.Capacity);
        if (name.ToString() == "#32770") result.Add(handle);
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
"@
}
if ($Action -in @('ChooseFile', 'ChooseFolder')) {
  if (-not $Value) { throw 'A controlled target path is required' }
  if ([XiangyingOwnedDialogs]::Choose($OwnerPid, $Value, ($Action -eq 'ChooseFolder'))) {
    ConvertTo-Json -Compress @{ action = $Action; ownerPid = $OwnerPid; path = $Value; method = 'owned-native-control' }
    exit 0
  }
}
if ($Action -eq 'Click' -and $Names.Count -gt 0 -and [XiangyingOwnedDialogs]::Click($OwnerPid, ($Names -join '|'))) {
  ConvertTo-Json -Compress @{ action = $Action; ownerPid = $OwnerPid; method = 'owned-native-button' }
  exit 0
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$ownedWindows = @()
foreach ($candidate in $children) {
  if ($candidate.Current.ProcessId -eq $OwnerPid) {
    if ($candidate.Current.ClassName -eq '#32770') { $ownedWindows += $candidate }
    # Windows UI Automation can nest an owned modal dialog below its owner.
    $dialogCondition = [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnerPid),
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
    )
    foreach ($nestedDialog in $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, $dialogCondition)) { $ownedWindows += $nestedDialog }
  }
}
if ($Action -ne 'Observe') {

  foreach ($handle in [XiangyingOwnedDialogs]::Find($OwnerPid)) {
    $ownedWindows += [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  }
}
if ($ownedWindows.Count -eq 0 -and $Action -notin @('Observe', 'Describe')) { throw ("No owned native #32770 dialog for Electron PID $OwnerPid; owned root classes: " + (($children | Where-Object { $_.Current.ProcessId -eq $OwnerPid } | ForEach-Object { $_.Current.ClassName }) -join ', ')) }

$all = @()
foreach ($window in $ownedWindows) {
  $all += $window
  foreach ($dialogElement in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { $all += $dialogElement }
}
# Re-check each candidate so a hosted or unrelated process cannot receive input.
$rawDialogElements = @($all)
$allowedDialogPids = @($ownedWindows | ForEach-Object { $_.Current.ProcessId })
$all = @($all | Where-Object { $allowedDialogPids -contains $_.Current.ProcessId })

if ($Action -eq 'Describe' -and $ownedWindows.Count -eq 0) {
  $ownedRoots = @($children | Where-Object { $_.Current.ProcessId -eq $OwnerPid })
  $windowNodes = @()
  foreach ($ownedRoot in $ownedRoots) {
    $windowCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $windowNodes += $ownedRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $windowCondition)
  }
  ConvertTo-Json -InputObject @($windowNodes | ForEach-Object { @{ ClassName = $_.Current.ClassName; ProcessId = $_.Current.ProcessId } }) -Compress
  exit 0
}
if ($Action -eq 'Describe') {
  $result = foreach ($element in $rawDialogElements) {
    $name = $element.Current.Name
    if ($element.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::ComboBox) -or ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $name -match '打开|取消|选择|确定|Open|Cancel|Select|OK')) {
      [pscustomobject]@{
        Name = $name
        Type = $element.Current.ControlType.ProgrammaticName
        AutomationId = $element.Current.AutomationId
        ProcessId = $element.Current.ProcessId
        Enabled = $element.Current.IsEnabled
      }
    }
  }
  ConvertTo-Json -Depth 5 -InputObject @{ roots = @($ownedWindows | ForEach-Object { @{ ClassName = $_.Current.ClassName; ProcessId = $_.Current.ProcessId; Handle = $_.Current.NativeWindowHandle } }); controls = @($result) } -Compress
  exit 0
}
if ($Action -eq 'InspectTree') {
  $controls = foreach ($element in $all) {
    if ($element.Current.ProcessId -ne $OwnerPid) { continue }
    $nativeHandle = [IntPtr]$element.Current.NativeWindowHandle
    $parentChain = @()
    $cursor = $nativeHandle
    for ($depth = 0; $cursor -ne [IntPtr]::Zero -and $depth -lt 12; $depth++) {
      $processId = [XiangyingOwnedDialogs]::ProcessId($cursor)
      if ($processId -ne $OwnerPid) { break }
      $parentChain += [pscustomobject]@{
        Handle = $cursor.ToInt64()
        ControlId = [XiangyingOwnedDialogs]::ControlId($cursor)
      }
      $cursor = [XiangyingOwnedDialogs]::ParentHandle($cursor)
    }
    $controlName = $null
    if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
      $controlName = $element.Current.Name
    }
    [pscustomobject]@{
      ProcessId = $element.Current.ProcessId
      ControlType = $element.Current.ControlType.ProgrammaticName
      AutomationId = $element.Current.AutomationId
      ClassName = $element.Current.ClassName
      Enabled = $element.Current.IsEnabled
      Offscreen = $element.Current.IsOffscreen
      ButtonName = $controlName
      NativeWindowHandle = $element.Current.NativeWindowHandle
      Win32ControlId = if ($nativeHandle -ne [IntPtr]::Zero) {
        [XiangyingOwnedDialogs]::ControlId($nativeHandle)
      } else {
        $null
      }
      Win32OwnerParentChain = $parentChain
    }
  }
  $snapshot = @{
    action = $Action
    ownerPid = $OwnerPid
    inspectedOnly = $true
    roots = @($ownedWindows | ForEach-Object {
      @{
        processId = $_.Current.ProcessId
        className = $_.Current.ClassName
        handle = $_.Current.NativeWindowHandle
      }
    })
    controls = @($controls)
  }
  $json = ConvertTo-Json -Depth 8 -Compress -InputObject $snapshot
  $json = [Regex]::Replace($json, '(?i)[A-Z]:\\[^"\r\n]*', '<PATH_REDACTED>')
  [Console]::Out.Write($json)
  exit 0
}

if ($Action -eq 'Observe') {
  # Read-only observation reports only this test's unique fixture. It never
  # returns other window text or reads process command lines.
  $candidateProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('wmplayer.exe', 'Video.UI.exe', 'Microsoft.Media.Player.exe', 'ApplicationFrameHost.exe', 'explorer.exe')
  } | Select-Object ProcessId, Name)
  $ids = @($candidateProcesses | ForEach-Object { [int]$_.ProcessId })
  $windows = @()
  $matchedPids = @{}
  $selectedFiles = @()
  foreach ($window in $children) {
    $observedProcessId = $window.Current.ProcessId
    if ($ids -contains $observedProcessId) {
      $nodes = @($window) + @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
            $fixtureStem = [IO.Path]::GetFileNameWithoutExtension($FileName)
      $fixtureNodes = @($nodes | Where-Object { $_.Current.Name.IndexOf($fixtureStem, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
      $fixtureSelected = $false
      foreach ($node in $fixtureNodes) {
        $selectionPattern = $null
        $isSelected = $false
        if ($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) {
          $isSelected = $selectionPattern.Current.IsSelected
        }
        $fixtureSelected = $fixtureSelected -or $isSelected
        $selectedFiles += [pscustomobject]@{ pid = $observedProcessId; name = $FileName; selected = $isSelected }
      }
      if ($fixtureNodes.Count -gt 0) {
        $process = $candidateProcesses | Where-Object { [int]$_.ProcessId -eq $observedProcessId } | Select-Object -First 1
        $windows += [pscustomobject]@{ pid = $observedProcessId; processName = $process.Name; fixtureVisible = $true; fixtureSelected = $fixtureSelected }
        $matchedPids[$observedProcessId] = $true
      }
    }
  }
  $processes = @()
  foreach ($process in $candidateProcesses) {
    $processId = [int]$process.ProcessId
    if ($matchedPids.ContainsKey($processId)) {
      $processes += [pscustomobject]@{ pid = $processId; name = $process.Name; fixtureVisible = $true }
    }
  }
  $association = $null
  try { $association = (Get-ItemProperty 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mp4\UserChoice' -ErrorAction Stop).ProgId } catch {}
  if (-not $association) { try { $association = (Get-Item 'Registry::HKEY_CLASSES_ROOT\.mp4' -ErrorAction Stop).GetValue('') } catch {} }
  ConvertTo-Json -Depth 5 -Compress @{ processes = $processes; windows = $windows; selectedFiles = $selectedFiles; mp4ProgId = $association; fixtureName = $FileName }
  exit 0
}

if ($Action -eq 'ChooseFile' -or $Action -eq 'ChooseFolder') {
  if (-not $Value) { throw 'A file or folder path is required' }
  if ([XiangyingOwnedDialogs]::Choose($OwnerPid, $Value, ($Action -eq 'ChooseFolder'))) {
    ConvertTo-Json -Compress @{ action = $Action; ownerPid = $OwnerPid; path = $Value; method = 'owned-native-control' }
    exit 0
  }
  $editCandidates = @($all | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit })
  $editCandidates = @($editCandidates | Sort-Object @{ Expression = { if ($_.Current.AutomationId -eq '1148') { 0 } elseif ($_.Current.Name -match '文件名|File name') { 1 } else { 2 } } })
  $edit = $null
  $valuePattern = $null
  foreach ($candidate in $editCandidates) {
    $candidatePattern = $null
    if ($candidate.Current.IsEnabled -and $candidate.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$candidatePattern) -and -not $candidatePattern.Current.IsReadOnly) {
      $edit = $candidate
      $valuePattern = $candidatePattern
      break
    }
  }
  if (-not $edit) { throw "No writable ValuePattern path field found for $Action" }
  $valuePattern.SetValue($Value)
  Start-Sleep -Milliseconds 200
  $labels = if ($Action -eq 'ChooseFile') { @('打开', 'Open') } else { @('选择文件夹', '选择此文件夹', 'Select Folder', 'Select this folder', '确定', 'OK') }
  $button = $all | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
    $labels -contains $_.Current.Name
  } | Select-Object -First 1
  if (-not $button) { throw "No supported confirmation button found for $Action" }
  $pattern = $null
  if (-not $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    throw "Confirmation button does not support InvokePattern: $($button.Current.Name)"
  }
  $pattern.Invoke()
  Write-Output (ConvertTo-Json -Compress @{ action = $Action; ownerPid = $OwnerPid; path = $Value; button = $button.Current.Name })
  exit 0
}

if ($Action -eq 'Click') {
  if ($Names.Count -eq 0) { throw 'At least one button name is required' }
  if ([XiangyingOwnedDialogs]::Click($OwnerPid, ($Names -join '|'))) {
    ConvertTo-Json -Compress @{ action = $Action; ownerPid = $OwnerPid; method = 'owned-native-button' }
    exit 0
  }
  $button = $all | Where-Object {
    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
    $Names -contains $_.Current.Name
  } | Select-Object -First 1
  if (-not $button) { throw "No owned dialog button found among: $($Names -join ', ')" }
  $pattern = $null
  if (-not $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    throw "Button does not support InvokePattern: $($button.Current.Name)"
  }
  $pattern.Invoke()
  Write-Output (ConvertTo-Json -Compress @{ action = $Action; ownerPid = $OwnerPid; button = $button.Current.Name })
}
