"""Plain-language explanation of a finding from Amazon Bedrock, with a built-in fallback."""
import json
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from . import pricing

MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "apac.amazon.nova-lite-v1:0")
LANGUAGES = {
    "en": "simple English",
    "hinglish": "Hinglish (Hindi written in Roman letters, mixed with everyday English words)",
    "hi": "simple Hindi in Devanagari script",
}

# Shown when Bedrock is unavailable, so an explanation never comes back empty.
_BUILTIN = {
    "EC2 instance": (
        "A virtual server that is switched on. AWS bills every hour it runs, even if nothing uses it. "
        "Stopping it is safe: the disk is kept and you can start it again later, though its public IP may change."
    ),
    "NAT Gateway": (
        "A gateway that lets private servers reach the internet. It is billed every hour it exists, even with "
        "zero traffic, which makes it one of the most commonly forgotten charges. Deleting it is safe if no "
        "private server needs the internet, and you can create a new one later."
    ),
    "Idle Elastic IP": (
        "A public IP address that is reserved but attached to nothing. AWS bills every public IPv4 address. "
        "Releasing it is safe unless you need to keep this exact address."
    ),
    "Unattached EBS volume": (
        "A virtual hard disk that is not attached to any server. You pay for its storage every month. "
        "Deleting it destroys its data, so check what is on it or take a snapshot first."
    ),
    "RDS database": (
        "A managed database that is running and billed every hour. Stopping it is safe and keeps your data, "
        "but AWS starts it again automatically after 7 days."
    ),
    "EKS cluster": (
        "A Kubernetes control plane that costs about $0.10 an hour on its own, before any servers. "
        "If you are not using the cluster, delete it along with its node groups."
    ),
}
_LOAD_BALANCER = (
    "A load balancer that spreads traffic across servers. It is billed every hour it exists, even with no "
    "traffic. Delete it if nothing is being served behind it."
)

# What turning each resource off really does, so the model states facts instead of guessing.
_ACTION_FACTS = {
    "stop_instance": "Stopping keeps its disk and data; it can be started again later.",
    "release_address": "Releasing gives the IP address back to AWS; the same address may not be available again.",
    "delete_nat_gateway": "Deleting it cuts internet access for private subnets; a new one can be created later.",
    "stop_db_instance": "Stopping keeps the data; AWS starts the database again automatically after 7 days.",
}
_NO_ACTION_FACT = "Removing it may destroy data, so the owner should check it before deleting."

_client = None


def _bedrock():
    global _client
    if _client is None:
        _client = boto3.client("bedrock-runtime", region_name=os.environ.get("BEDROCK_REGION", "ap-south-1"))
    return _client


def build_prompt(finding, language):
    per_day = finding.get("usd_per_day")
    cost = f"about ₹{per_day * pricing.USD_INR:,.0f} per day" if per_day is not None else "an unknown amount"
    facts = {k: finding[k] for k in ("kind", "region", "name", "id", "details", "reasons") if finding.get(k)}
    return (
        "You explain AWS bills to Indian college students who are new to the cloud.\n"
        f"This resource is running in their account and costs {cost}:\n"
        f"{json.dumps(facts, default=str)}\n"
        f"Fact: {_ACTION_FACTS.get(finding.get('action'), _NO_ACTION_FACT)}\n\n"
        f"Reply in {LANGUAGES[language]}, in at most 3 short sentences and under 90 words:\n"
        "1. What this resource is, in words a beginner understands.\n"
        "2. Why it costs money even when they are not using it.\n"
        "3. Whether it is safe to turn off, and what they would lose.\n"
        "No markdown, no headings, no numbering."
    )


def _builtin(finding):
    if finding.get("kind", "").startswith("Load balancer"):
        return _LOAD_BALANCER
    return _BUILTIN.get(finding.get("kind"), "This resource is running and AWS bills it by the hour.")


def explain(finding, language="en"):
    if language not in LANGUAGES:
        raise ValueError(f"language must be one of: {', '.join(LANGUAGES)}")
    try:
        response = _bedrock().converse(
            modelId=MODEL_ID,
            messages=[{"role": "user", "content": [{"text": build_prompt(finding, language)}]}],
            inferenceConfig={"maxTokens": 300, "temperature": 0.3},
        )
        text = response["output"]["message"]["content"][0]["text"].strip()
        return {"text": text, "source": "bedrock"}
    except (ClientError, BotoCoreError) as exc:
        print(json.dumps({"event": "bedrock_fallback", "error": str(exc)[:200]}))
        return {"text": _builtin(finding), "source": "builtin"}
