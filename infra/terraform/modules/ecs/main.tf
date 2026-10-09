variable "name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "kms_key_arn" { type = string }
variable "image_tag" {
  type    = string
  default = "latest"
}
variable "certificate_arn" {
  type    = string
  default = null
}
variable "desired_count" {
  type    = number
  default = 1
}
variable "cpu" {
  type    = number
  default = 512
}
variable "memory" {
  type    = number
  default = 1024
}
variable "environment" { type = map(string) }
variable "db_secret_arn" { type = string }
variable "bucket_arns" { type = map(string) }
variable "queue_arn" { type = string }
variable "bus_arn" { type = string }
variable "cognito_user_pool_arn" { type = string }
variable "bedrock_model_arn" {
  type    = string
  default = ""
}
variable "ses_identity_arn" {
  type    = string
  default = ""
}
variable "log_retention_days" {
  type    = number
  default = 30
}
variable "ingress_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${var.name}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.db_secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn }
    ]
  })
}

# Task role: least privilege. No IAM, no wildcards on resources, no cross-account, no execution of customer actions.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "QuarantineWriteOnly"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${var.bucket_arns["quarantine"]}/*"]
  }
  statement {
    sid       = "EvidenceAndReports"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.bucket_arns["evidence"]}/*", "${var.bucket_arns["reports"]}/*"]
  }
  statement {
    sid       = "ListOwnBuckets"
    actions   = ["s3:ListBucket"]
    resources = values(var.bucket_arns)
  }
  statement {
    sid       = "Queue"
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [var.queue_arn]
  }
  statement {
    sid       = "Events"
    actions   = ["events:PutEvents"]
    resources = [var.bus_arn]
  }
  statement {
    sid       = "VerifyBootstrapIdentity"
    actions   = ["cognito-idp:AdminGetUser"]
    resources = [var.cognito_user_pool_arn]
  }
  statement {
    sid       = "Kms"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
  dynamic "statement" {
    for_each = var.bedrock_model_arn == "" ? [] : [1]
    content {
      sid       = "SwaskaModelInvokeOnly"
      actions   = ["bedrock:InvokeModel", "bedrock:Converse"]
      resources = [var.bedrock_model_arn]
    }
  }
  dynamic "statement" {
    for_each = var.ses_identity_arn == "" ? [] : [1]
    content {
      sid       = "SendInvitations"
      actions   = ["ses:SendEmail"]
      resources = [var.ses_identity_arn]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidrs
  }
  dynamic "ingress" {
    for_each = var.certificate_arn == null ? [1] : []
    content {
      description = "HTTP (dev only, no certificate configured)"
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = var.ingress_cidrs
    }
  }
}

resource "aws_security_group" "service" {
  name_prefix = "${var.name}-svc-"
  vpc_id      = var.vpc_id
  ingress {
    description     = "From load balancer only"
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "AWS APIs, Cognito JWKS, database"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "alb_to_service" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  from_port                = 8000
  to_port                  = 8000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.service.id
}

resource "aws_lb" "this" {
  name                       = substr(var.name, 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "api" {
  name_prefix = "taad-"
  port        = 8000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path    = "/health"
    matcher = "200"
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn == null ? 0 : 1
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = var.certificate_arn == null ? "forward" : "redirect"
    target_group_arn = var.certificate_arn == null ? aws_lb_target_group.api.arn : null
    dynamic "redirect" {
      for_each = var.certificate_arn == null ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = "api"
    image                  = "${aws_ecr_repository.this.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 8000, protocol = "tcp" }]
    environment            = [for k, v in var.environment : { name = k, value = v }]
    secrets = [
      { name = "TAAD_DB_USER", valueFrom = "${var.db_secret_arn}:username::" },
      { name = "TAAD_DB_PASSWORD", valueFrom = "${var.db_secret_arn}:password::" }
    ]
    linuxParameters = { initProcessEnabled = true }
    mountPoints     = []
    healthCheck = {
      command  = ["CMD-SHELL", "python -c \"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')\""]
      interval = 30
      timeout  = 5
      retries  = 3
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.api.name, "awslogs-region" = data.aws_region.current.region, "awslogs-stream-prefix" = "api" }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }
  # Single-writer persistence: stop the old task before starting the new one (brief downtime on deploy).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.http]
}

output "alb_arn" { value = aws_lb.this.arn }
output "alb_dns_name" { value = aws_lb.this.dns_name }
output "ecr_repository_url" { value = aws_ecr_repository.this.repository_url }
output "cluster_arn" { value = aws_ecs_cluster.this.arn }
output "service_security_group_id" { value = aws_security_group.service.id }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "task_definition_arn" { value = aws_ecs_task_definition.api.arn }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "log_group_name" { value = aws_cloudwatch_log_group.api.name }
