Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set http = CreateObject("MSXML2.XMLHTTP")

' schon laufend? dann nichts tun
On Error Resume Next
http.open "GET", "http://localhost:3055/health", False
http.send
already = (Err.Number = 0 And http.Status = 200)

If already Then
  WScript.Quit
End If

On Error GoTo 0
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node server.js", 0, False
