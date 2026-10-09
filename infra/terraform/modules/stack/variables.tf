variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "portal_urls" {
  type        = list(string)
  description = "Allowed OAuth callback URLs for the portal (e.g. https://taad.example.com/portal/)"
}
variable "cognito_domain_prefix" { type = string }
variable "certificate_arn" {
  type    = string
  default = null
}
variable "alarm_email" { type = string }
variable "monthly_budget_usd" {
  type    = number
  default = 300
}
variable "image_tag" {
  type    = string
  default = "latest"
}
variable "github_repository" { type = string }
variable "apply_policy_arns" {
  type    = list(string)
  default = []
}
variable "bedrock_model_id" {
  type    = string
  default = ""
}
variable "bedrock_model_arn" {
  type    = string
  default = ""
}
variable "ses_identity_arn" {
  type    = string
  default = ""
}
variable "multi_az_nat" {
  type    = bool
  default = false
}
variable "deletion_protection" {
  type    = bool
  default = false
}
variable "db_max_acu" {
  type    = number
  default = 2
}
variable "db_instance_count" {
  type    = number
  default = 1
}
variable "backup_retention_days" {
  type    = number
  default = 7
}
variable "ingress_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}
