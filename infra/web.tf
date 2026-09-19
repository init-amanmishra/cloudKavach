# The web app: a private S3 bucket that only CloudFront can read.
resource "aws_s3_bucket" "web" {
  #checkov:skip=CKV_AWS_145:Encrypted with S3 managed keys (SSE-S3)
  #checkov:skip=CKV_AWS_21:Contents are rebuilt from git on every deploy
  #checkov:skip=CKV_AWS_144:Contents are rebuilt from git on every deploy
  #checkov:skip=CKV_AWS_18:Only Terraform writes here; CloudTrail already records it
  #checkov:skip=CKV2_AWS_61:Contents are managed by Terraform, nothing piles up
  #checkov:skip=CKV2_AWS_62:Nothing needs to react to uploads
  bucket        = "${local.name}-web-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Short TTL: new deploys show up within a minute without cache invalidations.
resource "aws_cloudfront_cache_policy" "web" {
  name        = "${local.name}-short-cache"
  default_ttl = 60
  max_ttl     = 300
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "web" {
  #checkov:skip=CKV_AWS_174:The default *.cloudfront.net certificate can't set a minimum TLS version; needs a custom domain
  #checkov:skip=CKV2_AWS_42:No custom domain yet
  #checkov:skip=CKV_AWS_68:WAF costs more than this app's whole bill; the site is static and the API is throttled
  #checkov:skip=CKV2_AWS_47:No WAF, see CKV_AWS_68
  #checkov:skip=CKV_AWS_86:Static public site; API Gateway access logs record the requests that matter
  #checkov:skip=CKV_AWS_310:Single static origin, S3 is already highly available
  #checkov:skip=CKV_AWS_374:Open to users everywhere on purpose
  enabled             = true
  comment             = "CloudKavach web app"
  default_root_object = "index.html"
  price_class         = "PriceClass_200" # includes edge locations in India

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.web.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "web_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json
}

locals {
  web_dir   = "${path.module}/../frontend"
  web_files = setsubtract(fileset(local.web_dir, "**"), ["config.js"])
  content_types = {
    html = "text/html; charset=utf-8"
    css  = "text/css; charset=utf-8"
    js   = "application/javascript; charset=utf-8"
    svg  = "image/svg+xml"
    png  = "image/png"
    ico  = "image/x-icon"
    json = "application/json"
  }
}

resource "aws_s3_object" "web" {
  for_each     = local.web_files
  bucket       = aws_s3_bucket.web.id
  key          = each.value
  source       = "${local.web_dir}/${each.value}"
  etag         = filemd5("${local.web_dir}/${each.value}")
  content_type = lookup(local.content_types, reverse(split(".", each.value))[0], "application/octet-stream")
}

# Generated here so the web app always points at this deployment's API.
resource "aws_s3_object" "config" {
  bucket       = aws_s3_bucket.web.id
  key          = "config.js"
  content      = "window.KAVACH_CONFIG = ${jsonencode({ apiUrl = aws_apigatewayv2_stage.default.invoke_url, usdInr = var.usd_inr })};\n"
  content_type = "application/javascript; charset=utf-8"
}
