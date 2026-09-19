"""Scans every enabled region for resources that are billing the account right now."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from . import assess, pricing

_CFG = Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=15)
_SERVICES = ("ec2", "elbv2", "rds", "eks", "cloudwatch")


def session_for(role_arn=None, external_id=None):
    """Your own credentials, or a connected account's via sts:AssumeRole with an ExternalId."""
    if not role_arn:
        return boto3.Session()
    params = {"RoleArn": role_arn, "RoleSessionName": "cloudkavach", "DurationSeconds": 900}
    if external_id:
        params["ExternalId"] = external_id
    creds = boto3.client("sts").assume_role(**params)["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )


def enabled_regions(session):
    ec2 = session.client("ec2", region_name="us-east-1", config=_CFG)
    return sorted(r["RegionName"] for r in ec2.describe_regions()["Regions"])


def _finding(kind, region, resource_id, name, usd_per_hour, estimated, details, action=None):
    known = usd_per_hour is not None
    return {
        "kind": kind,
        "region": region,
        "id": resource_id,
        "name": name,
        "usd_per_hour": usd_per_hour,
        "usd_per_day": round(usd_per_hour * 24, 2) if known else None,
        "usd_per_month": round(usd_per_hour * pricing.HOURS_PER_MONTH, 2) if known else None,
        "estimated": estimated,
        "details": details,
        "action": action,  # None = flag for a human; only reversible or data-safe actions are automated
    }


def _name(tags):
    return next((t["Value"] for t in tags or [] if t["Key"] == "Name"), None)


def _iso(value):
    return value.isoformat() if value else None


def _ec2_instances(c, region):
    pages = c["ec2"].get_paginator("describe_instances").paginate(
        Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
    )
    out = []
    for page in pages:
        for reservation in page["Reservations"]:
            for i in reservation["Instances"]:
                price, estimated = pricing.ec2_hourly(i["InstanceType"])
                out.append(_finding(
                    "EC2 instance", region, i["InstanceId"], _name(i.get("Tags")), price, estimated,
                    {"type": i["InstanceType"], "launched": _iso(i["LaunchTime"])},
                    action="stop_instance",
                ))
    return out


def _nat_gateways(c, region):
    pages = c["ec2"].get_paginator("describe_nat_gateways").paginate(
        Filter=[{"Name": "state", "Values": ["pending", "available"]}]  # this API spells it Filter
    )
    return [
        _finding("NAT Gateway", region, ng["NatGatewayId"], _name(ng.get("Tags")),
                 pricing.nat_gateway_hourly(region), False,
                 {"vpc": ng.get("VpcId"), "created": _iso(ng.get("CreateTime"))},
                 action="delete_nat_gateway")
        for page in pages for ng in page["NatGateways"]
    ]


def _idle_elastic_ips(c, region):
    return [
        _finding("Idle Elastic IP", region, a["AllocationId"], _name(a.get("Tags")),
                 pricing.PUBLIC_IPV4, False, {"ip": a["PublicIp"]}, action="release_address")
        for a in c["ec2"].describe_addresses()["Addresses"]
        if "AssociationId" not in a
    ]


def _unattached_volumes(c, region):
    pages = c["ec2"].get_paginator("describe_volumes").paginate(
        Filters=[{"Name": "status", "Values": ["available"]}]
    )
    out = []
    for page in pages:
        for v in page["Volumes"]:
            price, estimated = pricing.ebs_hourly(v["VolumeType"], v["Size"])
            # No automatic action: deleting a volume destroys its data.
            out.append(_finding(
                "Unattached EBS volume", region, v["VolumeId"], _name(v.get("Tags")), price, estimated,
                {"type": v["VolumeType"], "size_gb": v["Size"], "created": _iso(v.get("CreateTime"))},
            ))
    return out


def _load_balancers(c, region):
    return [
        _finding(f"Load balancer ({lb['Type']})", region, lb["LoadBalancerArn"], lb["LoadBalancerName"],
                 pricing.load_balancer_hourly(region), False,
                 {"dns": lb["DNSName"], "state": lb["State"]["Code"], "created": _iso(lb.get("CreatedTime"))})
        for page in c["elbv2"].get_paginator("describe_load_balancers").paginate()
        for lb in page["LoadBalancers"]
    ]


def _rds_instances(c, region):
    out = []
    for page in c["rds"].get_paginator("describe_db_instances").paginate():
        for db in page["DBInstances"]:
            if db["DBInstanceStatus"] != "available":
                continue
            multi_az = db.get("MultiAZ", False)
            price, estimated = pricing.rds_hourly(db["DBInstanceClass"], multi_az)
            out.append(_finding(
                "RDS database", region, db["DBInstanceIdentifier"], db["DBInstanceIdentifier"],
                price, estimated,
                {"class": db["DBInstanceClass"], "engine": db["Engine"], "multi_az": multi_az,
                 "created": _iso(db.get("InstanceCreateTime"))},
                # Aurora members are stopped at the cluster level, so leave those to a human.
                action=None if db.get("DBClusterIdentifier") else "stop_db_instance",
            ))
    return out


def _eks_clusters(c, region):
    return [
        _finding("EKS cluster", region, name, name, pricing.EKS_CLUSTER, False, {})
        for page in c["eks"].get_paginator("list_clusters").paginate()
        for name in page["clusters"]
    ]


_CHECKS = (
    _ec2_instances, _nat_gateways, _idle_elastic_ips, _unattached_volumes,
    _load_balancers, _rds_instances, _eks_clusters,
)


def _run_check(check, clients, region):
    try:
        return check(clients, region), None
    except (ClientError, BotoCoreError) as exc:
        # One failing check (access denied, service not in region) must not hide the rest.
        return [], {"region": region, "check": check.__name__.strip("_"), "error": str(exc)[:200]}


def scan_account(session):
    if session.get_credentials() is None:
        raise RuntimeError("No AWS credentials found. Run `aws configure` first.")
    regions = enabled_regions(session)

    # Build every client up front on one session: botocore parses each service model once and
    # shares it, and clients (unlike sessions) are safe to call from many threads at once.
    clients = {
        region: {svc: session.client(svc, region_name=region, config=_CFG) for svc in _SERVICES}
        for region in regions
    }

    findings, errors = [], []
    with ThreadPoolExecutor(max_workers=32) as pool:
        futures = [
            pool.submit(_run_check, check, clients[region], region)
            for region in regions for check in _CHECKS
        ]
        for future in as_completed(futures):
            found, error = future.result()
            findings.extend(found)
            if error:
                errors.append(error)

        # Existing isn't the same as wasted: check each finding for signs of use.
        usage = list(pool.map(lambda f: assess.fetch_usage(clients[f["region"]]["cloudwatch"], f), findings))

    per_region = Counter(f["region"] for f in findings)
    for finding, used in zip(findings, usage):
        finding["verdict"], finding["reasons"] = assess.classify(finding, used, per_region[finding["region"]] == 1)

    findings.sort(key=lambda f: f["usd_per_hour"] or 0, reverse=True)
    per_hour = sum(f["usd_per_hour"] or 0 for f in findings)
    potential = sum(f["usd_per_month"] or 0 for f in findings if f["verdict"] in assess.POTENTIAL_WASTE)
    return {
        "regions_scanned": regions,
        "findings": findings,
        "errors": errors,
        "total_usd_per_day": round(per_hour * 24, 2),
        "total_usd_per_month": round(per_hour * pricing.HOURS_PER_MONTH, 2),
        "potential_usd_per_month": round(potential, 2),
        "potential_usd_per_year": round(potential * 12, 2),
    }
