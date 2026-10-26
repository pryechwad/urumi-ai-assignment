{{/* Namespaces */}}
{{- define "ns.store" -}}{{ .Values.namespaces.store }}{{- end -}}
{{- define "ns.mcp" -}}{{ .Values.namespaces.mcp }}{{- end -}}
{{- define "ns.platform" -}}{{ .Values.namespaces.platform }}{{- end -}}

{{- define "urumi.labels" -}}
app.kubernetes.io/part-of: urumi-platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Our own images get the optional registry prefix (e.g. ghcr.io/you). Usage: include "urumi.ownImage" (list . .Values.gateway.image) */}}
{{- define "urumi.ownImage" -}}
{{- $root := index . 0 -}}
{{- $img := index . 1 -}}
{{- if $root.Values.global.imageRegistry -}}
{{- printf "%s/%s:%s" $root.Values.global.imageRegistry $img.repository ($img.tag | toString) -}}
{{- else -}}
{{- printf "%s:%s" $img.repository ($img.tag | toString) -}}
{{- end -}}
{{- end -}}

{{/* Third-party images are used exactly as configured. */}}
{{- define "urumi.image" -}}
{{- printf "%s:%s" .repository (.tag | toString) -}}
{{- end -}}

{{/* Public base URL for a host, e.g. http://store.localtest.me:8080 */}}
{{- define "urumi.publicUrl" -}}
{{- $root := index . 0 -}}
{{- $host := index . 1 -}}
{{- $scheme := ternary "https" "http" $root.Values.ingress.tls.enabled -}}
{{- if $root.Values.ingress.publicPort -}}
{{- printf "%s://%s:%v" $scheme $host $root.Values.ingress.publicPort -}}
{{- else -}}
{{- printf "%s://%s" $scheme $host -}}
{{- end -}}
{{- end -}}

{{/*
A secret value that is:
  1. taken from values when the operator provides one,
  2. otherwise reused from the Secret already in the cluster (so upgrades keep it),
  3. otherwise generated, and memoised for this render so every template that needs the
     same value (e.g. the Woo REST key in two namespaces) gets the same one.
Usage: include "urumi.secret" (dict "root" . "id" "wooKey" "ns" "urumi-store" "secret" "store-woo-rest" "key" "consumer_key" "provided" .Values.x "gen" "ck_")
*/}}
{{- define "urumi.secret" -}}
{{- $root := .root -}}
{{- $memo := default (dict) $root.Values._generated -}}
{{- if not (hasKey $memo .id) -}}
  {{- $value := "" -}}
  {{- if .provided -}}
    {{- $value = .provided -}}
  {{- else -}}
    {{- $existing := lookup "v1" "Secret" .ns .secret -}}
    {{- if and $existing (hasKey (default (dict) $existing.data) .key) -}}
      {{- $value = index $existing.data .key | b64dec -}}
    {{- else if eq .gen "base64key" -}}
      {{- $value = randAlphaNum 32 | b64enc -}}
    {{- else -}}
      {{- $value = printf "%s%s" .gen (randAlphaNum 40) -}}
    {{- end -}}
  {{- end -}}
  {{- $_ := set $memo .id $value -}}
  {{- $_ := set $root.Values "_generated" $memo -}}
{{- end -}}
{{- index $root.Values._generated .id -}}
{{- end -}}

{{- define "secret.wooKey" -}}{{ include "urumi.secret" (dict "root" . "id" "wooKey" "ns" (include "ns.store" .) "secret" "store-woo-rest" "key" "consumer_key" "provided" .Values.secrets.wooConsumerKey "gen" "ck_") }}{{- end -}}
{{- define "secret.wooSecret" -}}{{ include "urumi.secret" (dict "root" . "id" "wooSecret" "ns" (include "ns.store" .) "secret" "store-woo-rest" "key" "consumer_secret" "provided" .Values.secrets.wooConsumerSecret "gen" "cs_") }}{{- end -}}
{{- define "secret.wooMcpToken" -}}{{ include "urumi.secret" (dict "root" . "id" "wooMcpToken" "ns" (include "ns.mcp" .) "secret" "woo-mcp" "key" "MCP_AUTH_TOKEN" "provided" "" "gen" "mcp_") }}{{- end -}}
{{- define "secret.inventoryMcpToken" -}}{{ include "urumi.secret" (dict "root" . "id" "inventoryMcpToken" "ns" (include "ns.mcp" .) "secret" "inventory-mcp" "key" "MCP_AUTH_TOKEN" "provided" "" "gen" "mcp_") }}{{- end -}}
{{- define "secret.supportMcpToken" -}}{{ include "urumi.secret" (dict "root" . "id" "supportMcpToken" "ns" (include "ns.mcp" .) "secret" "support-mcp" "key" "MCP_AUTH_TOKEN" "provided" "" "gen" "mcp_") }}{{- end -}}

{{/* Pod-level hardening shared by our own Node workloads. */}}
{{- define "urumi.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "urumi.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{- define "urumi.storageClass" -}}
{{- $sc := index . 0 -}}
{{- $root := index . 1 -}}
{{- $class := default $root.Values.global.storageClass $sc -}}
{{- if $class }}
storageClassName: {{ $class | quote }}
{{- end }}
{{- end -}}
