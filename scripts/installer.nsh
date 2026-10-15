; Custom NSIS hook, included via `nsis.include` in electron-builder.yml.
;
; On a real uninstall, delete the technical data folder
; (%LOCALAPPDATA%\etoolbox-daisy: browser profile, agent state, secrets,
; window state, tmp). An upgrade also runs the old uninstaller, with
; ${isUpdated} set, and must keep it so the user stays signed in.
;
; The visible folder (~\etoolbox-daisy: settings, chats, logs, user skills) is
; the user's own data and is deliberately never touched here.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\etoolbox-daisy"
  ${endIf}
!macroend
