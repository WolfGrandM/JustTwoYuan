$ErrorActionPreference = 'Stop'
$j = Get-Content 'D:\zotero\doc\定时科研汇报\vika.json' -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Output ("字段名: " + (($j.PSObject.Properties.Name) -join ', '))
$hdr = @{ Authorization = 'Bearer ' + $j.api_token }
try {
  $f = Invoke-RestMethod -Uri ('https://api.vika.cn/fusion/v1/datasheets/' + $j.dst_id + '/fields') -Headers $hdr
  Write-Output ("step1 读取字段: code=" + $f.code + " 字段数=" + $f.data.fields.Count)
  Write-Output ("字段列表: " + (($f.data.fields | ForEach-Object { $_.name + '(' + $_.type + ')' }) -join '、'))
  $rec = @{ fields = @{ '标题' = 'TEST-维格链路验证'; 'arxiv_id' = 'test.00001'; '一句话定位' = '维格表 API 链路测试行，验证后可删除' } }
  $body = @{ records = @($rec) } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri ('https://api.vika.cn/fusion/v1/datasheets/' + $j.dst_id + '/records') -Method Post -Headers $hdr -ContentType 'application/json; charset=utf-8' -Body $body
  Write-Output ("step2 写入记录: code=" + $r.code + " success=" + $r.success)
  if ($r.data.records) { Write-Output ("record_id: " + $r.data.records[0].recordId) }
} catch {
  Write-Output ("异常: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Output ("响应体: " + $_.ErrorDetails.Message) }
}
