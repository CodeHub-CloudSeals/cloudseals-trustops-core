terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Remote state: create the bucket/table out of band, then `terraform init -backend-config=backend.hcl`.
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "cloudseals-taad", Environment = "prod", ManagedBy = "terraform" }
  }
}

variable "region" {
  type    = string
  default = "eu-west-2"
}
variable "portal_urls" { type = list(string) }
variable "cognito_domain_prefix" { type = string }
variable "certificate_arn" {
  type    = string
  default = null
}
variable "alarm_email" { type = string }
variable "github_repository" { type = string }
variable "image_tag" {
  type    = string
  default = "latest"
}
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
variable "ingress_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

module "taad" {
  source                = "../../modules/stack"
  env                   = "prod"
  portal_urls           = var.portal_urls
  cognito_domain_prefix = var.cognito_domain_prefix
  certificate_arn       = var.certificate_arn
  alarm_email           = var.alarm_email
  github_repository     = var.github_repository
  image_tag             = var.image_tag
  apply_policy_arns     = var.apply_policy_arns
  bedrock_model_id      = var.bedrock_model_id
  bedrock_model_arn     = var.bedrock_model_arn
  ses_identity_arn      = var.ses_identity_arn
  ingress_cidrs         = var.ingress_cidrs
  deletion_protection   = true
  multi_az_nat          = true
  db_max_acu            = 8
  db_instance_count     = 2
  backup_retention_days = 35
}

output "alb_dns_name" { value = module.taad.alb_dns_name }
output "ecr_repository_url" { value = module.taad.ecr_repository_url }
output "cognito_client_id" { value = module.taad.cognito_client_id }
output "plan_role_arn" { value = module.taad.plan_role_arn }
output "apply_role_arn" { value = module.taad.apply_role_arn }
