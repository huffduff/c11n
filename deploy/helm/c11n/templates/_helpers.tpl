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
{{- end -}}

{{/*
Component-scoped selectors and labels. The two workloads are separate objects
now, so each one selects its own pods on app.kubernetes.io/component: caddy |
pocketbase. The NetworkPolicies select on the same label, which is why the
component label is on the POD template and not only on the workload.

Called with a dict: (dict "root" . "component" "caddy").
*/}}
{{- define "c11n.componentSelector" -}}
{{ include "c11n.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "c11n.componentLabels" -}}
{{ include "c11n.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Per-component placement and sizing overrides fall back to the top-level
defaults with `default`, which treats {} and [] as empty: the templates do
  {{- with (.Values.caddy.nodeSelector | default .Values.nodeSelector) }}
so an unset (or empty) component block means "use the top-level value".
*/}}

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

{{/*
Secret holding the admin host's certificate. Deliberately NOT the review host's
Secret: cert-manager writes one certificate per Secret, so two Ingresses sharing
a name overwrite each other's certificate (and the admin host ends up presenting
the review host's). Default <adminHost>-tls, overridable via adminIngress.tls.
*/}}
{{- define "c11n.adminTlsSecretName" -}}
{{- default (printf "%s-tls" .Values.adminIngress.host) .Values.adminIngress.tls.secretName -}}
{{- end -}}

{{- define "c11n.caddyImage" -}}
{{- $repo := .Values.caddy.image.repository -}}
{{- if .Values.caddy.image.digest -}}
{{- printf "%s@%s" $repo .Values.caddy.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (default .Chart.AppVersion .Values.caddy.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "c11n.pocketbaseImage" -}}
{{- $repo := .Values.pocketbase.image.repository -}}
{{- if .Values.pocketbase.image.digest -}}
{{- printf "%s@%s" $repo .Values.pocketbase.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (default .Chart.AppVersion .Values.pocketbase.image.tag) -}}
{{- end -}}
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
{{- if and (ne .Values.tls.mode "none") (eq (include "c11n.adminTlsSecretName" .) (include "c11n.tlsSecretName" .)) -}}
{{- fail (printf "c11n: the admin Ingress must not share the review host's TLS Secret (%q); set adminIngress.tls.secretName (default <adminHost>-tls)" (include "c11n.adminTlsSecretName" .)) -}}
{{- end -}}
{{- end -}}
{{/*
Credentials. The Deployment emits a secretKeyRef for each of these, so a value
that is missing here is a Pod that cannot start (CreateContainerConfigError:
"secret not found"). Fail at render time instead, naming the value.
*/}}
{{- if .Values.backup.cron -}}
{{- if not .Values.backup.s3.bucket -}}
{{- fail "c11n: backup.cron is set but backup.s3.bucket is empty (scheduled backups need a bucket; leave backup.cron empty to disable them)" -}}
{{- end -}}
{{- if not .Values.backup.s3.endpoint -}}
{{- fail "c11n: backup.cron is set but backup.s3.endpoint is empty (PocketBase refuses a blank endpoint, e.g. https://s3.eu-central-1.amazonaws.com)" -}}
{{- end -}}
{{- if not .Values.backup.s3.region -}}
{{- fail "c11n: backup.cron is set but backup.s3.region is empty (PocketBase refuses a blank region, e.g. eu-central-1)" -}}
{{- end -}}
{{- if not .Values.backup.s3.accessKey -}}
{{- fail "c11n: backup.cron is set but backup.s3.accessKey is empty (both accessKey and secretKey are required)" -}}
{{- end -}}
{{- if not .Values.backup.s3.secretKey -}}
{{- fail "c11n: backup.cron is set but backup.s3.secretKey is empty (both accessKey and secretKey are required)" -}}
{{- end -}}
{{- end -}}
{{- if .Values.smtp.enabled -}}
{{- if not .Values.smtp.host -}}
{{- fail "c11n: smtp.enabled=true needs smtp.host" -}}
{{- end -}}
{{- if and .Values.smtp.authEnabled (not .Values.smtp.password) -}}
{{- fail "c11n: smtp.enabled=true with smtp.authEnabled=true needs smtp.password (set smtp.authEnabled=false only for a trusted local mail catcher)" -}}
{{- end -}}
{{- end -}}
{{- end -}}
