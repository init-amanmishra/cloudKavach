# Users launch connect-role.yaml from their own AWS console, and CloudFormation can only read
# templates from S3, so this one object is public. Everything else in the bucket stays private.
resource "aws_s3_bucket" "templates" {
  bucket        = "${local.name}-templates-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "templates" {
  bucket                  = aws_s3_bucket.templates.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

data "aws_iam_policy_document" "templates" {
  statement {
    sid       = "PublicAccessRoleTemplate"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.templates.arn}/connect-role.yaml"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "templates" {
  bucket     = aws_s3_bucket.templates.id
  policy     = data.aws_iam_policy_document.templates.json
  depends_on = [aws_s3_bucket_public_access_block.templates]
}

resource "aws_s3_object" "connect_role" {
  bucket       = aws_s3_bucket.templates.id
  key          = "connect-role.yaml"
  source       = "${path.module}/connect-role.yaml"
  etag         = filemd5("${path.module}/connect-role.yaml")
  content_type = "text/yaml"
}

locals {
  template_url = "https://${aws_s3_bucket.templates.bucket_regional_domain_name}/connect-role.yaml"
}
