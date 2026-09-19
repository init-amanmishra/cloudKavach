variable "region" {
  description = "Region for everything CloudKavach runs on. Mumbai keeps latency low for Indian users."
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Prefix for resource names."
  type        = string
  default     = "cloudkavach"
}

variable "alert_email" {
  description = "Where alarms and budget alerts go. Leave empty to skip the email subscription and the budget."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly spend (before credits) that triggers budget alerts at 50%, 80% and a forecast of 100%."
  type        = number
  default     = 80
}

variable "bedrock_model_id" {
  description = "Bedrock inference profile used for plain-language explanations."
  type        = string
  default     = "apac.amazon.nova-lite-v1:0"
}

variable "usd_inr" {
  description = "Exchange rate used to show prices in rupees."
  type        = number
  default     = 88
}

variable "dev_origin" {
  description = "Extra origin allowed by CORS so the web app can be developed locally against the live API."
  type        = string
  default     = "http://127.0.0.1:5500"
}
