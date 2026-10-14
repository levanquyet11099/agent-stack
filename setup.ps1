# Khởi tạo lần đầu: sinh cấu hình Synapse, chạy stack, tạo tài khoản admin + bot.
# Chạy: powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "synapse-data/homeserver.yaml")) {
    New-Item -ItemType Directory -Force synapse-data | Out-Null
    docker run --rm -v "${PWD}/synapse-data:/data" `
        -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no `
        matrixdotorg/synapse:latest generate
}

docker compose up -d --build

Write-Host "Đợi Synapse sẵn sàng..."
for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-RestMethod http://localhost:8008/_matrix/client/versions | Out-Null; break }
    catch { Start-Sleep 2 }
}

# Mật khẩu ngẫu nhiên, lưu vào .env.local (không commit)
if (-not (Test-Path ".env.local")) {
    function New-Pass { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ }) }
    $adminPass = New-Pass; $botPass = New-Pass
    docker exec synapse register_new_matrix_user -u admin -p $adminPass -a -c /data/homeserver.yaml http://localhost:8008
    docker exec synapse register_new_matrix_user -u taskbot -p $botPass --no-admin -c /data/homeserver.yaml http://localhost:8008
    "MATRIX_ADMIN_USER=@admin:localhost`nMATRIX_ADMIN_PASSWORD=$adminPass`nMATRIX_BOT_USER=@taskbot:localhost`nMATRIX_BOT_PASSWORD=$botPass" |
        Out-File -Encoding utf8 .env.local
    Write-Host "Đã tạo tài khoản. Mật khẩu nằm trong .env.local"
}

docker compose ps
