resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Crashes and timeouts: errors the code itself did not catch.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = {
    api    = aws_lambda_function.api.function_name
    worker = aws_lambda_function.worker.function_name
  }

  alarm_name          = "${each.value}-errors"
  alarm_description   = "The ${each.key} function crashed or timed out."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Errors the code catches still leave a structured log line; turn those into metrics too.
locals {
  log_events = {
    ScanFailures   = { log_group = aws_cloudwatch_log_group.worker.name, event = "scan_failed" }
    UnhandledError = { log_group = aws_cloudwatch_log_group.api.name, event = "unhandled_error" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "events" {
  for_each       = local.log_events
  name           = "${local.name}-${each.key}"
  log_group_name = each.value.log_group
  pattern        = "{ $.event = \"${each.value.event}\" }"

  metric_transformation {
    name          = each.key
    namespace     = "CloudKavach"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "events" {
  for_each = local.log_events

  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "CloudKavach logged ${each.value.event}."
  namespace           = "CloudKavach"
  metric_name         = each.key
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.events]
}

# Cost guardrail for this project's own account. Credits are excluded, so the alert
# reflects real usage instead of staying at zero while credits quietly run down.
resource "aws_budgets_budget" "monthly" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
