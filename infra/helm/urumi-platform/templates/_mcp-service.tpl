{{/*
One upstream MCP server: Service (ClusterIP only, never exposed by an Ingress) + Deployment,
and optionally a PVC for its SQLite data.
Args: dict "root" . "name" "inventory-mcp" "port" 3102 "cfg" .Values.mcp.inventory "env" (list ...)
*/}}
{{- define "urumi.mcpService" -}}
{{- $root := .root -}}
{{- $cfg := .cfg -}}
{{- $ns := include "ns.mcp" $root -}}
{{- if $cfg.persistence }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ .name }}-data
  namespace: {{ $ns }}
  labels: {{- include "urumi.labels" $root | nindent 4 }}
spec:
  accessModes: ["ReadWriteOnce"]
  {{- include "urumi.storageClass" (list $cfg.persistence.storageClass $root) | nindent 2 }}
  resources:
    requests:
      storage: {{ $cfg.persistence.size }}
---
{{- end }}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  namespace: {{ $ns }}
  labels: {{- include "urumi.labels" $root | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: {{ .name }}
  ports:
    - name: mcp
      port: {{ .port }}
      targetPort: mcp
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  namespace: {{ $ns }}
  labels: {{- include "urumi.labels" $root | nindent 4 }}
spec:
  replicas: 1
  {{- if $cfg.persistence }}
  strategy:
    type: Recreate # SQLite file on a ReadWriteOnce volume: one writer at a time
  {{- end }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .name }}
  template:
    metadata:
      labels:
        {{- include "urumi.labels" $root | nindent 8 }}
        app.kubernetes.io/name: {{ .name }}
        app.kubernetes.io/component: mcp-upstream
      annotations:
        checksum/secret: {{ include (print $root.Template.BasePath "/secrets.yaml") $root | sha256sum | trunc 16 }}
    spec:
      automountServiceAccountToken: false
      {{- include "urumi.podSecurity" $root | nindent 6 }}
      terminationGracePeriodSeconds: 15
      containers:
        - name: server
          image: {{ include "urumi.ownImage" (list $root $cfg.image) }}
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          ports:
            - name: mcp
              containerPort: {{ .port }}
          env:
            - name: PORT
              value: {{ .port | quote }}
            - name: MCP_AUTH_TOKEN
              valueFrom: { secretKeyRef: { name: {{ .name }}, key: MCP_AUTH_TOKEN } }
            {{- if $cfg.persistence }}
            - name: DATA_DIR
              value: /data
            {{- end }}
            {{- with .env }}{{ toYaml . | nindent 12 }}{{- end }}
          startupProbe:
            httpGet: { path: /healthz, port: mcp }
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 36
          readinessProbe:
            httpGet: { path: /readyz, port: mcp }
            periodSeconds: 5
            timeoutSeconds: 3
          livenessProbe:
            httpGet: { path: /healthz, port: mcp }
            initialDelaySeconds: 5
            periodSeconds: 15
            timeoutSeconds: 3
            failureThreshold: 4
          resources: {{- toYaml $cfg.resources | nindent 12 }}
          {{- include "urumi.containerSecurity" $root | nindent 10 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            {{- if $cfg.persistence }}
            - name: data
              mountPath: /data
            {{- end }}
      volumes:
        - name: tmp
          emptyDir: {}
        {{- if $cfg.persistence }}
        - name: data
          persistentVolumeClaim:
            claimName: {{ .name }}-data
        {{- end }}
{{- end -}}
