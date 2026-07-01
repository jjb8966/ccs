# nginx

`ccs-proxy.conf`를 DuckDNS 서버 블록에 include 하세요. 외부 경로는 `/ccs/` → `ccs:8317` 입니다.

```nginx
include /path/to/ccs/deploy/nginx/ccs-proxy.conf;
```

`run-dev.sh`가 `ccs`를 `nginx-network`에 연결하고 `docker exec nginx nginx -s reload`를 시도합니다.
