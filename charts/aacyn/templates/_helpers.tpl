{{- define "aacyn.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end -}}
