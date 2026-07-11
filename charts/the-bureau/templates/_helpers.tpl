{{/* Base name */}}
{{- define "the-bureau.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully-qualified release name */}}
{{- define "the-bureau.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Engine resource name */}}
{{- define "the-bureau.engine.fullname" -}}
{{- printf "%s-engine" (include "the-bureau.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Chart label value */}}
{{- define "the-bureau.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels */}}
{{- define "the-bureau.labels" -}}
helm.sh/chart: {{ include "the-bureau.chart" . }}
app.kubernetes.io/name: {{ include "the-bureau.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Engine selector labels. `app: bureau-engine` is retained so the shipped
     NetworkPolicies / worker code that select on it keep matching. */}}
{{- define "the-bureau.engine.selectorLabels" -}}
app: bureau-engine
app.kubernetes.io/name: {{ include "the-bureau.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: engine
{{- end -}}

{{/* Worker namespace (empty -> release namespace) */}}
{{- define "the-bureau.workerNamespace" -}}
{{- .Values.worker.namespace | default .Release.Namespace -}}
{{- end -}}

{{/* Engine ServiceAccount name */}}
{{- define "the-bureau.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "the-bureau.engine.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* In-cluster engine Service DNS (no port) */}}
{{- define "the-bureau.engine.serviceDns" -}}
{{- printf "%s.%s.svc" (include "the-bureau.engine.fullname" .) .Release.Namespace -}}
{{- end -}}

{{/* Engine MCP URL that workers dial */}}
{{- define "the-bureau.engine.url" -}}
{{- printf "http://%s:%v/mcp" (include "the-bureau.engine.serviceDns" .) .Values.transport.port -}}
{{- end -}}

{{/* Resolve an image reference from a dict {registry, repository, tag, digest}.
     Falls back to .Chart.AppVersion when tag+digest are empty. */}}
{{- define "the-bureau.image" -}}
{{- $repo := .repository -}}
{{- $ref := "" -}}
{{- if .digest -}}
{{- $ref = printf "%s@%s" $repo .digest -}}
{{- else -}}
{{- $ref = printf "%s:%s" $repo (.tag | default .defaultTag) -}}
{{- end -}}
{{- if .registry -}}
{{- printf "%s/%s" .registry $ref -}}
{{- else -}}
{{- $ref -}}
{{- end -}}
{{- end -}}

{{/* Engine image ref */}}
{{- define "the-bureau.engine.image" -}}
{{- include "the-bureau.image" (dict "registry" .Values.image.registry "repository" .Values.image.engine.repository "tag" .Values.image.engine.tag "digest" .Values.image.engine.digest "defaultTag" .Chart.AppVersion) -}}
{{- end -}}

{{/* Worker image ref */}}
{{- define "the-bureau.worker.image" -}}
{{- include "the-bureau.image" (dict "registry" .Values.image.registry "repository" .Values.image.worker.repository "tag" .Values.image.worker.tag "digest" .Values.image.worker.digest "defaultTag" .Chart.AppVersion) -}}
{{- end -}}
