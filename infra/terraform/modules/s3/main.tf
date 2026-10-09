variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "force_destroy" {
  type    = bool
  default = false
}
variable "evidence_retention_days" {
  type    = number
  default = 365
}
variable "quarantine_expiry_days" {
  type    = number
  default = 7
}

locals {
  buckets = toset(["quarantine", "evidence", "reports"])
}

resource "aws_s3_bucket" "this" {
  for_each      = local.buckets
  bucket_prefix = "${var.name}-${each.key}-"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.this["quarantine"].id
  rule {
    id     = "expire-unscanned"
    status = "Enabled"
    filter {}
    expiration { days = var.quarantine_expiry_days }
    noncurrent_version_expiration { noncurrent_days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.this["evidence"].id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {}
    expiration { days = var.evidence_retention_days }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# TLS-only on every bucket.
data "aws_iam_policy_document" "tls" {
  for_each = local.buckets
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this[each.key].arn, "${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  policy   = data.aws_iam_policy_document.tls[each.key].json
}

# Quarantined objects are scanned by GuardDuty Malware Protection for S3; clean ones are copied by the scan worker.
resource "aws_iam_role" "malware" {
  name = "${var.name}-malware-protection"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "malware-protection-plan.guardduty.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "malware" {
  role = aws_iam_role.malware.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObjectTagging", "s3:GetObjectTagging", "s3:PutObjectVersionTagging"], Resource = "${aws_s3_bucket.this["quarantine"].arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = aws_s3_bucket.this["quarantine"].arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn }
    ]
  })
}

resource "aws_guardduty_malware_protection_plan" "quarantine" {
  role = aws_iam_role.malware.arn
  protected_resource {
    s3_bucket { bucket_name = aws_s3_bucket.this["quarantine"].id }
  }
  actions {
    tagging {
      status = "ENABLED"
    }
  }
}

output "quarantine_bucket" { value = aws_s3_bucket.this["quarantine"].id }
output "evidence_bucket" { value = aws_s3_bucket.this["evidence"].id }
output "reports_bucket" { value = aws_s3_bucket.this["reports"].id }
output "bucket_arns" { value = { for k, b in aws_s3_bucket.this : k => b.arn } }
