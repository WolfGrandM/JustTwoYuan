$ErrorActionPreference = 'Stop'
Copy-Item 'D:\QQ工作区\定时科研\05-交接手册与下一步行动.md' 'D:\zotero\doc\定时科研汇报\' -Force
Write-Output '手册已复制到 zotero 目录'
Compress-Archive -Path 'D:\QQ工作区\定时科研\*' -DestinationPath 'D:\zotero\doc\定时科研汇报\定时科研-全量交接包-20261025.zip' -Force
Write-Output 'zip 打包完成'
Get-ChildItem 'D:\zotero\doc\定时科研汇报' | Format-Table Name, Length -AutoSize
