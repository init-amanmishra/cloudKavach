terraform {
  required_version = ">= 1.10" # S3 native state locking

  # Created by bootstrap/. Shared by local runs and GitHub Actions.
  backend "s3" {
    bucket       = "cloudkavach-tfstate-513386726901"
    key          = "cloudkavach/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name       = var.project
  account_id = data.aws_caller_identity.current.account_id
}
