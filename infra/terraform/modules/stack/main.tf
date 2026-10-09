locals {
  name = "taad-${var.env}"
}

module "kms" {
  source = "../kms"
  name   = local.name
}

module "networking" {
  source     = "../networking"
  name       = local.name
  cidr       = var.vpc_cidr
  single_nat = !var.multi_az_nat
}

module "s3" {
  source        = "../s3"
  name          = local.name
  kms_key_arn   = module.kms.key_arn
  force_destroy = var.env == "dev"
}

module "events" {
  source      = "../events"
  name        = local.name
  kms_key_arn = module.kms.key_arn
}

module "db" {
  source                = "../db"
  name                  = local.name
  vpc_id                = module.networking.vpc_id
  subnet_ids            = module.networking.private_subnet_ids
  kms_key_arn           = module.kms.key_arn
  max_acu               = var.db_max_acu
  instance_count        = var.db_instance_count
  backup_retention_days = var.backup_retention_days
  deletion_protection   = var.deletion_protection
}

module "cognito" {
  source        = "../cognito"
  name          = local.name
  callback_urls = var.portal_urls
  logout_urls   = var.portal_urls
  domain_prefix = var.cognito_domain_prefix
}

module "ecs" {
  source                = "../ecs"
  name                  = local.name
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  private_subnet_ids    = module.networking.private_subnet_ids
  kms_key_arn           = module.kms.key_arn
  image_tag             = var.image_tag
  certificate_arn       = var.certificate_arn
  db_secret_arn         = module.db.secret_arn
  bucket_arns           = module.s3.bucket_arns
  queue_arn             = module.events.queue_arn
  bus_arn               = module.events.bus_arn
  cognito_user_pool_arn = module.cognito.user_pool_arn
  bedrock_model_arn     = var.bedrock_model_arn
  ses_identity_arn      = var.ses_identity_arn
  ingress_cidrs         = var.ingress_cidrs
  # Single writer until the repository layer is normalised (see docs/AWS_DEPLOYMENT.md).
  desired_count = 1
  environment = {
    TAAD_ENV                  = var.env
    TAAD_AUTH_MODE            = "oidc"
    TAAD_OIDC_ISSUER          = module.cognito.issuer
    TAAD_OIDC_AUDIENCE        = module.cognito.client_id
    TAAD_OIDC_JWKS_URL        = module.cognito.jwks_url
    TAAD_COGNITO_USER_POOL_ID = module.cognito.user_pool_id
    TAAD_PORTAL_AUTHORIZE_URL = module.cognito.authorize_url
    TAAD_PORTAL_TOKEN_URL     = module.cognito.token_url
    TAAD_PORTAL_LOGOUT_URL    = module.cognito.logout_url
    TAAD_PORTAL_CLIENT_ID     = module.cognito.client_id
    TAAD_PORTAL_REDIRECT_URI  = var.portal_urls[0]
    TAAD_DB_HOST              = module.db.endpoint
    TAAD_DB_NAME              = "taad"
    TAAD_OBJECT_BACKEND       = "s3"
    TAAD_BUCKET_QUAR          = module.s3.quarantine_bucket
    TAAD_BUCKET_EVID          = module.s3.evidence_bucket
    TAAD_BUCKET_REPORTS       = module.s3.reports_bucket
    TAAD_EVENT_BUS            = module.events.bus_name
    TAAD_KMS_KEY_ARN          = module.kms.key_arn
    TAAD_SWASKA_MODEL         = var.bedrock_model_id == "" ? "none" : "bedrock"
    TAAD_BEDROCK_MODEL_ID     = var.bedrock_model_id
  }
}

resource "aws_security_group_rule" "db_from_service" {
  type                     = "ingress"
  security_group_id        = module.db.security_group_id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = module.ecs.service_security_group_id
  description              = "Postgres from application tasks only"
}

module "waf" {
  source  = "../waf"
  name    = local.name
  alb_arn = module.ecs.alb_arn
}

module "jobs" {
  source      = "../jobs"
  name        = local.name
  queue_arn   = module.events.queue_arn
  dlq_arn     = module.events.dlq_arn
  kms_key_arn = module.kms.key_arn
}

module "monitoring" {
  source             = "../monitoring"
  name               = local.name
  alarm_email        = var.alarm_email
  monthly_budget_usd = var.monthly_budget_usd
  alb_arn_suffix     = join("/", slice(split("/", module.ecs.alb_arn), 1, 4))
  cluster_name       = local.name
  service_name       = "api"
  dlq_name           = module.events.dlq_name
  db_cluster_id      = local.name
  kms_key_arn        = module.kms.key_arn
}

module "github_oidc" {
  source            = "../github_oidc"
  name              = local.name
  repository        = var.github_repository
  environment       = var.env
  apply_policy_arns = var.apply_policy_arns
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }
output "ecr_repository_url" { value = module.ecs.ecr_repository_url }
output "cognito_user_pool_id" { value = module.cognito.user_pool_id }
output "cognito_client_id" { value = module.cognito.client_id }
output "cognito_authorize_url" { value = module.cognito.authorize_url }
output "cognito_token_url" { value = module.cognito.token_url }
output "plan_role_arn" { value = module.github_oidc.plan_role_arn }
output "apply_role_arn" { value = module.github_oidc.apply_role_arn }
