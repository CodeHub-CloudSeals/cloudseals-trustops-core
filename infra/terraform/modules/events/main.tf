variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "max_receive_count" {
  type    = number
  default = 5
}

resource "aws_cloudwatch_event_bus" "this" {
  name = var.name
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-diagnosis-dlq"
  kms_master_key_id         = var.kms_key_arn
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "diagnosis" {
  name                       = "${var.name}-diagnosis"
  kms_master_key_id          = var.kms_key_arn
  visibility_timeout_seconds = 300
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_cloudwatch_event_rule" "submitted" {
  name           = "${var.name}-assessment-submitted"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern = jsonencode({
    source        = ["taad"]
    "detail-type" = ["taad.assessment.submitted.v1"]
  })
}

resource "aws_cloudwatch_event_target" "submitted_to_queue" {
  rule           = aws_cloudwatch_event_rule.submitted.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  arn            = aws_sqs_queue.diagnosis.arn
  dead_letter_config { arn = aws_sqs_queue.dlq.arn }
}

data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "AllowEventBridge"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.diagnosis.arn, aws_sqs_queue.dlq.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.submitted.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "diagnosis" {
  queue_url = aws_sqs_queue.diagnosis.id
  policy    = data.aws_iam_policy_document.queue.json
}

# Core hand-off events are archived for replay and audit.
resource "aws_cloudwatch_event_archive" "this" {
  name             = "${var.name}-archive"
  event_source_arn = aws_cloudwatch_event_bus.this.arn
  retention_days   = 90
}

output "bus_name" { value = aws_cloudwatch_event_bus.this.name }
output "bus_arn" { value = aws_cloudwatch_event_bus.this.arn }
output "queue_arn" { value = aws_sqs_queue.diagnosis.arn }
output "queue_url" { value = aws_sqs_queue.diagnosis.id }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
output "dlq_name" { value = aws_sqs_queue.dlq.name }
