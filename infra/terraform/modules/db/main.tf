variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "kms_key_arn" { type = string }
variable "min_acu" {
  type    = number
  default = 0.5
}
variable "max_acu" {
  type    = number
  default = 2
}
variable "backup_retention_days" {
  type    = number
  default = 7
}
variable "deletion_protection" {
  type    = bool
  default = false
}
variable "instance_count" {
  type    = number
  default = 1
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name_prefix = "${var.name}-db-"
  vpc_id      = var.vpc_id
  # Ingress is added by the stack as a rule from the application security group only.
}

resource "aws_rds_cluster" "this" {
  cluster_identifier                  = var.name
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  database_name                       = "taad"
  master_username                     = "taad_admin"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.kms_key_arn
  storage_encrypted                   = true
  kms_key_id                          = var.kms_key_arn
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  backup_retention_period             = var.backup_retention_days
  preferred_backup_window             = "02:00-03:00"
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = var.deletion_protection ? "${var.name}-final" : null
  copy_tags_to_snapshot               = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  serverlessv2_scaling_configuration {
    min_capacity = var.min_acu
    max_capacity = var.max_acu
  }
}

resource "aws_rds_cluster_instance" "this" {
  count                           = var.instance_count
  identifier                      = "${var.name}-${count.index}"
  cluster_identifier              = aws_rds_cluster.this.id
  instance_class                  = "db.serverless"
  engine                          = aws_rds_cluster.this.engine
  performance_insights_enabled    = true
  performance_insights_kms_key_id = var.kms_key_arn
  auto_minor_version_upgrade      = true
}

output "endpoint" { value = aws_rds_cluster.this.endpoint }
output "secret_arn" { value = aws_rds_cluster.this.master_user_secret[0].secret_arn }
output "security_group_id" { value = aws_security_group.db.id }
