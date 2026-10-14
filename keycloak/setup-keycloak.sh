#!/usr/bin/env bash
# Cấu hình Keycloak cho Bài 3 (tương đương mục 10.4 làm tay trên Admin Console):
#   realm geo, client synapse (confidential), user test lan.
# Chạy lại nhiều lần được: cái gì đã có thì bỏ qua.
# In ra client secret để chép vào homeserver.yaml (không commit).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash trên Windows: không tự đổi /opt/... thành C:/Program Files/Git/opt/...

KC="docker exec keycloak /opt/keycloak/bin/kcadm.sh"
REALM=geo
CLIENT_ID=synapse
REDIRECT_URI=http://localhost:8008/_synapse/client/oidc/callback
TEST_USER=${TEST_USER:-lan}
TEST_PASSWORD=${TEST_PASSWORD:?đặt TEST_PASSWORD trước khi chạy}

echo "Đợi Keycloak sẵn sàng..."
until curl -sf -o /dev/null http://localhost:8180/realms/master; do sleep 3; done

$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null

# 1. Realm geo (không dùng master cho ứng dụng)
if ! $KC get "realms/$REALM" >/dev/null 2>&1; then
  $KC create realms -s realm=$REALM -s enabled=true >/dev/null
  echo "Đã tạo realm $REALM"
fi

# 2. Client synapse: Client authentication bật, Standard flow bật, redirect URI đúng tuyệt đối
CID=$($KC get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes)
if [ -z "$CID" ]; then
  $KC create clients -r $REALM \
    -s clientId=$CLIENT_ID -s enabled=true -s protocol=openid-connect \
    -s publicClient=false -s standardFlowEnabled=true -s directAccessGrantsEnabled=false \
    -s "redirectUris=[\"$REDIRECT_URI\"]" >/dev/null
  CID=$($KC get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes)
  echo "Đã tạo client $CLIENT_ID"
fi

# 3. User test: có email, họ tên (Synapse lấy làm display name), mật khẩu không Temporary
if [ -z "$($KC get users -r $REALM -q username=$TEST_USER -q exact=true --fields id --format csv --noquotes)" ]; then
  $KC create users -r $REALM -s username=$TEST_USER -s enabled=true -s emailVerified=true \
    -s email=$TEST_USER@example.com -s firstName=Lan -s lastName=Nguyen >/dev/null
  echo "Đã tạo user $TEST_USER"
fi
$KC set-password -r $REALM --username $TEST_USER --new-password "$TEST_PASSWORD" >/dev/null

# 4. Client secret (in ra stdout để script gọi bên ngoài ghi vào homeserver.yaml)
$KC get "clients/$CID/client-secret" -r $REALM --fields value --format csv --noquotes
