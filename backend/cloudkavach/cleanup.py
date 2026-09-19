"""Safe cleanup. Only reversible or data-safe actions live here; everything else stays manual."""
from botocore.exceptions import ClientError

ACTIONS = ("stop_instance", "release_address", "delete_nat_gateway", "stop_db_instance")


def run(session, finding, dry_run=True):
    """Dry run by default: checks permissions without changing anything."""
    action = finding.get("action")
    if action not in ACTIONS:
        raise ValueError(f"There is no automatic action for {finding.get('kind', 'this resource')}; review it manually.")
    region, resource_id = finding["region"], finding["id"]

    if action == "stop_db_instance":
        # RDS has no dry-run flag, so a dry run here only describes what would happen.
        if dry_run:
            return _result(True, f"Would stop database {resource_id}. AWS starts it again automatically after 7 days.")
        session.client("rds", region_name=region).stop_db_instance(DBInstanceIdentifier=resource_id)
        return _result(False, f"Stopping database {resource_id}. AWS will start it again after 7 days.")

    ec2 = session.client("ec2", region_name=region)
    call, params, done = {
        "stop_instance": (
            ec2.stop_instances, {"InstanceIds": [resource_id]},
            f"Stopping instance {resource_id}. Its disk is kept, so you can start it again any time.",
        ),
        "release_address": (
            ec2.release_address, {"AllocationId": resource_id},
            f"Released Elastic IP {resource_id}.",
        ),
        "delete_nat_gateway": (
            ec2.delete_nat_gateway, {"NatGatewayId": resource_id},
            f"Deleting NAT Gateway {resource_id}. It stops billing once the deletion finishes.",
        ),
    }[action]
    try:
        call(DryRun=dry_run, **params)
    except ClientError as exc:
        # EC2 answers a permitted dry run with a "DryRunOperation" error rather than a success.
        if dry_run and exc.response["Error"]["Code"] == "DryRunOperation":
            return _result(True, f"Permission check passed for {resource_id}. Nothing was changed.")
        raise
    return _result(False, done)


def _result(dry_run, message):
    return {"dry_run": dry_run, "message": message}
