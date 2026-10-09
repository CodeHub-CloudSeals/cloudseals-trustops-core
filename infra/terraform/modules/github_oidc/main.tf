variable "name" { type = string }
variable "repository" {
  type        = string
  description = "org/repo allowed to assume the roles"
}
variable "environment" { type = string }
variable "apply_policy_arns" {
  type        = list(string)
  default     = []
  description = "Policies for the apply role; keep narrower than AdministratorAccess and add a permission boundary."
}
variable "permissions_boundary_arn" {
  type    = string
  default = null
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:pull_request", "repo:${var.repository}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "apply" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only a GitHub Environment with required reviewers can apply.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "${var.name}-gha-plan"
  assume_role_policy   = data.aws_iam_policy_document.plan.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "plan_ro" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role" "apply" {
  name                 = "${var.name}-gha-apply"
  assume_role_policy   = data.aws_iam_policy_document.apply.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "apply" {
  for_each   = toset(var.apply_policy_arns)
  role       = aws_iam_role.apply.name
  policy_arn = each.value
}

output "plan_role_arn" { value = aws_iam_role.plan.arn }
output "apply_role_arn" { value = aws_iam_role.apply.arn }
