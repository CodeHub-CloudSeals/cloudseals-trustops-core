variable "name" { type = string }
variable "alb_arn" { type = string }
variable "rate_limit" {
  type    = number
  default = 1000
}

resource "aws_wafv2_web_acl" "this" {
  name  = var.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = {
      common = { name = "AWSManagedRulesCommonRuleSet", priority = 10 }
      badin  = { name = "AWSManagedRulesKnownBadInputsRuleSet", priority = 20 }
      sqli   = { name = "AWSManagedRulesSQLiRuleSet", priority = 30 }
      ipRep  = { name = "AWSManagedRulesAmazonIpReputationList", priority = 40 }
    }
    content {
      name     = rule.value.name
      priority = rule.value.priority
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.value.name
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "rate-limit"
    priority = 5
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

output "web_acl_arn" { value = aws_wafv2_web_acl.this.arn }
