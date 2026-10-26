# Runtime-only dashboard image from a host build (apps/dashboard/dist).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY dashboard-nginx.conf /etc/nginx/conf.d/default.conf
COPY dashboard-security-headers.conf /etc/nginx/security-headers.conf
COPY dist /usr/share/nginx/html
EXPOSE 8080
