output "website_url" {
  description = "Open this to use CloudKavach."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "api_url" {
  value = aws_apigatewayv2_stage.default.invoke_url
}

output "template_url" {
  value = local.template_url
}
