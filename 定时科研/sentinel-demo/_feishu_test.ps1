$ErrorActionPreference = 'Stop'
$j = Get-Content 'D:\zotero\doc\定时科研汇报\feishu.json' -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Output ("字段名: " + (($j.PSObject.Properties.Name) -join ', '))
Write-Output ("app_id   : " + $j.app_id)
Write-Output ("app_token: " + $j.app_token)
Write-Output ("table_id : " + $j.table_id)
$sec = [string]$j.app_secret
Write-Output ("app_secret: 存在, 长度 " + $sec.Length)

try {
  $t = Invoke-RestMethod -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' -Method Post -ContentType 'application/json' -Body (@{app_id=$j.app_id; app_secret=$j.app_secret} | ConvertTo-Json)
  Write-Output ("step1 获取token: code=" + $t.code + " expire=" + $t.expire)
  if ($t.code -ne 0) { Write-Output ("step1 msg: " + $t.msg); exit }
  $hdr = @{ Authorization = 'Bearer ' + $t.tenant_access_token }
  $fields = @{ '标题' = 'TEST-直连验证(ZCode侧)'; '相关分' = 9.0; '类型' = '最新'; '进过日报' = '是' }
  $body = @{ fields = $fields } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri ('https://open.feishu.cn/open-apis/bitable/v1/apps/' + $j.app_token + '/tables/' + $j.table_id + '/records') -Method Post -Headers $hdr -ContentType 'application/json; charset=utf-8' -Body $body
  Write-Output ("step2 写入记录: code=" + $r.code + " msg=" + $r.msg)
  if ($r.code -eq 0 -and $r.data.record) { Write-Output ("record_id: " + $r.data.record.record_id) }
} catch {
  Write-Output ("异常: " + $_.Exception.Message)
  if ($_.ErrorDetails.Message) { Write-Output ("响应体: " + $_.ErrorDetails.Message) }
}
