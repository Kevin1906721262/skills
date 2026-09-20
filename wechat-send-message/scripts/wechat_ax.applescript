-- WeChat (Mac) accessibility helper for UI scripting.
-- Usage: osascript wechat_ax.applescript <command> [args...]
--   probe                 -> window geometry + every AXTextArea (name/value/rect)
--   dump <ax-name>        -> "<name>\t<value>" of the AXTextArea with that name, or ERR ...
--   focus-paste <name> <text> -> focus that AXTextArea, clear it, paste <text> from the clipboard
--   enter                 -> press Return in WeChat
--   enter-cmd             -> press Cmd+Return in WeChat
--   esc                   -> press Escape in WeChat
--
-- WeChat names the search text area "搜索" and the message box after the open chat's title,
-- so both can be found and the draft can be verified from the accessibility tree alone.
-- Note: the whole handler body must sit inside `tell application "System Events"` — outside it,
-- the parser does not know the `UI elements` term and rejects the script.

on run argv
  set cmd to item 1 of argv
  if cmd is "probe" then
    return my cmdProbe()
  else if cmd is "dump" then
    return my cmdDump(item 2 of argv)
  else if cmd is "focus-paste" then
    return my cmdFocusPaste(item 2 of argv, item 3 of argv)
  else if cmd is "enter" then
    return my cmdKey(36, false)
  else if cmd is "enter-cmd" then
    return my cmdKey(36, true)
  else if cmd is "esc" then
    return my cmdKey(53, false)
  end if
  return "ERR unknown-command"
end run

on cmdProbe()
  tell application "System Events"
    tell process "WeChat"
      set out to "windows=" & (count of windows) & linefeed
      if (count of windows) is 0 then return out
      set w to window 1
      set out to out & "window: title=" & (name of w) & " pos=" & (position of w as string) & ¬
        " size=" & (size of w as string) & linefeed
      return my dumpTAs(w, 1, out)
    end tell
  end tell
end cmdProbe

on cmdDump(wanted)
  tell application "System Events"
    tell process "WeChat"
      if (count of windows) is 0 then return "ERR no-window"
      set ta to my findTA(window 1, wanted, 1)
      if ta is missing value then return "ERR not-found"
      set nm to ""
      set vl to ""
      try
        set nm to (name of ta as string)
      end try
      try
        set vl to (value of ta as string)
      end try
      return nm & tab & vl
    end tell
  end tell
end cmdDump

on cmdFocusPaste(wanted, txt)
  tell application "System Events"
    tell process "WeChat"
      set frontmost to true
      delay 0.3
      if (count of windows) is 0 then return "ERR no-window"
      set ta to my findTA(window 1, wanted, 1)
      if ta is missing value then return "ERR not-found"
      set the clipboard to txt
      set focused of ta to true
      delay 0.35
      keystroke "a" using command down
      delay 0.15
      key code 51
      delay 0.2
      -- keystroke mangles CJK into ASCII keycodes, so always paste instead of typing.
      keystroke "v" using command down
      return "OK"
    end tell
  end tell
end cmdFocusPaste

on cmdKey(code, withCommand)
  tell application "System Events"
    tell process "WeChat"
      set frontmost to true
      delay 0.2
      if withCommand then
        key code code using command down
      else
        key code code
      end if
    end tell
  end tell
  return "OK"
end cmdKey

on findTA(e, wanted, depth)
  if depth > 12 then return missing value
  tell application "System Events"
    try
      if (role of e) is "AXTextArea" then
        try
          if (name of e) is wanted then return e
        end try
      end if
    end try
    set k to 0
    try
      set k to count of UI elements of e
    on error
      return missing value
    end try
    repeat with i from 1 to k
      try
        set res to my findTA(UI element i of e, wanted, depth + 1)
        if res is not missing value then return res
      end try
    end repeat
  end tell
  return missing value
end findTA

on dumpTAs(e, depth, out)
  if depth > 12 then return out
  tell application "System Events"
    try
      if (role of e) is "AXTextArea" then
        set nm to ""
        set vl to ""
        try
          set nm to (name of e as string)
        end try
        try
          set vl to (value of e as string)
        end try
        set out to out & "text area: name=[" & nm & "] value=[" & vl & "] pos=" & ¬
          (position of e as string) & " size=" & (size of e as string) & linefeed
      end if
    end try
    set k to 0
    try
      set k to count of UI elements of e
    on error
      return out
    end try
    repeat with i from 1 to k
      try
        set out to my dumpTAs(UI element i of e, depth + 1, out)
      end try
    end repeat
  end tell
  return out
end dumpTAs
