resource "aws_apigatewayv2_api" "main" {
  name          = local.name
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = compact(["https://${aws_cloudfront_distribution.web.domain_name}", var.dev_origin])
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "x-kavach-key"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

locals {
  # Must match ROUTES in backend/cloudkavach/handlers.py.
  routes = [
    "POST /connections",
    "POST /connections/{cid}/verify",
    "POST /connections/{cid}/scans",
    "GET /connections/{cid}/scans/{sid}",
    "POST /connections/{cid}/explain",
    "POST /connections/{cid}/cleanup",
  ]
}

resource "aws_apigatewayv2_route" "api" {
  for_each  = toset(local.routes)
  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  # Caps request rate so a bug or abuse can't run up Lambda and Bedrock costs.
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId = "$context.requestId"
      ip        = "$context.identity.sourceIp"
      route     = "$context.routeKey"
      status    = "$context.status"
      latencyMs = "$context.responseLatency"
      error     = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
