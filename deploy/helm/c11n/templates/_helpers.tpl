{{/* Common names and labels. */}}

{{- define "c11n.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "c11n.fullname" -}}
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

{{- define "c11n.selectorLabels" -}}
app.kubernetes.io/name: {{ include "c11n.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "c11n.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{ include "c11n.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: proxy
{{- end -}}

{{/*
The origin invite links are built from. Explicit publicUrl wins. Otherwise the
scheme is https, except when the deployment provably speaks plain http:
tls.mode=none AND cookie.secure=false. cookie.secure=true keeps https here even
with tls.mode=none, because TLS may be terminated in front of the cluster.
*/}}
{{- define "c11n.scheme" -}}
{{- if and (eq .Values.tls.mode "none") (not .Values.cookie.secure) -}}http{{- else -}}https{{- end -}}
{{- end -}}

{{- define "c11n.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl | trimSuffix "/" -}}
{{- else -}}
{{- printf "%s://%s" (include "c11n.scheme" .) .Values.host -}}
{{- end -}}
{{- end -}}

{{/* Secret holding the host's certificate. certManager fills <host>-tls. */}}
{{- define "c11n.tlsSecretName" -}}
{{- if eq .Values.tls.mode "existingSecret" -}}
{{- required "tls.secretName is required when tls.mode=existingSecret" .Values.tls.secretName -}}
{{- else -}}
{{- default (printf "%s-tls" .Values.host) .Values.tls.secretName -}}
{{- end -}}
{{- end -}}

{{- define "c11n.caddyImage" -}}
{{- printf "%s:%s" .Values.caddy.image.repository (default .Chart.AppVersion .Values.caddy.image.tag) -}}
{{- end -}}

{{- define "c11n.pocketbaseImage" -}}
{{- printf "%s:%s" .Values.pocketbase.image.repository (default .Chart.AppVersion .Values.pocketbase.image.tag) -}}
{{- end -}}

{{/*
The required inputs, in one place so every template fails the same way and
with the same message. helm template/lint call these from deployment.yaml; the
Ingress templates call them too so a bad set never renders a half-chart.
*/}}
{{- define "c11n.validate" -}}
{{- if not .Values.host -}}
{{- fail "c11n: host is required (the hostname reviewers use, e.g. --set host=review.example.com)" -}}
{{- end -}}
{{- if not .Values.upstream.url -}}
{{- fail "c11n: upstream.url is required (the site under review, e.g. --set upstream.url=https://staging.example.com)" -}}
{{- end -}}
{{- if not .Values.owner.email -}}
{{- fail "c11n: owner.email is required (the first owner who receives the bootstrap link, e.g. --set owner.email=you@example.com)" -}}
{{- end -}}
{{- if not (has .Values.tls.mode (list "certManager" "existingSecret" "none")) -}}
{{- fail (printf "c11n: tls.mode must be certManager, existingSecret or none (got %q)" .Values.tls.mode) -}}
{{- end -}}
{{- if eq .Values.tls.mode "certManager" -}}
{{- if not .Values.tls.issuer -}}
{{- fail "c11n: tls.issuer is required when tls.mode=certManager" -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.tls.mode "existingSecret" -}}
{{- if not .Values.tls.secretName -}}
{{- fail "c11n: tls.secretName is required when tls.mode=existingSecret" -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.upstream.tls (list "verify" "insecure")) -}}
{{- fail (printf "c11n: upstream.tls must be verify or insecure (got %q)" .Values.upstream.tls) -}}
{{- end -}}
{{- if eq .Values.upstream.tls "insecure" -}}
{{- if not (hasPrefix "https://" .Values.upstream.url) -}}
{{- fail "c11n: upstream.tls=insecure needs an https:// upstream.url (Caddy refuses to skip verification on plain http)" -}}
{{- end -}}
{{- end -}}
{{- if .Values.adminIngress.enabled -}}
{{- if not .Values.adminIngress.host -}}
{{- fail "c11n: adminIngress.host is required when adminIngress.enabled=true" -}}
{{- end -}}
{{- end -}}
{{- end -}}
