"""Decides how likely each finding is to be forgotten, and records the evidence.

A resource that exists is not automatically waste: a busy server is meant to be running.
Usage from CloudWatch, attachment state, age and whether it sits alone in its region decide
the verdict, and every verdict carries the reasons behind it.
"""
from datetime import datetime, timedelta, timezone

from botocore.exceptions import BotoCoreError, ClientError

LIKELY_FORGOTTEN = "likely_forgotten"
POSSIBLY_IDLE = "possibly_idle"
IN_USE = "in_use"
UNKNOWN = "unknown"
POTENTIAL_WASTE = (LIKELY_FORGOTTEN, POSSIBLY_IDLE)

LOOKBACK_DAYS = 7
_IDLE_CPU_PERCENT = 2.0
_IDLE_NAT_BYTES = 1_000_000  # under 1 MB in a week is effectively no traffic


def usage_query(finding):
    """The CloudWatch metric that shows whether this resource is used: (namespace, metric, dimensions, statistic)."""
    kind, resource_id = finding["kind"], finding["id"]
    if kind == "EC2 instance":
        return "AWS/EC2", "CPUUtilization", [{"Name": "InstanceId", "Value": resource_id}], "Average"
    if kind == "NAT Gateway":
        return "AWS/NATGateway", "BytesOutToDestination", [{"Name": "NatGatewayId", "Value": resource_id}], "Sum"
    if kind == "RDS database":
        return "AWS/RDS", "DatabaseConnections", [{"Name": "DBInstanceIdentifier", "Value": resource_id}], "Maximum"
    if kind.startswith("Load balancer") and ":loadbalancer/" in resource_id:
        name = resource_id.split(":loadbalancer/", 1)[1]  # "app/<name>/<id>" or "net/<name>/<id>"
        if name.startswith("app/"):
            return "AWS/ApplicationELB", "RequestCount", [{"Name": "LoadBalancer", "Value": name}], "Sum"
        if name.startswith("net/"):
            return "AWS/NetworkELB", "NewFlowCount", [{"Name": "LoadBalancer", "Value": name}], "Sum"
    return None


def fetch_usage(cloudwatch, finding, now=None):
    """The metric over the last week, or None when there is no metric, no data, or no access."""
    query = usage_query(finding)
    if not query:
        return None
    namespace, metric, dimensions, statistic = query
    end = now or datetime.now(timezone.utc)
    try:
        points = cloudwatch.get_metric_statistics(
            Namespace=namespace, MetricName=metric, Dimensions=dimensions,
            StartTime=end - timedelta(days=LOOKBACK_DAYS), EndTime=end,
            Period=86400, Statistics=[statistic],
        )["Datapoints"]
    except (ClientError, BotoCoreError):
        return None
    if not points:
        # Traffic and request counts publish nothing when there is nothing to count.
        return 0.0 if statistic == "Sum" else None
    values = [p[statistic] for p in points]
    if statistic == "Average":
        return sum(values) / len(values)
    if statistic == "Maximum":
        return max(values)
    return sum(values)


def _age_days(finding, now):
    started = (finding.get("details") or {}).get("created") or (finding.get("details") or {}).get("launched")
    if not started:
        return None
    try:
        return max(0, (now - datetime.fromisoformat(started)).days)
    except ValueError:
        return None


def _size(num_bytes):
    for unit in ("bytes", "KB", "MB", "GB"):
        if num_bytes < 1024 or unit == "GB":
            return f"{num_bytes:,.0f} {unit}" if unit == "bytes" else f"{num_bytes:,.1f} {unit}"
        num_bytes /= 1024
    return f"{num_bytes:,.1f} GB"


def classify(finding, usage, alone_in_region, now=None):
    """Returns (verdict, reasons) for one finding."""
    now = now or datetime.now(timezone.utc)
    kind = finding["kind"]
    reasons = []

    if kind == "Idle Elastic IP":
        verdict = LIKELY_FORGOTTEN
        reasons.append("Not attached to any instance or network interface")
    elif kind == "Unattached EBS volume":
        verdict = LIKELY_FORGOTTEN
        reasons.append("Not attached to any instance")
    elif usage is None:
        verdict = UNKNOWN
        if usage_query(finding):
            reasons.append("No usage data from the last 7 days")
    elif kind == "EC2 instance":
        verdict = POSSIBLY_IDLE if usage < _IDLE_CPU_PERCENT else IN_USE
        reasons.append(f"CPU averaged {usage:.1f}% over the last 7 days")
    elif kind == "NAT Gateway":
        idle = usage < _IDLE_NAT_BYTES
        verdict = LIKELY_FORGOTTEN if idle else IN_USE
        reasons.append("Almost no traffic in the last 7 days" if idle else f"Sent {_size(usage)} in the last 7 days")
    elif kind == "RDS database":
        verdict = LIKELY_FORGOTTEN if usage == 0 else IN_USE
        reasons.append("No database connections in the last 7 days" if usage == 0
                       else f"Up to {int(usage)} connections at once in the last 7 days")
    else:  # load balancers
        verdict = LIKELY_FORGOTTEN if usage == 0 else IN_USE
        reasons.append("No traffic in the last 7 days" if usage == 0 else f"{int(usage):,} requests in the last 7 days")

    age = _age_days(finding, now)
    if age is not None:
        reasons.append(f"Running for {age} days" if kind == "EC2 instance" else f"Created {age} days ago")

    # Something billing on its own in a region is the classic forgotten experiment.
    if alone_in_region:
        reasons.append(f"The only billable resource found in {finding['region']}")
        if verdict == POSSIBLY_IDLE:
            verdict = LIKELY_FORGOTTEN
        elif verdict == UNKNOWN:
            verdict = POSSIBLY_IDLE

    return verdict, reasons
