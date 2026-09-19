# One-time setup for deploying from GitHub Actions, applied by hand before the main stack uses it:
#   - an S3 bucket for the main stack's Terraform state
#   - GitHub's OIDC identity provider, so workflows get short-lived AWS credentials and no keys are stored
#   - a read-only role that plans, and a deploy role that only the approved "production" environment can use
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "project" {
  type    = string
  default = "cloudkavach"
}

# GitHub puts immutable IDs in the OIDC subject ("owner@id/repo@id"), so a deleted and
# re-created repository with the same name can't use these roles. IDs: api.github.com/repos/<owner>/<repo>
variable "github_repo" {
  description = "OIDC subject prefix: owner@owner_id/repo@repo_id"
  type        = string
  default     = "init-amanmishra@286840850/cloudKavach@1376784274"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform-bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  region  = var.region
  p       = var.project
  state   = "${var.project}-tfstate-${data.aws_caller_identity.current.account_id}"
}

# ---------- State bucket ----------

resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_144:Versioning already keeps every past state; a second region adds cost for a small project
  #checkov:skip=CKV_AWS_18:Only the two deploy roles write here; CloudTrail records it
  #checkov:skip=CKV2_AWS_62:Nothing needs to react to state writes
  #checkov:skip=CKV_AWS_145:Encrypted with S3 managed keys (SSE-S3)
  bucket = local.state

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled" # a bad apply can be rolled back to an earlier state
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid       = "HttpsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
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

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.id
  policy     = data.aws_iam_policy_document.state_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ---------- GitHub OIDC ----------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust_plan" {
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
    # Pull requests from this repository and pushes to main. Forks never receive an OIDC token.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:pull_request",
        "repo:${var.github_repo}:ref:refs/heads/main",
      ]
    }
  }
}

data "aws_iam_policy_document" "trust_deploy" {
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
    # Only jobs in the "production" environment, which waits for a reviewer's approval.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:environment:production"]
    }
  }
}

# ---------- What each role may touch: only this project's resources ----------

locals {
  arn = {
    buckets   = ["arn:aws:s3:::${local.p}-web-${local.account}", "arn:aws:s3:::${local.p}-templates-${local.account}"]
    objects   = ["arn:aws:s3:::${local.p}-web-${local.account}/*", "arn:aws:s3:::${local.p}-templates-${local.account}/*"]
    functions = ["arn:aws:lambda:${local.region}:${local.account}:function:${local.p}-*"]
    roles     = ["arn:aws:iam::${local.account}:role/${local.p}-api", "arn:aws:iam::${local.account}:role/${local.p}-worker"]
    table     = ["arn:aws:dynamodb:${local.region}:${local.account}:table/${local.p}"]
    apis      = ["arn:aws:apigateway:${local.region}::/apis", "arn:aws:apigateway:${local.region}::/apis/*", "arn:aws:apigateway:${local.region}::/tags/*"]
    logs = [
      "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/${local.p}-*",
      "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/apigateway/${local.p}*",
    ]
    topics  = ["arn:aws:sns:${local.region}:${local.account}:${local.p}-*"]
    alarms  = ["arn:aws:cloudwatch:${local.region}:${local.account}:alarm:${local.p}-*"]
    budgets = ["arn:aws:budgets::${local.account}:budget/${local.p}-*"]
  }
}

data "aws_iam_policy_document" "plan" {
  #checkov:skip=CKV_AWS_356:Only DescribeLogGroups and CloudFront List calls use "*", because AWS authorizes them only on "*"
  statement {
    sid       = "ReadState"
    actions   = ["s3:ListBucket", "s3:GetObject"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/${local.p}/*"]
  }
  statement {
    sid       = "ReadBuckets"
    actions   = ["s3:Get*", "s3:List*"]
    resources = concat(local.arn.buckets, local.arn.objects)
  }
  statement {
    sid       = "ReadFunctions"
    actions   = ["lambda:Get*", "lambda:List*"]
    resources = local.arn.functions
  }
  statement {
    sid       = "ReadRoles"
    actions   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole"]
    resources = local.arn.roles
  }
  # Table settings only. Reading items would expose connection secrets, so no Get/Query/Scan.
  statement {
    sid       = "ReadTableSettings"
    actions   = ["dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:DescribeContinuousBackups", "dynamodb:ListTagsOfResource"]
    resources = local.arn.table
  }
  statement {
    sid       = "ReadApi"
    actions   = ["apigateway:GET"]
    resources = local.arn.apis
  }
  statement {
    sid       = "ReadLogs" # tag calls use the log group ARN both with and without ":*"
    actions   = ["logs:ListTagsForResource", "logs:ListTagsLogGroup"]
    resources = concat(local.arn.logs, [for a in local.arn.logs : "${a}:*"])
  }
  statement {
    sid       = "ReadCloudFront"
    actions   = ["cloudfront:Get*"]
    resources = ["arn:aws:cloudfront::${local.account}:*"]
  }
  statement {
    sid       = "ReadAlarmsAndFilters"
    actions   = ["cloudwatch:DescribeAlarms", "logs:DescribeMetricFilters"]
    resources = concat(local.arn.alarms, [for a in local.arn.logs : "${a}:*"])
  }
  statement {
    sid       = "ListUnscoped" # list calls that AWS only authorizes on "*"
    actions   = ["logs:DescribeLogGroups", "cloudfront:List*"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadTopics"
    actions   = ["sns:GetTopicAttributes", "sns:GetSubscriptionAttributes", "sns:ListTagsForResource", "sns:ListSubscriptionsByTopic"]
    resources = [for a in local.arn.topics : "${a}*"]
  }
  statement {
    sid       = "ReadAlarms"
    actions   = ["cloudwatch:ListTagsForResource"]
    resources = local.arn.alarms
  }
  statement {
    sid       = "ReadBudgets"
    actions   = ["budgets:ViewBudget", "budgets:ListTagsForResource"]
    resources = local.arn.budgets
  }
}

data "aws_iam_policy_document" "deploy" {
  #checkov:skip=CKV_AWS_356:Only list calls and API log delivery use "*", because AWS authorizes them only on "*"
  #checkov:skip=CKV_AWS_111:Every write is limited to this project's resources, except API log delivery, which AWS authorizes only on "*"
  source_policy_documents = [data.aws_iam_policy_document.plan.json]

  statement {
    sid       = "WriteState"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.p}/*"]
  }
  statement {
    sid       = "ManageBuckets"
    actions   = ["s3:*"]
    resources = concat(local.arn.buckets, local.arn.objects)
  }
  statement {
    sid       = "ManageFunctions"
    actions   = ["lambda:*"]
    resources = local.arn.functions
  }
  statement {
    sid = "ManageAppRoles"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy",
    ]
    resources = local.arn.roles
  }
  statement {
    sid       = "AttachOnlyLambdaLogging"
    actions   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = local.arn.roles
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]
    }
  }
  statement {
    sid       = "PassAppRolesToLambda"
    actions   = ["iam:PassRole"]
    resources = local.arn.roles
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
  statement {
    sid = "ManageTable"
    actions = [
      "dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:DeleteTable", "dynamodb:UpdateTimeToLive",
      "dynamodb:UpdateContinuousBackups", "dynamodb:TagResource", "dynamodb:UntagResource",
    ]
    resources = local.arn.table
  }
  statement {
    sid       = "ManageApi"
    actions   = ["apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE", "apigateway:TagResource", "apigateway:UntagResource"]
    resources = local.arn.apis
  }
  statement {
    sid = "ManageLogs"
    actions = [
      "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
      "logs:TagResource", "logs:UntagResource", "logs:TagLogGroup", "logs:UntagLogGroup",
      "logs:PutMetricFilter", "logs:DeleteMetricFilter",
    ]
    resources = concat(local.arn.logs, [for a in local.arn.logs : "${a}:*"])
  }
  statement {
    sid = "ApiAccessLogging" # log delivery APIs that AWS only authorizes on "*"
    actions = [
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries",
      "logs:PutResourcePolicy", "logs:DescribeResourcePolicies",
    ]
    resources = ["*"]
  }
  statement {
    sid = "ManageCloudFront"
    actions = [
      "cloudfront:CreateDistribution", "cloudfront:CreateDistributionWithTags", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution",
      "cloudfront:TagResource", "cloudfront:UntagResource",
      "cloudfront:CreateOriginAccessControl", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl",
      "cloudfront:CreateCachePolicy", "cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy",
    ]
    resources = ["arn:aws:cloudfront::${local.account}:*"]
  }
  statement {
    sid = "ManageTopics"
    actions = [
      "sns:CreateTopic", "sns:DeleteTopic", "sns:SetTopicAttributes", "sns:TagResource", "sns:UntagResource",
      "sns:Subscribe", "sns:Unsubscribe", "sns:SetSubscriptionAttributes",
    ]
    resources = [for a in local.arn.topics : "${a}*"]
  }
  statement {
    sid       = "ManageAlarms"
    actions   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
    resources = local.arn.alarms
  }
  statement {
    sid       = "ManageBudgets"
    actions   = ["budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource"]
    resources = local.arn.budgets
  }
}

resource "aws_iam_role" "plan" {
  name                 = "${local.p}-github-plan"
  description          = "GitHub Actions: terraform plan for pull requests and main (read-only)"
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "plan" {
  name   = "plan"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan.json
}

resource "aws_iam_role" "deploy" {
  name                 = "${local.p}-github-deploy"
  description          = "GitHub Actions: terraform apply from the approved production environment"
  assume_role_policy   = data.aws_iam_policy_document.trust_deploy.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "plan_role_arn" {
  value = aws_iam_role.plan.arn
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
