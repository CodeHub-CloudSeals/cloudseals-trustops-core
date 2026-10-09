variable "name" { type = string }
variable "callback_urls" { type = list(string) }
variable "logout_urls" { type = list(string) }
variable "domain_prefix" { type = string }

locals {
  roles = ["customer_admin", "customer_architect", "customer_risk", "customer_contributor",
  "cloudseals_admin", "cloudseals_assessor", "cloudseals_reviewer", "cloudseals_platform_ops", "auditor_readonly"]
}

resource "aws_cognito_user_pool" "this" {
  name                     = var.name
  mfa_configuration        = "ON"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "ACTIVE"

  # Invitation-only: users are created by CloudSeals/tenant admins after engagement approval.
  admin_create_user_config { allow_admin_create_user_only = true }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }
  software_token_mfa_configuration { enabled = true }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  user_pool_add_ons { advanced_security_mode = "ENFORCED" }
}

resource "aws_cognito_user_pool_client" "portal" {
  name                                 = "${var.name}-portal"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = false
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 30
  id_token_validity                    = 30
  refresh_token_validity               = 8
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_group" "roles" {
  for_each     = toset(local.roles)
  name         = each.key
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Informational only; authorisation uses server-side tenant membership."
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "user_pool_arn" { value = aws_cognito_user_pool.this.arn }
output "client_id" { value = aws_cognito_user_pool_client.portal.id }
output "issuer" { value = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${aws_cognito_user_pool.this.id}" }
output "jwks_url" { value = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/jwks.json" }
output "authorize_url" { value = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com/oauth2/authorize" }
output "token_url" { value = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com/oauth2/token" }
output "logout_url" { value = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com/logout" }

data "aws_region" "current" {}
