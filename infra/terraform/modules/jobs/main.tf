# Diagnosis pipeline scaffold: SQS (from EventBridge) -> EventBridge Pipe -> Step Functions.
# NOTE: in this release diagnosis runs inline in the API on submit. The state machine is a
# placeholder with retry/DLQ semantics so a worker task can be dropped in without re-plumbing.
variable "name" { type = string }
variable "queue_arn" { type = string }
variable "dlq_arn" { type = string }
variable "kms_key_arn" { type = string }

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/${var.name}/sfn"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_iam_role" "sfn" {
  name = "${var.name}-sfn"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "sfn" {
  role = aws_iam_role.sfn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" }
    ]
  })
}

resource "aws_sfn_state_machine" "diagnosis" {
  name     = "${var.name}-diagnosis"
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }
  definition = jsonencode({
    Comment = "Placeholder diagnosis pipeline; replace Pass with ECS RunTask worker"
    StartAt = "Acknowledge"
    States = {
      Acknowledge = { Type = "Pass", Next = "Done" }
      Done        = { Type = "Succeed" }
    }
  })
}

resource "aws_iam_role" "pipe" {
  name = "${var.name}-pipe"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "pipes.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "pipe" {
  role = aws_iam_role.pipe.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = var.queue_arn },
      { Effect = "Allow", Action = ["states:StartExecution"], Resource = aws_sfn_state_machine.diagnosis.arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn }
    ]
  })
}

resource "aws_pipes_pipe" "diagnosis" {
  name     = "${var.name}-diagnosis"
  role_arn = aws_iam_role.pipe.arn
  source   = var.queue_arn
  target   = aws_sfn_state_machine.diagnosis.arn
  source_parameters {
    sqs_queue_parameters { batch_size = 1 }
  }
  target_parameters {
    step_function_state_machine_parameters { invocation_type = "FIRE_AND_FORGET" }
  }
}

output "state_machine_arn" { value = aws_sfn_state_machine.diagnosis.arn }
