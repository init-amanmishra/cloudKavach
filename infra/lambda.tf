# Package only the cloudkavach module: the CLI, tests and caches stay out of the zip.
data "archive_file" "backend" {
  type        = "zip"
  output_path = "${path.module}/build/backend.zip"

  dynamic "source" {
    for_each = fileset("${path.module}/../backend/cloudkavach", "*.py")
    content {
      content  = file("${path.module}/../backend/cloudkavach/${source.value}")
      filename = "cloudkavach/${source.value}"
    }
  }
}

locals {
  # "apac.amazon.nova-lite-v1:0" -> "amazon.nova-lite-v1:0"
  bedrock_foundation_model = replace(var.bedrock_model_id, "/^(us|eu|apac|global)\\./", "")
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------- API function: answers the web app ----------

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "StartScans"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.worker.arn]
  }

  # Only roles with these exact names, which users create from our template.
  statement {
    sid     = "UseConnectedAccounts"
    actions = ["sts:AssumeRole"]
    resources = [
      "arn:aws:iam::*:role/CloudKavachAccess",
      "arn:aws:iam::*:role/CloudKavachCleanup",
    ]
  }

  statement {
    sid     = "Explain"
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${var.bedrock_model_id}",
      "arn:aws:bedrock:*::foundation-model/${local.bedrock_foundation_model}",
    ]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "cloudkavach-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  role             = aws_iam_role.api.arn
  runtime          = "python3.12"
  architectures    = ["arm64"] # Graviton: cheaper per millisecond
  handler          = "cloudkavach.handlers.api"
  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256
  memory_size      = 512
  timeout          = 29 # API Gateway gives up at 30 seconds

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.main.name
      WORKER_FUNCTION  = aws_lambda_function.worker.function_name
      TEMPLATE_URL     = local.template_url
      STACK_REGION     = var.region
      BEDROCK_MODEL_ID = var.bedrock_model_id
      BEDROCK_REGION   = var.region
      USD_INR          = tostring(var.usd_inr)
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy_attachment.api_logs]
}

# ---------- Worker function: runs the scan in the background ----------

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_logs" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "UseConnectedAccounts"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/CloudKavachAccess"]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "cloudkavach-worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name}-worker"
  retention_in_days = 14
}

resource "aws_lambda_function" "worker" {
  function_name    = "${local.name}-worker"
  role             = aws_iam_role.worker.arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "cloudkavach.handlers.worker"
  filename         = data.archive_file.backend.output_path
  source_code_hash = data.archive_file.backend.output_base64sha256
  memory_size      = 1024 # more memory also means more CPU for the parallel region checks
  timeout          = 300

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.main.name
      USD_INR    = tostring(var.usd_inr)
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker, aws_iam_role_policy_attachment.worker_logs]
}

# A failed scan is recorded as failed; retrying would only repeat the same work.
resource "aws_lambda_function_event_invoke_config" "worker" {
  function_name          = aws_lambda_function.worker.function_name
  maximum_retry_attempts = 0
}
